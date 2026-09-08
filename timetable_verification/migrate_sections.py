"""Idempotent backfill of approved GABS evidence; departure times are never rewritten."""
import argparse
import os

import psycopg2.extras

from .canonical import content_sha256
from .sections import review_summary, split_extraction


def migrate_gabs_sections(repository):
    migrated = 0
    with repository.connection:
        with repository.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
            cursor.execute("SELECT pg_advisory_xact_lock(hashtext('fika:timetable-publication'))")
            cursor.execute("SELECT * FROM timetable_sources WHERE operator='GABS' AND NOT section_mode ORDER BY id FOR UPDATE")
            for source in cursor.fetchall():
                cursor.execute('''SELECT * FROM timetable_source_versions WHERE source_id=%s AND
                    (id=%s OR id IN(SELECT timetable_source_version_id FROM trips WHERE timetable_source_id=%s))
                    ORDER BY id''', (source['id'], source['approved_version_id'], source['id']))
                for document in cursor.fetchall():
                    for number, extraction in split_extraction(document['extraction']):
                        cursor.execute('''INSERT INTO timetable_sections(source_id,timetable_number,status,last_manually_verified_on)
                            VALUES (%s,%s,%s,%s) ON CONFLICT(source_id,timetable_number) DO UPDATE
                            SET updated_at=now() RETURNING id''',
                            (source['id'],number,source['status'],source['last_manually_verified_on']))
                        section_id = cursor.fetchone()['id']
                        cursor.execute('''INSERT INTO timetable_section_versions(section_id,document_version_id,
                            content_sha256,extraction,review_summary,review_status,approved_by,approved_at,review_note,published_at)
                            VALUES (%s,%s,%s,%s,%s,'approved',%s,%s,%s,%s)
                            RETURNING id''',
                            (section_id,document['id'],content_sha256(extraction),psycopg2.extras.Json(extraction),
                             psycopg2.extras.Json(review_summary(extraction)),
                             document['approved_by'],document['approved_at'],document['review_note'],document['published_at']))
                        version_id = cursor.fetchone()['id']
                        cursor.execute('''UPDATE timetable_sections SET approved_version_id=%s,last_seen_document_version_id=%s
                            WHERE id=%s AND (approved_version_id IS NULL OR %s)''',
                            (version_id,document['id'],section_id,document['id']==source['approved_version_id']))
                        cursor.execute('''INSERT INTO timetable_section_observations(section_version_id,document_version_id)
                            VALUES (%s,%s) ON CONFLICT DO NOTHING''', (version_id,document['id']))
                        cursor.execute('''UPDATE trips SET timetable_section_version_id=%s FROM directions, routes
                            WHERE trips.direction_id=directions.id AND directions.route_id=routes.id
                            AND trips.timetable_source_version_id=%s AND routes.code || directions.code=%s
                            AND trips.timetable_section_version_id IS NULL''', (version_id,document['id'],number))
                        cursor.execute('''UPDATE timetable_audit_samples SET section_version_id=%s
                            WHERE source_version_id=%s AND route_code || direction_code=%s AND section_version_id IS NULL''',
                            (version_id,document['id'],number))
                cursor.execute('''SELECT count(*) AS missing FROM trips WHERE timetable_source_id=%s
                    AND timetable_source_version_id IS NOT NULL AND timetable_section_version_id IS NULL''', (source['id'],))
                if cursor.fetchone()['missing']:
                    raise ValueError(f"Cannot enable sections: source {source['id']} has unmapped published trips")
                cursor.execute("""UPDATE timetable_sections s SET audit_review_required=true,status='changed_review_required'
                    WHERE s.source_id=%s AND EXISTS (SELECT 1 FROM timetable_audit_samples a
                      JOIN timetable_section_versions v ON v.id=s.approved_version_id
                      WHERE a.source_id=s.source_id AND a.route_code || a.direction_code=s.timetable_number
                        AND a.matched=false AND (v.approved_at IS NULL OR a.reviewed_at>=v.approved_at))""", (source['id'],))
                cursor.execute('UPDATE timetable_sources SET section_mode=true WHERE id=%s', (source['id'],))
                cursor.execute('''INSERT INTO timetable_source_events(source_id,event_type,details)
                    VALUES (%s,'section_baselines_migrated','{"departure_times_changed":false}')''', (source['id'],))
                migrated += 1
    return migrated


def main():
    from .repository import TimetableRepository
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database-url', default=os.environ.get('DATABASE_URL'))
    args = parser.parse_args()
    repository = TimetableRepository.connect(args.database_url)
    try:
        repository.ensure_schema()
        print(f'Migrated {migrate_gabs_sections(repository)} GABS documents')
    finally:
        repository.close()


if __name__ == '__main__':
    main()
