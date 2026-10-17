"""Read saved daily-check failures without downloading or changing timetables."""

from __future__ import annotations

import argparse
import os
from typing import Optional, Sequence

import psycopg2
import psycopg2.extras

from .check_sources import compact_result, emit_log


def report_run(connection, run_id=None, *, log=emit_log):
    connection.set_session(readonly=True)
    with connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cursor:
        cursor.execute(
            "SELECT * FROM timetable_source_check_runs "
            "WHERE id = COALESCE(%s, (SELECT max(id) FROM timetable_source_check_runs))",
            (run_id,),
        )
        row = cursor.fetchone()
        if row is None:
            raise ValueError("No matching timetable check run found")
        run = dict(row)
        run_id = run["id"]
        operators = run.pop("operator_results") or {}
        log({"event": "saved_check_run", **run, "operator_results": {
            name: compact_result(details) for name, details in operators.items()
        }})
        cursor.execute(
            """SELECT operator, source_key, source_url, outcome, http_status, error
               FROM timetable_source_check_results
               WHERE check_run_id = %s AND outcome IN ('failed', 'missing')
               ORDER BY operator, source_key, id""",
            (run_id,),
        )
        for failure in cursor.fetchall():
            log({"event": "saved_source_failure", "run_id": run_id, **dict(failure)})
        # Use the exact document captured by this run, not today's pending version.
        # Older runs only stored a generic error in the source-check result.
        cursor.execute(
            """SELECT s.operator, s.source_key, v.source_url,
                      issue->>'timetable_number' AS timetable_number,
                      issue->'pages' AS pages, issue->>'error' AS error
               FROM timetable_source_events e
               JOIN timetable_source_versions v ON v.id = e.source_version_id
               JOIN timetable_sources s ON s.id = v.source_id
               CROSS JOIN LATERAL jsonb_array_elements(
                   COALESCE(v.extraction->'sections', '[]'::jsonb) ||
                   COALESCE(v.extraction->'issues', '[]'::jsonb)
               ) AS issue
               WHERE e.check_run_id = %s AND e.event_type = 'document_sections_checked'
                 AND issue->>'error' IS NOT NULL
               ORDER BY s.operator, s.source_key, e.id""",
            (run_id,),
        )
        for failure in cursor.fetchall():
            log({"event": "saved_section_failure", "run_id": run_id, **dict(failure)})
        for failure in operators.get("gabs_automation", {}).get("timetables", []):
            if failure.get("error"):
                log({"event": "saved_automation_failure", "run_id": run_id, **failure})


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-id", type=int, help="saved run ID (default: latest run)")
    parser.add_argument("--database-url", default=os.environ.get("DATABASE_URL"))
    args = parser.parse_args(argv)
    if not args.database_url:
        parser.error("DATABASE_URL or --database-url is required")
    connection = psycopg2.connect(args.database_url)
    try:
        report_run(connection, args.run_id)
    finally:
        connection.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
