"""PostgreSQL persistence for source checks, review versions, and audits."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence

import psycopg2
import psycopg2.extras

from . import GABS_IMPORT_VERSION, IMPORT_VERSION, PARSER_VERSION
from .adapters.base import DiscoveredSource
from .audit import (
    DEFAULT_AUDIT_SAMPLE_SIZE,
    build_extraction_candidates,
    iso_week_start,
    plan_compliance,
    reconcile_with_published,
    select_stratified_samples,
)
from .canonical import extraction_metadata, sha256_bytes
from .diff import compare_extractions


DEFAULT_SCHEMA_PATH = Path(__file__).resolve().parents[1] / "db" / "timetable_reliability.sql"
MIN_CATALOGUE_SOURCES_FOR_COVERAGE_GUARD = 10
MIN_CATALOGUE_COVERAGE_RATIO = 0.75


class IncompleteCatalogueError(RuntimeError):
    """Raised when a crawl is too incomplete to infer missing sources safely."""


@dataclass(frozen=True)
class StagedVersion:
    source_id: int
    version_id: int
    outcome: str
    comparison: Mapping[str, Any]


class TimetableRepository:
    def __init__(
        self,
        connection: Any,
        *,
        schema_path: Path = DEFAULT_SCHEMA_PATH,
        parser_version: str = PARSER_VERSION,
        import_version: str = IMPORT_VERSION,
    ) -> None:
        self.connection = connection
        self.schema_path = Path(schema_path)
        self.parser_version = parser_version
        self.import_version = import_version

    @classmethod
    def connect(
        cls,
        database_url: str,
        **kwargs: Any,
    ) -> "TimetableRepository":
        if not database_url:
            raise ValueError("DATABASE_URL is required")
        return cls(psycopg2.connect(database_url), **kwargs)

    def close(self) -> None:
        self.connection.close()

    def ensure_schema(self) -> None:
        sql = self.schema_path.read_text(encoding="utf-8")
        with self.connection:
            with self.connection.cursor() as cursor:
                cursor.execute(sql)

    def migrate_gabs_sections(self):
        from .migrate_sections import migrate_gabs_sections
        return migrate_gabs_sections(self)

    def stage_document(self, **kwargs):
        from .section_repository import stage_document
        return stage_document(self, **kwargs)

    def start_check_run(self) -> int:
        with self.connection:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO timetable_source_check_runs DEFAULT VALUES RETURNING id"
                )
                return int(cursor.fetchone()[0])

    def finish_check_run(
        self,
        run_id: int,
        *,
        status: str,
        counts: Mapping[str, int],
        operator_results: Mapping[str, Any],
        error: Optional[str] = None,
    ) -> None:
        with self.connection:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE timetable_source_check_runs
                    SET finished_at = now(),
                        status = %s,
                        sources_discovered = %s,
                        sources_downloaded = %s,
                        sources_unchanged = %s,
                        sources_changed = %s,
                        sources_failed = %s,
                        operator_results = %s,
                        error = %s
                    WHERE id = %s
                    """,
                    (
                        status,
                        int(counts.get("discovered", 0)),
                        int(counts.get("downloaded", 0)),
                        int(counts.get("unchanged", 0)),
                        int(counts.get("changed", 0)),
                        int(counts.get("failed", 0)),
                        psycopg2.extras.Json(dict(operator_results)),
                        error,
                        run_id,
                    ),
                )

    def fail_running_check(self, run_id: int, error: str) -> None:
        with self.connection:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    UPDATE timetable_source_check_runs
                    SET finished_at = now(), status = 'failed', error = %s
                    WHERE id = %s AND status = 'running'
                    """,
                    (error[:10000], run_id),
                )

    def upsert_discovered_source(
        self,
        source: DiscoveredSource,
        *,
        parser_version: Optional[str] = None,
    ) -> Mapping[str, Any]:
        active_parser_version = parser_version or self.parser_version
        with self.connection:
            with self.connection.cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cursor:
                cursor.execute(
                    """
                    INSERT INTO timetable_sources (
                      operator, source_key, route_name, official_source_url,
                      parser_version, import_version, last_seen_at, section_mode
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, now(), %s)
                    ON CONFLICT (operator, source_key) DO UPDATE SET
                      official_source_url = EXCLUDED.official_source_url,
                      route_name = CASE
                        WHEN timetable_sources.route_name = ''
                          THEN EXCLUDED.route_name
                        ELSE timetable_sources.route_name
                      END,
                      last_seen_at = now(),
                      updated_at = now()
                    RETURNING *
                    """,
                    (
                        source.operator,
                        source.source_key,
                        source.route_name_hint,
                        source.url,
                        active_parser_version,
                        GABS_IMPORT_VERSION if source.operator == "GABS" else self.import_version,
                        source.operator == "GABS",
                    ),
                )
                return dict(cursor.fetchone())

    def stage_download(
        self,
        *,
        run_id: int,
        source: DiscoveredSource,
        source_id: int,
        pdf_bytes: bytes,
        pdf_sha256: str,
        content_sha256: str,
        extraction: Dict[str, Any],
        http_etag: Optional[str],
        http_last_modified: Optional[str],
        parser_version: Optional[str] = None,
    ) -> StagedVersion:
        active_parser_version = parser_version or self.parser_version
        metadata = extraction_metadata(extraction)
        with self.connection:
            with self.connection.cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cursor:
                cursor.execute(
                    "SELECT * FROM timetable_sources WHERE id = %s FOR UPDATE",
                    (source_id,),
                )
                source_row = cursor.fetchone()
                if not source_row:
                    raise LookupError(f"timetable source {source_id} does not exist")

                cursor.execute(
                    """
                    SELECT id, previous_version_id, pdf_sha256, content_sha256,
                           extraction, comparison, review_status
                    FROM timetable_source_versions
                    WHERE source_id = %s
                      AND pdf_sha256 = %s
                      AND parser_version = %s
                      AND import_version = %s
                    """,
                    (
                        source_id,
                        pdf_sha256,
                        active_parser_version,
                        self.import_version,
                    ),
                )
                matching_version = cursor.fetchone()
                current_ids = {
                    int(value)
                    for value in (
                        source_row.get("pending_version_id"),
                        source_row.get("approved_version_id"),
                    )
                    if value is not None
                }

                def missing_reappearance_details(
                    version: Mapping[str, Any],
                ) -> Dict[str, Any]:
                    missing_checks = int(
                        source_row.get("consecutive_missing_checks") or 0
                    )
                    status_before_missing = None
                    audit_mismatch_since_missing = False
                    if missing_checks:
                        cursor.execute(
                            """
                            SELECT
                              missing.details->>'status_before_missing' AS prior_status,
                              EXISTS (
                                SELECT 1
                                FROM timetable_source_events later
                                WHERE later.source_id = missing.source_id
                                  AND later.id > missing.id
                                  AND later.event_type = 'weekly_audit_mismatch'
                              ) AS audit_mismatch_since_missing
                            FROM timetable_source_events missing
                            WHERE missing.source_id = %s
                              AND missing.event_type = 'source_missing_from_catalogue'
                            ORDER BY missing.id DESC
                            OFFSET %s
                            LIMIT 1
                            """,
                            (source_id, max(0, missing_checks - 1)),
                        )
                        missing_event = cursor.fetchone()
                        if missing_event:
                            status_before_missing = missing_event.get("prior_status")
                            audit_mismatch_since_missing = bool(
                                missing_event.get("audit_mismatch_since_missing")
                            )
                    restore_verified = bool(
                        missing_checks
                        and status_before_missing == "verified"
                        and not audit_mismatch_since_missing
                        and source_row.get("pending_version_id") is None
                        and source_row.get("approved_version_id") == int(version["id"])
                        and version.get("review_status") == "approved"
                    )
                    return {
                        "consecutive_missing_checks": missing_checks,
                        "status_before_missing": status_before_missing,
                        "audit_mismatch_since_missing": audit_mismatch_since_missing,
                        "restored_verified": restore_verified,
                    }

                def record_missing_reappearance(
                    version_id: int,
                    details: Mapping[str, Any],
                ) -> None:
                    if not details["consecutive_missing_checks"]:
                        return
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_events (
                          source_id, source_version_id, check_run_id,
                          event_type, details
                        ) VALUES (
                          %s, %s, %s, 'source_reappeared_unchanged', %s
                        )
                        """,
                        (
                            source_id,
                            version_id,
                            run_id,
                            psycopg2.extras.Json(dict(details)),
                        ),
                    )

                is_current_match = bool(
                    matching_version
                    and int(matching_version["id"]) in current_ids
                    and source_row.get("status") != "withdrawn"
                    and source_row.get("current_pdf_sha256") == pdf_sha256
                    and source_row.get("current_content_sha256") == content_sha256
                    and source_row.get("parser_version") == active_parser_version
                    and source_row.get("import_version") == self.import_version
                )
                if is_current_match:
                    version_id = int(matching_version["id"])
                    reappearance = missing_reappearance_details(matching_version)
                    cursor.execute(
                        """
                        UPDATE timetable_source_versions
                        SET last_downloaded_at = now(), http_etag = %s,
                            http_last_modified = %s
                        WHERE id = %s
                        """,
                        (http_etag, http_last_modified, version_id),
                    )
                    cursor.execute(
                        """
                        UPDATE timetable_sources
                        SET last_downloaded_at = now(), last_seen_at = now(),
                            official_source_url = %s,
                            consecutive_missing_checks = 0,
                            status = CASE WHEN %s THEN 'verified' ELSE status END,
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (source.url, reappearance["restored_verified"], source_id),
                    )
                    record_missing_reappearance(version_id, reappearance)
                    return StagedVersion(
                        source_id=source_id,
                        version_id=version_id,
                        outcome="unchanged",
                        comparison={},
                    )

                is_repeated_equivalent_observation = bool(
                    matching_version
                    and source_row.get("status") == "verified"
                    and source_row.get("pending_version_id") is None
                    and source_row.get("approved_version_id") is not None
                    and int(matching_version["id"])
                    != int(source_row["approved_version_id"])
                    and matching_version.get("review_status") == "superseded"
                    and matching_version.get("comparison", {}).get(
                        "pdf_bytes_changed_content_unchanged"
                    )
                    is True
                    and source_row.get("current_pdf_sha256") == pdf_sha256
                    and source_row.get("current_content_sha256") == content_sha256
                    and source_row.get("parser_version") == active_parser_version
                    and source_row.get("import_version") == self.import_version
                )
                if is_repeated_equivalent_observation:
                    version_id = int(matching_version["id"])
                    cursor.execute(
                        """
                        UPDATE timetable_source_versions
                        SET last_downloaded_at = now(), http_etag = %s,
                            http_last_modified = %s
                        WHERE id = %s
                        """,
                        (http_etag, http_last_modified, version_id),
                    )
                    cursor.execute(
                        """
                        UPDATE timetable_sources
                        SET last_downloaded_at = now(), last_seen_at = now(),
                            official_source_url = %s,
                            consecutive_missing_checks = 0,
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (source.url, source_id),
                    )
                    return StagedVersion(
                        source_id=source_id,
                        version_id=version_id,
                        outcome="unchanged",
                        comparison=dict(matching_version["comparison"]),
                    )

                baseline_id = (
                    source_row.get("approved_version_id")
                    or source_row.get("pending_version_id")
                )
                baseline = None
                if baseline_id:
                    cursor.execute(
                        """
                        SELECT id, pdf_sha256, content_sha256, parser_version,
                               import_version, extraction, review_status
                        FROM timetable_source_versions
                        WHERE id = %s
                        """,
                        (baseline_id,),
                    )
                    baseline = cursor.fetchone()
                if baseline is None:
                    cursor.execute(
                        """
                        SELECT id, pdf_sha256, content_sha256, parser_version,
                               import_version, extraction, review_status
                        FROM timetable_source_versions
                        WHERE source_id = %s
                        ORDER BY first_downloaded_at DESC, id DESC
                        LIMIT 1
                        """,
                        (source_id,),
                    )
                    baseline = cursor.fetchone()
                # Withdrawal deliberately clears the approved pointer.  If the
                # same bytes later reappear, the latest-version fallback can be
                # the matching row itself; it is not a valid previous version.
                if (
                    baseline
                    and matching_version
                    and int(baseline["id"]) == int(matching_version["id"])
                ):
                    baseline = None
                parser_only_equivalent = bool(
                    baseline
                    and not matching_version
                    and int(baseline["id"]) in current_ids
                    and source_row.get("status") != "withdrawn"
                    and baseline.get("pdf_sha256") == pdf_sha256
                    and baseline.get("content_sha256") == content_sha256
                    and baseline.get("import_version") == self.import_version
                    and source_row.get("current_pdf_sha256") == pdf_sha256
                    and source_row.get("current_content_sha256") == content_sha256
                )
                if parser_only_equivalent:
                    version_id = int(baseline["id"])
                    reappearance = missing_reappearance_details(baseline)
                    cursor.execute(
                        """
                        UPDATE timetable_source_versions
                        SET last_downloaded_at = now(), http_etag = %s,
                            http_last_modified = %s
                        WHERE id = %s
                        """,
                        (http_etag, http_last_modified, version_id),
                    )
                    cursor.execute(
                        """
                        UPDATE timetable_sources
                        SET last_downloaded_at = now(), last_seen_at = now(),
                            official_source_url = %s,
                            consecutive_missing_checks = 0,
                            status = CASE WHEN %s THEN 'verified' ELSE status END,
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (source.url, reappearance["restored_verified"], source_id),
                    )
                    record_missing_reappearance(version_id, reappearance)
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_events (
                          source_id, source_version_id, check_run_id,
                          event_type, details
                        )
                        SELECT %s, %s, %s, 'source_reparsed_unchanged', %s
                        WHERE NOT EXISTS (
                          SELECT 1
                          FROM timetable_source_events
                          WHERE source_id = %s
                            AND source_version_id = %s
                            AND event_type = 'source_reparsed_unchanged'
                            AND details->>'parser_version' = %s
                        )
                        """,
                        (
                            source_id,
                            version_id,
                            run_id,
                            psycopg2.extras.Json(
                                {
                                    "parser_version": active_parser_version,
                                    "published_parser_version": baseline.get(
                                        "parser_version"
                                    ),
                                    "pdf_sha256": pdf_sha256,
                                    "content_sha256": content_sha256,
                                }
                            ),
                            source_id,
                            version_id,
                            active_parser_version,
                        ),
                    )
                    return StagedVersion(
                        source_id=source_id,
                        version_id=version_id,
                        outcome="unchanged",
                        comparison={"parser_only_equivalent": True},
                    )
                comparison = compare_extractions(
                    dict(baseline["extraction"]) if baseline else None,
                    extraction,
                )
                if source_row.get("status") == "withdrawn":
                    comparison = {
                        **comparison,
                        "has_changes": True,
                        "source_reappeared_after_withdrawal": True,
                    }

                # Operators sometimes regenerate a PDF without changing any of
                # its canonical timetable content (for example, PDF metadata or
                # layout-only changes). Preserve those newly observed bytes as
                # evidence, but do not create a review/publishing task when the
                # currently approved extraction is exactly equivalent.
                content_equivalent_to_approved = bool(
                    baseline
                    and source_row.get("status") == "verified"
                    and source_row.get("pending_version_id") is None
                    and source_row.get("approved_version_id") == int(baseline["id"])
                    and baseline.get("review_status") == "approved"
                    and baseline.get("content_sha256") == content_sha256
                    and baseline.get("import_version") == self.import_version
                    and source_row.get("current_content_sha256") == content_sha256
                    and comparison.get("has_changes") is False
                )
                if content_equivalent_to_approved:
                    equivalent_comparison = {
                        **comparison,
                        "pdf_bytes_changed_content_unchanged": True,
                    }
                    if matching_version:
                        version_id = int(matching_version["id"])
                        cursor.execute(
                            """
                            UPDATE timetable_source_versions
                            SET last_downloaded_at = now(),
                                http_etag = %s,
                                http_last_modified = %s,
                                previous_version_id = %s,
                                comparison = %s,
                                review_status = 'superseded',
                                review_note = 'Canonical timetable content unchanged; publication not required.'
                            WHERE id = %s
                            """,
                            (
                                http_etag,
                                http_last_modified,
                                int(baseline["id"]),
                                psycopg2.extras.Json(equivalent_comparison),
                                version_id,
                            ),
                        )
                    else:
                        cursor.execute(
                            """
                            INSERT INTO timetable_source_versions (
                              source_id, previous_version_id, pdf_sha256, content_sha256,
                              source_url, source_effective_date, http_etag,
                              http_last_modified, parser_version, import_version,
                              route_name, direction_names, service_day_coverage,
                              extraction, comparison, pdf_bytes, pdf_size_bytes,
                              review_status, review_note
                            )
                            VALUES (
                              %s, %s, %s, %s, %s, %s::date, %s, %s, %s, %s,
                              %s, %s, %s, %s, %s, %s, %s,
                              'superseded',
                              'Canonical timetable content unchanged; publication not required.'
                            )
                            RETURNING id
                            """,
                            (
                                source_id,
                                int(baseline["id"]),
                                pdf_sha256,
                                content_sha256,
                                source.url,
                                metadata["source_effective_date"],
                                http_etag,
                                http_last_modified,
                                active_parser_version,
                                self.import_version,
                                metadata["route_name"],
                                metadata["direction_names"],
                                metadata["service_day_coverage"],
                                psycopg2.extras.Json(extraction),
                                psycopg2.extras.Json(equivalent_comparison),
                                psycopg2.Binary(pdf_bytes),
                                len(pdf_bytes),
                            ),
                        )
                        version_id = int(cursor.fetchone()["id"])

                    cursor.execute(
                        """
                        UPDATE timetable_sources
                        SET route_name = %s,
                            direction_names = %s,
                            service_day_coverage = %s,
                            official_source_url = %s,
                            source_effective_date = %s::date,
                            last_downloaded_at = now(),
                            last_seen_at = now(),
                            current_pdf_sha256 = %s,
                            current_content_sha256 = %s,
                            parser_version = %s,
                            import_version = %s,
                            consecutive_missing_checks = 0,
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (
                            metadata["route_name"],
                            metadata["direction_names"],
                            metadata["service_day_coverage"],
                            source.url,
                            metadata["source_effective_date"],
                            pdf_sha256,
                            content_sha256,
                            active_parser_version,
                            self.import_version,
                            source_id,
                        ),
                    )
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_events (
                          source_id, source_version_id, check_run_id,
                          event_type, details
                        ) VALUES (
                          %s, %s, %s, 'source_pdf_changed_content_unchanged', %s
                        )
                        """,
                        (
                            source_id,
                            version_id,
                            run_id,
                            psycopg2.extras.Json(
                                {
                                    "approved_version_id": int(baseline["id"]),
                                    "approved_pdf_sha256": baseline.get("pdf_sha256"),
                                    "observed_pdf_sha256": pdf_sha256,
                                    "content_sha256": content_sha256,
                                }
                            ),
                        ),
                    )
                    return StagedVersion(
                        source_id=source_id,
                        version_id=version_id,
                        outcome="unchanged",
                        comparison=equivalent_comparison,
                    )

                outcome = (
                    "changed"
                    if baseline or source_row.get("status") == "withdrawn"
                    else "new"
                )

                if matching_version:
                    if matching_version["content_sha256"] != content_sha256:
                        raise RuntimeError(
                            "the same PDF/parser/import tuple produced different "
                            "canonical content; bump PARSER_VERSION or IMPORT_VERSION"
                        )
                    version_id = int(matching_version["id"])
                    previous_version_id = (
                        int(baseline["id"])
                        if baseline and int(baseline["id"]) != version_id
                        else matching_version.get("previous_version_id")
                    )
                    cursor.execute(
                        """
                        UPDATE timetable_source_versions
                        SET last_downloaded_at = now(), review_status = 'pending',
                            approved_by = NULL, approved_at = NULL,
                            review_note = NULL, published_at = NULL,
                            http_etag = %s, http_last_modified = %s,
                            previous_version_id = %s, comparison = %s
                        WHERE id = %s
                        """,
                        (
                            http_etag,
                            http_last_modified,
                            previous_version_id,
                            psycopg2.extras.Json(comparison),
                            version_id,
                        ),
                    )
                    # PDF bytes and extraction remain immutable. Comparison and
                    # previous_version_id describe this new review occurrence.
                else:
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_versions (
                          source_id, previous_version_id, pdf_sha256, content_sha256,
                          source_url, source_effective_date, http_etag,
                          http_last_modified, parser_version, import_version,
                          route_name, direction_names, service_day_coverage,
                          extraction, comparison, pdf_bytes, pdf_size_bytes
                        )
                        VALUES (
                          %s, %s, %s, %s, %s, %s::date, %s, %s, %s, %s,
                          %s, %s, %s, %s, %s, %s, %s
                        )
                        RETURNING id
                        """,
                        (
                            source_id,
                            int(baseline["id"]) if baseline else None,
                            pdf_sha256,
                            content_sha256,
                            source.url,
                            metadata["source_effective_date"],
                            http_etag,
                            http_last_modified,
                            active_parser_version,
                            self.import_version,
                            metadata["route_name"],
                            metadata["direction_names"],
                            metadata["service_day_coverage"],
                            psycopg2.extras.Json(extraction),
                            psycopg2.extras.Json(comparison),
                            psycopg2.Binary(pdf_bytes),
                            len(pdf_bytes),
                        ),
                    )
                    version_id = int(cursor.fetchone()["id"])

                previous_pending_id = source_row.get("pending_version_id")
                if previous_pending_id and int(previous_pending_id) != version_id:
                    cursor.execute(
                        """
                        UPDATE timetable_source_versions
                        SET review_status = 'superseded'
                        WHERE id = %s AND review_status = 'pending'
                        """,
                        (previous_pending_id,),
                    )
                cursor.execute(
                    """
                    UPDATE timetable_sources
                    SET route_name = %s,
                        direction_names = %s,
                        service_day_coverage = %s,
                        official_source_url = %s,
                        source_effective_date = %s::date,
                        last_downloaded_at = now(),
                        last_seen_at = now(),
                        current_pdf_sha256 = %s,
                        current_content_sha256 = %s,
                        parser_version = %s,
                        import_version = %s,
                        status = 'changed_review_required',
                        pending_version_id = %s,
                        consecutive_missing_checks = 0,
                        withdrawn_at = NULL,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (
                        metadata["route_name"],
                        metadata["direction_names"],
                        metadata["service_day_coverage"],
                        source.url,
                        metadata["source_effective_date"],
                        pdf_sha256,
                        content_sha256,
                        active_parser_version,
                        self.import_version,
                        version_id,
                        source_id,
                    ),
                )
                cursor.execute(
                    """
                    INSERT INTO timetable_source_events (
                      source_id, source_version_id, check_run_id, event_type, details
                    )
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        source_id,
                        version_id,
                        run_id,
                        "source_discovered" if outcome == "new" else "source_changed_review_required",
                        psycopg2.extras.Json(
                            {
                                "pdf_sha256": pdf_sha256,
                                "content_sha256": content_sha256,
                                "comparison": comparison,
                            }
                        ),
                    ),
                )
                return StagedVersion(
                    source_id=source_id,
                    version_id=version_id,
                    outcome=outcome,
                    comparison=comparison,
                )

    def stage_parse_failure(
        self,
        *,
        run_id: int,
        source: DiscoveredSource,
        source_id: int,
        pdf_bytes: bytes,
        pdf_sha256: str,
        error: str,
        http_etag: Optional[str],
        http_last_modified: Optional[str],
        parser_version: Optional[str] = None,
    ) -> StagedVersion:
        """Quarantine newly downloaded bytes that the parser cannot extract."""

        active_parser_version = parser_version or self.parser_version

        failure_extraction = {
            "schema_version": 1,
            "operator": source.operator,
            "source_key": source.source_key,
            "publication_scope": "route" if source.operator == "MyCiti" else "service_days",
            "effective_date": None,
            "routes": [],
            "parse_error": error[:10000],
        }
        serialized = json.dumps(
            failure_extraction,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        failure_content_sha256 = sha256_bytes(serialized)
        with self.connection:
            with self.connection.cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cursor:
                cursor.execute(
                    "SELECT * FROM timetable_sources WHERE id = %s FOR UPDATE",
                    (source_id,),
                )
                source_row = cursor.fetchone()
                if not source_row:
                    raise LookupError(f"timetable source {source_id} does not exist")
                cursor.execute(
                    """
                    SELECT id, previous_version_id, content_sha256, extraction
                    FROM timetable_source_versions
                    WHERE source_id = %s AND pdf_sha256 = %s
                      AND parser_version = %s AND import_version = %s
                    """,
                    (
                        source_id,
                        pdf_sha256,
                        active_parser_version,
                        self.import_version,
                    ),
                )
                existing = cursor.fetchone()
                if existing and not existing["extraction"].get("parse_error"):
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_events (
                          source_id, source_version_id, check_run_id,
                          event_type, details
                        ) VALUES (%s, %s, %s, 'source_parse_failed', %s)
                        """,
                        (
                            source_id,
                            existing["id"],
                            run_id,
                            psycopg2.extras.Json({"error": error[:10000]}),
                        ),
                    )
                    return StagedVersion(
                        source_id=source_id,
                        version_id=int(existing["id"]),
                        outcome="changed",
                        comparison={"parse_error": error[:10000]},
                    )

                original_baseline_id = (
                    source_row.get("approved_version_id")
                    or source_row.get("pending_version_id")
                )
                baseline_id = original_baseline_id
                if (
                    existing
                    and baseline_id is not None
                    and int(baseline_id) == int(existing["id"])
                ):
                    baseline_id = existing.get("previous_version_id")
                comparison = {
                    "has_previous_version": baseline_id is not None,
                    "parse_error": error[:10000],
                    "pdf_sha256": pdf_sha256,
                }
                if existing:
                    version_id = int(existing["id"])
                    cursor.execute(
                        """
                        UPDATE timetable_source_versions
                        SET previous_version_id = %s, last_downloaded_at = now(),
                            http_etag = %s, http_last_modified = %s,
                            comparison = %s, review_status = 'pending'
                        WHERE id = %s
                        """,
                        (
                            baseline_id,
                            http_etag,
                            http_last_modified,
                            psycopg2.extras.Json(comparison),
                            version_id,
                        ),
                    )
                else:
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_versions (
                          source_id, previous_version_id, pdf_sha256, content_sha256,
                          source_url, http_etag, http_last_modified,
                          parser_version, import_version, route_name,
                          extraction, comparison, pdf_bytes, pdf_size_bytes
                        ) VALUES (
                          %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                          %s, %s, %s, %s
                        ) RETURNING id
                        """,
                        (
                            source_id,
                            baseline_id,
                            pdf_sha256,
                            failure_content_sha256,
                            source.url,
                            http_etag,
                            http_last_modified,
                            active_parser_version,
                            self.import_version,
                            source.route_name_hint,
                            psycopg2.extras.Json(failure_extraction),
                            psycopg2.extras.Json(comparison),
                            psycopg2.Binary(pdf_bytes),
                            len(pdf_bytes),
                        ),
                    )
                    version_id = int(cursor.fetchone()["id"])
                staged_content_sha256 = (
                    existing["content_sha256"]
                    if existing
                    else failure_content_sha256
                )
                previous_pending_id = source_row.get("pending_version_id")
                if previous_pending_id and int(previous_pending_id) != version_id:
                    cursor.execute(
                        """
                        UPDATE timetable_source_versions
                        SET review_status = 'superseded'
                        WHERE id = %s AND review_status = 'pending'
                        """,
                        (previous_pending_id,),
                    )
                cursor.execute(
                    """
                    UPDATE timetable_sources
                    SET official_source_url = %s,
                        last_downloaded_at = now(), last_seen_at = now(),
                        current_pdf_sha256 = %s,
                        current_content_sha256 = %s,
                        parser_version = %s,
                        import_version = %s,
                        status = 'changed_review_required',
                        pending_version_id = %s,
                        consecutive_missing_checks = 0,
                        updated_at = now()
                    WHERE id = %s
                    """,
                    (
                        source.url,
                        pdf_sha256,
                        staged_content_sha256,
                        active_parser_version,
                        self.import_version,
                        version_id,
                        source_id,
                    ),
                )
                cursor.execute(
                    """
                    INSERT INTO timetable_source_events (
                      source_id, source_version_id, check_run_id,
                      event_type, details
                    ) VALUES (%s, %s, %s, 'source_parse_failed_review_required', %s)
                    """,
                    (
                        source_id,
                        version_id,
                        run_id,
                        psycopg2.extras.Json(comparison),
                    ),
                )
                return StagedVersion(
                    source_id=source_id,
                    version_id=version_id,
                    outcome="changed" if existing or original_baseline_id else "new",
                    comparison=comparison,
                )

    def record_check_result(
        self,
        *,
        run_id: int,
        source: DiscoveredSource,
        outcome: str,
        source_id: Optional[int] = None,
        http_status: Optional[int] = None,
        pdf_sha256: Optional[str] = None,
        duration_ms: Optional[int] = None,
        error: Optional[str] = None,
    ) -> None:
        with self.connection:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO timetable_source_check_results (
                      check_run_id, source_id, operator, source_key, source_url,
                      http_status, outcome, pdf_sha256, duration_ms, error
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        run_id,
                        source_id,
                        source.operator,
                        source.source_key,
                        source.url,
                        http_status,
                        outcome,
                        pdf_sha256,
                        duration_ms,
                        error[:10000] if error else None,
                    ),
                )

    def mark_missing_sources(
        self,
        *,
        run_id: int,
        operator: str,
        discovered_keys: Sequence[str],
    ) -> int:
        with self.connection:
            with self.connection.cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cursor:
                unique_discovered_keys = sorted(set(discovered_keys))
                cursor.execute(
                    """
                    SELECT count(*) AS known_count
                    FROM timetable_sources
                    WHERE operator = %s AND status <> 'withdrawn'
                    """,
                    (operator,),
                )
                known_count = int(cursor.fetchone()["known_count"])
                discovered_count = len(unique_discovered_keys)
                coverage_ratio = (
                    discovered_count / known_count if known_count else 1.0
                )
                if (
                    known_count >= MIN_CATALOGUE_SOURCES_FOR_COVERAGE_GUARD
                    and coverage_ratio < MIN_CATALOGUE_COVERAGE_RATIO
                ):
                    details = {
                        "operator": operator,
                        "known_non_withdrawn_sources": known_count,
                        "discovered_sources": discovered_count,
                        "coverage_ratio": coverage_ratio,
                        "minimum_coverage_ratio": MIN_CATALOGUE_COVERAGE_RATIO,
                        "missing_sources_marked": 0,
                    }
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_events (
                          check_run_id, event_type, details
                        ) VALUES (%s, 'catalogue_coverage_guard_triggered', %s)
                        """,
                        (run_id, psycopg2.extras.Json(details)),
                    )
                    coverage_error = IncompleteCatalogueError(
                        f"{operator} catalogue returned {discovered_count} of "
                        f"{known_count} known active sources "
                        f"({coverage_ratio:.1%}); no sources were marked missing"
                    )
                else:
                    coverage_error = None
                if coverage_error:
                    # Leave the transaction normally so the diagnostic event is
                    # durable, then raise after the context commits it.
                    missing = []
                else:
                    cursor.execute(
                        """
                        SELECT id, source_key, official_source_url, status,
                               consecutive_missing_checks
                        FROM timetable_sources
                        WHERE operator = %s
                          AND status <> 'withdrawn'
                          AND NOT (source_key = ANY(%s::text[]))
                        ORDER BY source_key
                        FOR UPDATE
                        """,
                        (operator, unique_discovered_keys),
                    )
                    missing = list(cursor.fetchall())
                for source in missing:
                    status_before_missing = source["status"]
                    if int(source["consecutive_missing_checks"] or 0) > 0:
                        cursor.execute(
                            """
                            SELECT details->>'status_before_missing' AS prior_status
                            FROM timetable_source_events
                            WHERE source_id = %s
                              AND event_type = 'source_missing_from_catalogue'
                            ORDER BY id DESC
                            LIMIT 1
                            """,
                            (source["id"],),
                        )
                        previous_event = cursor.fetchone()
                        if previous_event and previous_event.get("prior_status"):
                            status_before_missing = previous_event["prior_status"]
                    cursor.execute(
                        """
                        UPDATE timetable_sources
                        SET consecutive_missing_checks = consecutive_missing_checks + 1,
                            status = CASE
                              WHEN status = 'withdrawn' THEN status
                              ELSE 'changed_review_required'
                            END,
                            updated_at = now()
                        WHERE id = %s
                        """,
                        (source["id"],),
                    )
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_check_results (
                          check_run_id, source_id, operator, source_key, source_url, outcome
                        ) VALUES (%s, %s, %s, %s, %s, 'missing')
                        """,
                        (
                            run_id,
                            source["id"],
                            operator,
                            source["source_key"],
                            source["official_source_url"],
                        ),
                    )
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_events (
                          source_id, check_run_id, event_type, details
                        ) VALUES (%s, %s, 'source_missing_from_catalogue', %s)
                        """,
                        (
                            source["id"],
                            run_id,
                            psycopg2.extras.Json(
                                {
                                    "action": "manual_review_required",
                                    "auto_withdrawn": False,
                                    "status_before_missing": status_before_missing,
                                }
                            ),
                        ),
                    )
            if coverage_error:
                raise coverage_error
            return len(missing)

    def approved_versions(self) -> List[Mapping[str, Any]]:
        with self.connection.cursor(
            cursor_factory=psycopg2.extras.RealDictCursor
        ) as cursor:
            cursor.execute(
                """
                SELECT s.id AS source_id, v.id AS source_version_id, v.extraction, NULL::bigint AS section_version_id
                FROM timetable_sources s
                JOIN timetable_source_versions v ON v.id = s.approved_version_id
                WHERE v.review_status = 'approved'
                  AND s.status <> 'withdrawn' AND NOT s.section_mode
                UNION ALL
                SELECT sections.source_id, versions.document_version_id AS source_version_id,
                       versions.extraction, versions.id AS section_version_id
                FROM timetable_section_versions versions
                JOIN timetable_sections sections ON sections.id=versions.section_id
                WHERE versions.id IN (SELECT DISTINCT timetable_section_version_id FROM trips
                                      WHERE timetable_section_version_id IS NOT NULL)
                ORDER BY source_id, source_version_id
                """
            )
            return [dict(row) for row in cursor.fetchall()]

    def published_departures(self, version_ids: Sequence[int]) -> List[Mapping[str, Any]]:
        if not version_ids:
            return []
        with self.connection.cursor(
            cursor_factory=psycopg2.extras.RealDictCursor
        ) as cursor:
            cursor.execute(
                """
                WITH published AS (
                  SELECT
                    trips.timetable_source_version_id AS source_version_id,
                    trips.timetable_section_version_id AS section_version_id,
                    routes.code AS route_code,
                    directions.code AS direction_code,
                    directions.direction AS direction_name,
                    trips.timetable_trip_ordinal AS trip_ordinal,
                    service_day.name AS service_day,
                    stop_times.sequence AS stop_sequence,
                    stops.name AS stop_name,
                    to_char(stop_times.departure, 'HH24:MI') AS expected_departure
                  FROM trips
                  JOIN directions ON directions.id = trips.direction_id
                  JOIN routes ON routes.id = directions.route_id
                  JOIN stop_times ON stop_times.trip_id = trips.id
                  JOIN stops ON stops.id = stop_times.stop_id
                  CROSS JOIN LATERAL (
                    VALUES
                      ('monday', trips.monday),
                      ('tuesday', trips.tuesday),
                      ('wednesday', trips.wednesday),
                      ('thursday', trips.thursday),
                      ('friday', trips.friday),
                      ('saturday', trips.saturday),
                      ('sunday', trips.sunday),
                      ('public_holiday', trips.public_holiday)
                  ) AS service_day(name, enabled)
                  WHERE trips.timetable_source_version_id = ANY(%s::bigint[])
                    AND trips.timetable_trip_ordinal IS NOT NULL
                    AND service_day.enabled
                    AND stop_times.stop_time_type = 'scheduled'
                    AND stop_times.departure IS NOT NULL
                )
                SELECT * FROM published
                ORDER BY source_version_id, route_code, direction_name,
                         service_day, trip_ordinal, stop_sequence
                """,
                (list(version_ids),),
            )
            return [dict(row) for row in cursor.fetchall()]

    def ensure_weekly_audit_plan(
        self,
        *,
        check_run_id: Optional[int],
        target_sample_size: int = DEFAULT_AUDIT_SAMPLE_SIZE,
    ) -> Mapping[str, Any]:
        week = iso_week_start()
        with self.connection:
            with self.connection.cursor(
                cursor_factory=psycopg2.extras.RealDictCursor
            ) as cursor:
                # Publication takes the same transaction-scoped lock.  This
                # prevents approval/withdrawal from invalidating a plan between
                # candidate reconciliation and insertion.
                cursor.execute(
                    "SELECT pg_advisory_xact_lock(hashtext('fika:timetable-publication'))"
                )
                cursor.execute(
                    """
                    SELECT *
                    FROM timetable_audit_runs
                    WHERE audit_week = %s AND status <> 'cancelled'
                    ORDER BY id DESC
                    LIMIT 1
                    """,
                    (week,),
                )
                existing = cursor.fetchone()
                if existing:
                    return {
                        "status": "existing",
                        "audit_run_id": int(existing["id"]),
                    }

                versions = self.approved_versions()
                extraction_candidates = build_extraction_candidates(versions)
                published_rows = self.published_departures(
                    [int(version["source_version_id"]) for version in versions]
                )
                reconciled, reconciliation = reconcile_with_published(
                    extraction_candidates,
                    published_rows,
                )
                selected = select_stratified_samples(
                    reconciled,
                    audit_week=week,
                    target_sample_size=target_sample_size,
                )
                compliance = plan_compliance(
                    selected,
                    reconciled,
                    target_sample_size=target_sample_size,
                )
                if not compliance["compliant"]:
                    details = {
                        "audit_week": week.isoformat(),
                        "target_sample_size": max(100, int(target_sample_size)),
                        "reconciliation": reconciliation,
                        **compliance,
                    }
                    cursor.execute(
                        """
                        INSERT INTO timetable_source_events (
                          check_run_id, event_type, details
                        ) VALUES (%s, 'audit_plan_shortfall', %s)
                        """,
                        (check_run_id, psycopg2.extras.Json(details)),
                    )
                    return {"status": "shortfall", **details}

                cursor.execute(
                    """
                    INSERT INTO timetable_audit_runs (
                      audit_week, target_sample_size, sampled_count, status
                    ) VALUES (%s, %s, %s, 'planned')
                    ON CONFLICT (audit_week)
                    WHERE status IN ('planned', 'in_progress')
                    DO NOTHING
                    RETURNING id
                    """,
                    (week, max(100, int(target_sample_size)), len(selected)),
                )
                inserted = cursor.fetchone()
                if not inserted:
                    cursor.execute(
                        """
                        SELECT id FROM timetable_audit_runs
                        WHERE audit_week = %s
                          AND status IN ('planned', 'in_progress')
                        ORDER BY id DESC LIMIT 1
                        """,
                        (week,),
                    )
                    concurrent = cursor.fetchone()
                    if not concurrent:
                        raise RuntimeError(
                            "audit plan conflict occurred without an active plan"
                        )
                    return {
                        "status": "existing",
                        "audit_run_id": int(concurrent["id"]),
                    }
                audit_run_id = int(inserted["id"])
                psycopg2.extras.execute_values(
                    cursor,
                    """
                    INSERT INTO timetable_audit_samples (
                      audit_run_id, source_id, source_version_id, operator,
                      route_code, route_name, direction_code, direction_name,
                      direction_ordinal, service_day, trip_ordinal, stop_name,
                      stop_sequence, expected_departure, raw_departure,
                      sample_kind, footnote_markers, section_version_id
                    ) VALUES %s
                    """,
                    [
                        (
                            audit_run_id,
                            item.source_id,
                            item.source_version_id,
                            item.operator,
                            item.route_code,
                            item.route_name,
                            item.direction_code,
                            item.direction_name,
                            item.direction_ordinal,
                            item.service_day,
                            item.trip_ordinal,
                            item.stop_name,
                            item.stop_sequence,
                            item.expected_departure,
                            item.raw_departure,
                            item.sample_kind,
                            list(item.footnote_markers),
                            item.section_version_id,
                        )
                        for item in selected
                    ],
                    page_size=200,
                )
                cursor.execute(
                    """
                    INSERT INTO timetable_source_events (
                      check_run_id, event_type, details
                    ) VALUES (%s, 'audit_plan_created', %s)
                    """,
                    (
                        check_run_id,
                        psycopg2.extras.Json(
                            {
                                "audit_run_id": audit_run_id,
                                "audit_week": week.isoformat(),
                                "sample_count": len(selected),
                                "reconciliation": reconciliation,
                            }
                        ),
                    ),
                )
                return {
                    "status": "created",
                    "audit_run_id": audit_run_id,
                    "sample_count": len(selected),
                    "reconciliation": reconciliation,
                }

    def record_event(
        self,
        *,
        event_type: str,
        details: Mapping[str, Any],
        check_run_id: Optional[int] = None,
        source_id: Optional[int] = None,
        source_version_id: Optional[int] = None,
        actor: str = "system",
    ) -> None:
        with self.connection:
            with self.connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO timetable_source_events (
                      source_id, source_version_id, check_run_id,
                      event_type, actor, details
                    ) VALUES (%s, %s, %s, %s, %s, %s)
                    """,
                    (
                        source_id,
                        source_version_id,
                        check_run_id,
                        event_type,
                        actor,
                        psycopg2.extras.Json(dict(details)),
                    ),
                )


__all__ = [
    "DEFAULT_SCHEMA_PATH",
    "IncompleteCatalogueError",
    "StagedVersion",
    "TimetableRepository",
]
