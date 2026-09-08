"""Reparse captured GABS PDFs without downloading or publishing timetables."""
import argparse
import json
import os

import psycopg2.extras

from .adapters import DiscoveredSource, GabsAdapter
from .repository import TimetableRepository


def reparse_captured(repository, source_key=None):
    adapter = GabsAdapter()
    repository.migrate_gabs_sections()
    with repository.connection:
        with repository.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
            cursor.execute('''SELECT sources.id AS source_id,sources.source_key,versions.*
                FROM timetable_sources sources
                JOIN LATERAL (SELECT * FROM timetable_source_versions v WHERE v.source_id=sources.id
                  ORDER BY v.last_downloaded_at DESC,v.id DESC LIMIT 1) versions ON true
                WHERE sources.operator='GABS' AND (%s IS NULL OR sources.source_key=%s)
                ORDER BY sources.id''', (source_key,source_key))
            documents = list(cursor.fetchall())
    results = []
    for captured in documents:
        source = DiscoveredSource('GABS',captured['source_key'],captured['source_url'])
        data = bytes(captured['pdf_bytes'])
        try:
            document = adapter.parse_document(source,data)
        except Exception as exc:
            document = {'sections': [], 'issues': [{'error': str(exc), 'pages': []}], 'complete': False}
        result = repository.stage_document(run_id=None,source=source,source_id=captured['source_id'],
            pdf_bytes=data,pdf_sha256=captured['pdf_sha256'],document=document,
            http_etag=captured['http_etag'],http_last_modified=captured['http_last_modified'],
            parser_version=adapter.parser_version,downloaded_at=captured['last_downloaded_at'])
        repository.record_event(event_type='captured_sections_reparsed',source_id=captured['source_id'],
            source_version_id=result['version_id'],details={'captured_document_version_id':captured['id'],**result})
        results.append({'source_key':source.source_key,**result})
    return results


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url',default=os.environ.get('DATABASE_URL'))
    parser.add_argument('--source-key',help='Optional GABS catalogue key; otherwise reparse every captured document')
    args=parser.parse_args()
    repository=TimetableRepository.connect(args.database_url)
    try:
        repository.ensure_schema()
        results=reparse_captured(repository,args.source_key)
        print(json.dumps(results,indent=2))
        return 1 if any(r['failed'] for r in results) else 0
    finally:
        repository.close()


if __name__=='__main__':
    raise SystemExit(main())
