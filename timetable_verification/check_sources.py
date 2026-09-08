"""Daily official-source check and weekly audit-plan entry point."""

from __future__ import annotations

import argparse
import json
import os
import time
import traceback
from typing import Any, Dict, List, Mapping, Optional, Sequence

from .adapters import GabsAdapter, MyCitiAdapter, OperatorAdapter
from .audit import DEFAULT_AUDIT_SAMPLE_SIZE
from .canonical import content_sha256, extraction_metadata, sha256_bytes
from .http import DEFAULT_MIN_INTERVAL_SECONDS, PoliteRequester, RequestFailure
from .repository import IncompleteCatalogueError, TimetableRepository


def _env_float(name: str, default: float) -> float:
    value = os.environ.get(name)
    return float(value) if value not in (None, "") else default


def _env_int(name: str, default: int) -> int:
    value = os.environ.get(name)
    return int(value) if value not in (None, "") else default


def selected_adapters(operator: str) -> List[OperatorAdapter]:
    adapters: List[OperatorAdapter] = [MyCitiAdapter(), GabsAdapter()]
    if operator == "all":
        return adapters
    expected = "MyCiti" if operator.casefold() == "myciti" else "GABS"
    return [adapter for adapter in adapters if adapter.operator == expected]


class DailyChecker:
    def __init__(
        self,
        *,
        repository: TimetableRepository,
        requester: PoliteRequester,
        adapters: Sequence[OperatorAdapter],
        audit_sample_size: int = DEFAULT_AUDIT_SAMPLE_SIZE,
    ) -> None:
        self.repository = repository
        self.requester = requester
        self.adapters = list(adapters)
        self.audit_sample_size = max(100, int(audit_sample_size))

    def run(self) -> Mapping[str, Any]:
        self.repository.ensure_schema()
        if hasattr(self.repository, "migrate_gabs_sections"):
            self.repository.migrate_gabs_sections()
        run_id = self.repository.start_check_run()
        counts = {
            "discovered": 0,
            "downloaded": 0,
            "unchanged": 0,
            "changed": 0,
            "failed": 0,
        }
        operator_results: Dict[str, Any] = {}
        audit_failed = False
        try:
            for adapter in self.adapters:
                result = self._check_operator(adapter, run_id, counts)
                operator_results[adapter.operator] = result

            try:
                audit_result = self.repository.ensure_weekly_audit_plan(
                    check_run_id=run_id,
                    target_sample_size=self.audit_sample_size,
                )
                operator_results["weekly_audit"] = dict(audit_result)
                # A shortfall is expected during first-run bootstrap while all
                # downloaded sources await manual approval. Preserve it as an
                # evidence warning, but do not report a healthy daily source
                # check as failed. Exceptions in audit planning remain fatal.
                audit_failed = False
            except Exception as exc:
                audit_failed = True
                operator_results["weekly_audit"] = {
                    "status": "failed",
                    "error": str(exc),
                }
                try:
                    self.repository.record_event(
                        event_type="audit_plan_failed",
                        check_run_id=run_id,
                        details={"error": str(exc)[:10000]},
                    )
                except Exception:
                    pass

            if counts["failed"] == 0 and not audit_failed:
                status = "succeeded"
            elif counts["downloaded"] or counts["discovered"]:
                status = "partial_failure"
            else:
                status = "failed"
            error = None
            if status != "succeeded":
                error = "One or more source checks or the weekly audit plan require attention."
            self.repository.finish_check_run(
                run_id,
                status=status,
                counts=counts,
                operator_results=operator_results,
                error=error,
            )
            return {
                "run_id": run_id,
                "status": status,
                "counts": counts,
                "operator_results": operator_results,
            }
        except Exception as exc:
            self.repository.fail_running_check(
                run_id,
                "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))[:10000],
            )
            raise

    def _check_operator(
        self,
        adapter: OperatorAdapter,
        run_id: int,
        counts: Dict[str, int],
    ) -> Mapping[str, Any]:
        result = {
            "discovered": 0,
            "downloaded": 0,
            "unchanged": 0,
            "changed": 0,
            "failed": 0,
            "missing": 0,
            "warnings": [],
        }
        try:
            sources = adapter.discover(self.requester)
        except Exception as exc:
            result["failed"] = 1
            result["error"] = str(exc)
            counts["failed"] += 1
            return result

        result["discovered"] = len(sources)
        counts["discovered"] += len(sources)
        for source in sources:
            source_row: Optional[Mapping[str, Any]] = None
            response = None
            pdf_hash = None
            started = time.monotonic()
            try:
                source_row = self.repository.upsert_discovered_source(
                    source,
                    parser_version=adapter.parser_version,
                )
                if source.discovery_warnings:
                    warning_details = {
                        "source_key": source.source_key,
                        "selected_url": source.url,
                        "alternate_urls": list(source.alternate_urls),
                        "warnings": list(source.discovery_warnings),
                    }
                    result["warnings"].append(warning_details)
                    self.repository.record_event(
                        event_type="catalogue_source_candidates_reviewed",
                        check_run_id=run_id,
                        source_id=int(source_row["id"]),
                        details=warning_details,
                    )
                response = self.requester.get_pdf(
                    source.url,
                    referer=source.catalogue_page,
                )
                counts["downloaded"] += 1
                result["downloaded"] += 1
                pdf_hash = sha256_bytes(response.body)
                if adapter.operator == "GABS" and hasattr(adapter, "parse_document"):
                    try:
                        document = adapter.parse_document(source, response.body)
                    except Exception as exc:
                        document = {"sections": [], "issues": [{"error": str(exc), "pages": []}], "complete": False}
                    staged = self.repository.stage_document(
                        run_id=run_id, source=source, source_id=int(source_row["id"]),
                        pdf_bytes=response.body, pdf_sha256=pdf_hash, document=document,
                        http_etag=response.headers.get("etag"),
                        http_last_modified=response.headers.get("last-modified"),
                        parser_version=adapter.parser_version,
                    )
                    outcome = staged["outcome"]
                    counts[outcome] += 1
                    result[outcome] += 1
                    for field in ("changed", "unchanged", "failed"):
                        result["sections_" + field] = result.get("sections_" + field, 0) + staged[field]
                    if staged["failed"]:
                        counts["failed"] += 1
                        result["failed"] += 1
                    self.repository.record_check_result(
                        run_id=run_id, source=source, source_id=int(source_row["id"]),
                        outcome="failed" if staged["failed"] else outcome,
                        http_status=response.status, pdf_sha256=pdf_hash,
                        duration_ms=max(0, int((time.monotonic() - started) * 1000)),
                        error="One or more document sections need attention." if staged["failed"] else None,
                    )
                    continue
                try:
                    extraction = adapter.parse_pdf(source, response.body)
                except Exception as parse_error:
                    self.repository.stage_parse_failure(
                        run_id=run_id,
                        source=source,
                        source_id=int(source_row["id"]),
                        pdf_bytes=response.body,
                        pdf_sha256=pdf_hash,
                        error=str(parse_error),
                        http_etag=response.headers.get("etag"),
                        http_last_modified=response.headers.get("last-modified"),
                        parser_version=adapter.parser_version,
                    )
                    counts["changed"] += 1
                    result["changed"] += 1
                    raise
                staged = self.repository.stage_download(
                    run_id=run_id,
                    source=source,
                    source_id=int(source_row["id"]),
                    pdf_bytes=response.body,
                    pdf_sha256=pdf_hash,
                    content_sha256=content_sha256(extraction),
                    extraction=extraction,
                    http_etag=response.headers.get("etag"),
                    http_last_modified=response.headers.get("last-modified"),
                    parser_version=adapter.parser_version,
                )
                counts[staged.outcome if staged.outcome == "unchanged" else "changed"] += 1
                result[staged.outcome if staged.outcome == "unchanged" else "changed"] += 1
                self.repository.record_check_result(
                    run_id=run_id,
                    source=source,
                    source_id=int(source_row["id"]),
                    outcome=staged.outcome,
                    http_status=response.status,
                    pdf_sha256=pdf_hash,
                    duration_ms=max(0, int((time.monotonic() - started) * 1000)),
                )
            except Exception as exc:
                counts["failed"] += 1
                result["failed"] += 1
                status = exc.status if isinstance(exc, RequestFailure) else (
                    response.status if response else None
                )
                try:
                    self.repository.record_check_result(
                        run_id=run_id,
                        source=source,
                        source_id=int(source_row["id"]) if source_row else None,
                        outcome="failed",
                        http_status=status,
                        pdf_sha256=pdf_hash,
                        duration_ms=max(0, int((time.monotonic() - started) * 1000)),
                        error=str(exc),
                    )
                except Exception as record_error:
                    result.setdefault("result_recording_errors", []).append(str(record_error))

        try:
            missing = self.repository.mark_missing_sources(
                run_id=run_id,
                operator=adapter.operator,
                discovered_keys=[source.source_key for source in sources],
            )
        except IncompleteCatalogueError as exc:
            result["failed"] += 1
            counts["failed"] += 1
            result["catalogue_coverage_error"] = str(exc)
            return result
        result["missing"] = missing
        if missing:
            result["failed"] += missing
            counts["failed"] += missing
        return result


