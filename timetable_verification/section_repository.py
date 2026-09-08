"""Document capture and independent section staging; never publishes trips."""
import json

import psycopg2.extras

from . import GABS_IMPORT_VERSION
from .canonical import content_sha256, sha256_bytes
from .diff import compare_extractions
from .sections import review_summary


def stage_sections(cursor, source_id, document_id, document):
    outcomes = {'changed': 0, 'unchanged': 0, 'failed': len(document['issues'])}
    seen = []
    for section in document['sections']:
        number = section['timetable_number']
        seen.append(number)
        cursor.execute('''INSERT INTO timetable_sections(source_id,timetable_number)
            VALUES (%s,%s) ON CONFLICT(source_id,timetable_number) DO UPDATE
            SET updated_at=now() RETURNING *''', (source_id, number))
        row = cursor.fetchone()
        section_id = row['id']
        cursor.execute('SELECT * FROM timetable_section_versions WHERE id = ANY(%s::bigint[])',
                       ([v for v in [row['approved_version_id'], row['pending_version_id']] if v],))
        versions = {v['id']: v for v in cursor.fetchall()}
        baseline = versions.get(row['approved_version_id'])
        pending = versions.get(row['pending_version_id'])
        extraction, error = section.get('extraction'), section.get('error')
        digest = content_sha256(extraction) if extraction else sha256_bytes(error.encode())
        equivalent = next((v for v in [pending, baseline] if v and v['content_sha256'] == digest), None)
        # Reappearance after an explicit withdrawal requires a fresh review.
        if row['status'] == 'withdrawn' or (row['audit_review_required'] and not pending):
            equivalent = None
        if equivalent:
            version_id = equivalent['id']
            outcome = 'unchanged'
            if baseline and equivalent['id'] == baseline['id']:
                if pending:
                    cursor.execute("UPDATE timetable_section_versions SET review_status='superseded' WHERE id=%s", (pending['id'],))
                cursor.execute("UPDATE timetable_sections SET pending_version_id=NULL,status=CASE WHEN audit_review_required THEN 'changed_review_required' ELSE 'verified' END WHERE id=%s", (section_id,))
        else:
            comparison = compare_extractions(baseline['extraction'] if baseline else None, extraction) if extraction else {'has_changes': True, 'parse_error': error}
            if baseline and extraction and baseline['content_sha256'] != digest:
                comparison['has_changes'] = True
            if pending:
                cursor.execute("UPDATE timetable_section_versions SET review_status='superseded' WHERE id=%s", (pending['id'],))
            cursor.execute('''INSERT INTO timetable_section_versions(section_id,document_version_id,
                previous_version_id,content_sha256,extraction,parse_error,source_pages,comparison,review_summary)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                RETURNING id''', (section_id, document_id, row['approved_version_id'], digest,
                    psycopg2.extras.Json(extraction) if extraction else None, error, section['pages'],
                    psycopg2.extras.Json(comparison), psycopg2.extras.Json(review_summary(extraction))))
            version_id = cursor.fetchone()['id']
            cursor.execute("UPDATE timetable_sections SET pending_version_id=%s,status='changed_review_required' WHERE id=%s", (version_id, section_id))
            outcome = 'changed'
        cursor.execute('''INSERT INTO timetable_section_observations(section_version_id,document_version_id,source_pages)
            VALUES (%s,%s,%s) ON CONFLICT DO NOTHING''', (version_id, document_id, section['pages']))
        cursor.execute('''UPDATE timetable_sections SET last_seen_document_version_id=%s,
            missing_from_document=false,updated_at=now() WHERE id=%s''', (document_id, section_id))
        outcomes[outcome] += 1
        if error:
            outcomes['failed'] += 1
    # Absence is review evidence only. Never infer it from partial or failed parsing.
    if document['complete']:
        cursor.execute('''UPDATE timetable_sections SET missing_from_document=true,
            status=CASE WHEN status='withdrawn' THEN status ELSE 'changed_review_required' END
            WHERE source_id=%s AND NOT(timetable_number=ANY(%s::text[]))''', (source_id, seen))
    return outcomes


def stage_document(repository, *, run_id, source, source_id, pdf_bytes, pdf_sha256,
                   document, http_etag, http_last_modified, parser_version, downloaded_at=None):
    digest = sha256_bytes(json.dumps(document, sort_keys=True).encode())
    with repository.connection:
        with repository.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext('fika:timetable-publication'))")
            cursor.execute('SELECT * FROM timetable_sources WHERE id=%s FOR UPDATE', (source_id,))
            parent = cursor.fetchone()
            if not parent['section_mode']:
                raise ValueError('GABS section migration must complete before section staging')
            valid = [s['extraction'] for s in document['sections'] if s.get('extraction')]
            names = [r['name'] for e in valid for r in e['routes'] if r['code'] == source.source_key[:4]]
            route_name = parent['route_name'] or next(iter(names), source.route_name_hint)
            directions = [d['name'] for e in valid for r in e['routes'] for d in r['directions']] or parent['direction_names']
            coverage = sorted({day for e in valid for r in e['routes'] for d in r['directions'] for s in d['services'] for day in s['service_days']}) or parent['service_day_coverage']
            effective_date = max((e['effective_date'] for e in valid if e['effective_date']), default=parent['source_effective_date'])
            cursor.execute('''INSERT INTO timetable_source_versions(source_id,previous_version_id,
                pdf_sha256,content_sha256,source_url,parser_version,import_version,extraction,
                pdf_bytes,pdf_size_bytes,http_etag,http_last_modified,document_issues,
                first_downloaded_at,last_downloaded_at,route_name,direction_names,service_day_coverage,source_effective_date)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,COALESCE(%s::timestamptz,now()),COALESCE(%s::timestamptz,now()),%s,%s,%s,%s)
                ON CONFLICT(source_id,pdf_sha256,parser_version,import_version) DO UPDATE
                SET last_downloaded_at=GREATEST(timetable_source_versions.last_downloaded_at,EXCLUDED.last_downloaded_at) RETURNING id''', (source_id,parent['approved_version_id'],
                pdf_sha256,digest,source.url,parser_version,GABS_IMPORT_VERSION,
                psycopg2.extras.Json(document),psycopg2.Binary(pdf_bytes),len(pdf_bytes),http_etag,http_last_modified,
                psycopg2.extras.Json(document['issues']),downloaded_at,downloaded_at,route_name,directions,coverage,effective_date))
            document_id = cursor.fetchone()['id']
            outcomes = stage_sections(cursor, source_id, document_id, document)
            cursor.execute('''UPDATE timetable_sources SET current_pdf_sha256=%s,current_content_sha256=%s,
                last_downloaded_at=COALESCE(%s::timestamptz,now()),parser_version=%s,import_version=%s,pending_version_id=%s,
                route_name=%s,direction_names=%s,service_day_coverage=%s,source_effective_date=%s,
                status=CASE WHEN EXISTS(SELECT 1 FROM timetable_sections WHERE source_id=%s AND status='changed_review_required')
                  OR %s THEN 'changed_review_required' ELSE 'verified' END,updated_at=now() WHERE id=%s''',
                (pdf_sha256,digest,downloaded_at,parser_version,GABS_IMPORT_VERSION,document_id,route_name,directions,coverage,effective_date,source_id,bool(outcomes['failed']),source_id))
            cursor.execute('''INSERT INTO timetable_source_events(source_id,source_version_id,check_run_id,event_type,details)
                VALUES (%s,%s,%s,'document_sections_checked',%s)''',
                (source_id,document_id,run_id,psycopg2.extras.Json(outcomes)))
            return {'version_id': document_id, 'outcome': 'changed' if outcomes['changed'] else 'unchanged', **outcomes}