def dry_run(
    requester: PoliteRequester,
    adapters: Sequence[OperatorAdapter],
    *,
    limit: Optional[int] = None,
) -> Mapping[str, Any]:
    operator_results: Dict[str, Any] = {}
    failures = 0
    for adapter in adapters:
        sources = adapter.discover(requester)
        if limit is not None:
            sources = sources[: max(0, limit)]
        summaries = []
        for source in sources:
            try:
                response = requester.get_pdf(source.url, referer=source.catalogue_page)
                if adapter.operator == "GABS" and hasattr(adapter, "parse_document"):
                    document = adapter.parse_document(source, response.body)
                    failures += sum(bool(s.get("error")) for s in document["sections"]) + len(document["issues"])
                    summaries.append({"source_key": source.source_key, "url": source.url,
                        "pdf_sha256": sha256_bytes(response.body), "issues": document["issues"],
                        "sections": [{k: v for k, v in section.items() if k != "extraction"}
                                     for section in document["sections"]]})
                    continue
                extraction = adapter.parse_pdf(source, response.body)
                summaries.append(
                    {
                        "source_key": source.source_key,
                        "url": source.url,
                        "pdf_sha256": sha256_bytes(response.body),
                        "content_sha256": content_sha256(extraction),
                        "alternate_urls": list(source.alternate_urls),
                        "discovery_warnings": list(source.discovery_warnings),
                        **extraction_metadata(extraction),
                    }
                )
            except Exception as exc:
                failures += 1
                summaries.append(
                    {
                        "source_key": source.source_key,
                        "url": source.url,
                        "error": str(exc),
                    }
                )
        operator_results[adapter.operator] = {
            "discovered": len(sources),
            "sources": summaries,
        }
    return {
        "status": "succeeded" if failures == 0 else "failed",
        "dry_run": True,
        "operator_results": operator_results,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Check official MyCiTi and GABS PDFs and stage changes for review."
    )
    parser.add_argument(
        "--operator",
        choices=("all", "myciti", "gabs"),
        default="all",
        help="operator catalogue to check (default: all)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="download, fingerprint, and parse without database writes",
    )
    parser.add_argument(
        "--limit",
        type=int,
        help="limit PDFs per operator (dry-run only)",
    )
    parser.add_argument(
        "--database-url",
        default=os.environ.get("DATABASE_URL"),
        help="PostgreSQL URL (defaults to DATABASE_URL)",
    )
    parser.add_argument(
        "--min-request-interval",
        type=float,
        default=_env_float(
            "TIMETABLE_REQUEST_INTERVAL_SECONDS",
            DEFAULT_MIN_INTERVAL_SECONDS,
        ),
        help="seconds between requests to the same host; values below 1.5 are clamped",
    )
    parser.add_argument(
        "--request-jitter",
        type=float,
        default=_env_float("TIMETABLE_REQUEST_JITTER_SECONDS", 0.25),
        help="maximum random seconds added to host pacing (default: 0.25)",
    )
    parser.add_argument(
        "--retries",
        type=int,
        default=_env_int("TIMETABLE_HTTP_RETRIES", 3),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=_env_float("TIMETABLE_HTTP_TIMEOUT_SECONDS", 60.0),
    )
    parser.add_argument(
        "--audit-sample-size",
        type=int,
        default=_env_int(
            "TIMETABLE_AUDIT_SAMPLE_SIZE",
            DEFAULT_AUDIT_SAMPLE_SIZE,
        ),
        help="weekly sample target (default: 200; minimum: 100)",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.limit is not None and not args.dry_run:
        raise SystemExit("--limit is only allowed with --dry-run")
    requester = PoliteRequester(
        min_interval_seconds=args.min_request_interval,
        jitter_seconds=args.request_jitter,
        retries=args.retries,
        timeout_seconds=args.timeout,
    )
    adapters = selected_adapters(args.operator)
    repository = None
    try:
        if args.dry_run:
            result = dry_run(requester, adapters, limit=args.limit)
        else:
            if not args.database_url:
                raise SystemExit("DATABASE_URL or --database-url is required")
            repository = TimetableRepository.connect(args.database_url)
            result = DailyChecker(
                repository=repository,
                requester=requester,
                adapters=adapters,
                audit_sample_size=args.audit_sample_size,
            ).run()
        print(json.dumps(result, ensure_ascii=False, sort_keys=True, default=str))
        return 0 if result["status"] == "succeeded" else 1
    finally:
        if repository is not None:
            repository.close()


if __name__ == "__main__":
    raise SystemExit(main())
