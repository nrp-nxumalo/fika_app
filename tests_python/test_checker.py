import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from timetable_verification.adapters.base import DiscoveredSource, OperatorAdapter
from timetable_verification.check_sources import DailyChecker, main
from timetable_verification.http import HttpResponse, RequestFailure
from timetable_verification.repository import IncompleteCatalogueError, StagedVersion


class FakeAdapter(OperatorAdapter):
    def __init__(self, operator, *, discovery_error=None, parse_error=None):
        self.operator = operator
        self.discovery_error = discovery_error
        self.parse_error = parse_error

    def discover(self, _requester):
        if self.discovery_error:
            raise self.discovery_error
        return [
            DiscoveredSource(
                operator=self.operator,
                source_key="A1",
                url=f"https://{self.operator.casefold()}.test/A1-timetable.pdf",
            )
        ]

    def parse_pdf(self, source, _pdf_bytes):
        if self.parse_error:
            raise self.parse_error
        direction_code = source.source_key if self.operator == "MyCiti" else "01"
        return {
            "schema_version": 1,
            "operator": self.operator,
            "source_key": source.source_key,
            "publication_scope": "route" if self.operator == "MyCiti" else "service_days",
            "effective_date": None,
            "routes": [
                {
                    "code": source.source_key,
                    "name": "Origin - Destination",
                    "directions": [
                        {
                            "code": direction_code,
                            "name": "To Destination",
                            "effective_date": None,
                            "services": [
                                {
                                    "label": "MONDAYS TO FRIDAYS",
                                    "service_days": ["monday"],
                                    "footnotes": [],
                                    "trips": [
                                        {
                                            "footnote_markers": [],
                                            "service_days": ["monday"],
                                            "times": [
                                                {
                                                    "sequence": 0,
                                                    "stop_name": "Origin",
                                                    "time": "06:00",
                                                    "raw_time": "06:00",
                                                    "stop_time_type": "scheduled",
                                                }
                                            ],
                                        }
                                    ],
                                }
                            ],
                        }
                    ],
                }
            ],
        }


class FakeRequester:
    def get_pdf(self, url, referer=None):
        del referer
        return HttpResponse(url, 200, {}, b"%PDF-fake", 1)


class FakeRepository:
    def __init__(self, *, severe_drop=False, audit_result=None):
        self.severe_drop = severe_drop
        self.audit_result = audit_result or {"status": "existing", "audit_run_id": 8}
        self.results = []
        self.parse_failures = []
        self.staged = []
        self.finished = None

    def assert_schema(self):
        pass

    def start_check_run(self):
        return 41

    def finish_check_run(self, run_id, **kwargs):
        self.finished = (run_id, kwargs)

    def fail_running_check(self, *_args):
        raise AssertionError("the orchestrator should contain operator failures")

    def upsert_discovered_source(self, source, **_kwargs):
        return {"id": 9, "source_key": source.source_key}

    def stage_download(self, **kwargs):
        self.staged.append(kwargs)
        return StagedVersion(9, 12, "new", {})

    def stage_parse_failure(self, **kwargs):
        self.parse_failures.append(kwargs)
        return StagedVersion(9, 13, "new", {"parse_error": kwargs["error"]})

    def record_check_result(self, **kwargs):
        self.results.append(kwargs)

    def mark_missing_sources(self, **_kwargs):
        if self.severe_drop:
            raise IncompleteCatalogueError("catalogue returned 2 of 100; no sources were marked missing")
        return 0

    def ensure_weekly_audit_plan(self, **_kwargs):
        return self.audit_result

    def record_event(self, **_kwargs):
        pass


class DailyCheckerTest(unittest.TestCase):
    def test_download_failure_logs_url_and_http_status_and_continues(self):
        class Requester(FakeRequester):
            def get_pdf(self, url, referer=None):
                if 'myciti' in url:
                    raise RequestFailure('PDF not found', status=404)
                return super().get_pdf(url, referer)

        logs = []
        result = DailyChecker(repository=FakeRepository(), requester=Requester(),
            adapters=[FakeAdapter('MyCiti'), FakeAdapter('GABS')], log=logs.append).run()

        failure = next(row for row in logs if row['event'] == 'source_failed')
        self.assertEqual(failure['stage'], 'download')
        self.assertEqual(failure['http_status'], 404)
        self.assertEqual(failure['url'], 'https://myciti.test/A1-timetable.pdf')
        self.assertEqual(failure['error'], 'PDF not found')
        self.assertEqual(result['operator_results']['MyCiti']['failure_counts'], {'download': 1})
        self.assertEqual(result['counts']['downloaded'], 1)
        self.assertEqual(result['status'], 'partial_failure')

    def test_section_errors_include_actual_reason_and_pages_in_logs_and_database(self):
        document = {'sections': [
            {'timetable_number': '004901', 'pages': [1], 'extraction': {}},
            {'timetable_number': '005001', 'pages': [2], 'error': 'ambiguous time 06:00b'},
        ], 'issues': [{'pages': [3], 'error': 'unrecognized heading'}], 'complete': False}

        class Adapter(FakeAdapter):
            def parse_document(self, source, data):
                return document

        class Repository(FakeRepository):
            def stage_document(self, **kwargs):
                self.document = kwargs['document']
                return {'outcome': 'changed', 'changed': 1, 'unchanged': 0, 'failed': 2}

        repository, logs = Repository(), []
        result = DailyChecker(repository=repository, requester=FakeRequester(),
            adapters=[Adapter('GABS')], log=logs.append).run()

        errors = [row for row in logs if row['event'] == 'section_parse_failed']
        self.assertEqual(len(errors), 2)
        self.assertEqual(errors[0]['timetable_number'], '005001')
        self.assertEqual(errors[0]['pages'], [2])
        self.assertEqual(errors[0]['error'], 'ambiguous time 06:00b')
        self.assertEqual(json.loads(repository.results[0]['error'])[1]['error'], 'unrecognized heading')
        self.assertEqual(repository.document, document)
        self.assertEqual(result['counts']['failed'], 1)
        self.assertEqual(result['operator_results']['GABS']['sections_failed'], 2)
        self.assertEqual(result['operator_results']['GABS']['failure_counts'], {'parse': 1})

    def test_cli_logs_remain_compact_with_large_catalogue_and_preserve_exit_codes(self):
        class Adapter(FakeAdapter):
            def discover(self, requester):
                return [DiscoveredSource('MyCiti', 'A1', 'https://myciti.test/A1.pdf',
                    alternate_urls=tuple('https://myciti.test/copy.pdf' for _ in range(10000)),
                    discovery_warnings=('many copies',))]

        for parse_error, exit_code in [(None, 0), (ValueError('layout changed'), 1)]:
            with self.subTest(parse_error=parse_error):
                repository = FakeRepository()
                repository.close = lambda: None
                output = io.StringIO()
                with patch('timetable_verification.check_sources.TimetableRepository.connect', return_value=repository), \
                     patch('timetable_verification.check_sources.PoliteRequester', return_value=FakeRequester()), \
                     patch('timetable_verification.check_sources.selected_adapters', return_value=[Adapter('MyCiti', parse_error=parse_error)]), \
                     redirect_stdout(output):
                    actual_exit = main(['--database-url', 'unused'])
                self.assertEqual(actual_exit, exit_code)
                lines = output.getvalue().splitlines()
                self.assertTrue(all(len(line) < 3000 for line in lines))
                summary = json.loads(lines[-1])
                self.assertEqual(summary['operator_results']['MyCiti']['warnings_count'], 1)
                self.assertNotIn('alternate_urls', output.getvalue())
                persisted = repository.finished[1]['operator_results']['MyCiti']
                self.assertEqual(len(persisted['warnings'][0]['alternate_urls']), 10000)
                if parse_error:
                    self.assertIn('layout changed', output.getvalue())

    def test_bootstrap_audit_shortfall_is_recorded_without_failing_source_check(self):
        repository = FakeRepository(audit_result={
            "status": "shortfall",
            "shortfalls": ["approved and published samples are not available"],
        })
        checker = DailyChecker(
            repository=repository,
            requester=FakeRequester(),
            adapters=[FakeAdapter("MyCiti")],
        )

        result = checker.run()

        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["operator_results"]["weekly_audit"]["status"], "shortfall")

    def test_one_operator_discovery_failure_does_not_stop_the_other(self):
        repository = FakeRepository()
        checker = DailyChecker(
            repository=repository,
            requester=FakeRequester(),
            adapters=[
                FakeAdapter("MyCiti", discovery_error=RuntimeError("offline")),
                FakeAdapter("GABS"),
            ],
        )
        result = checker.run()
        self.assertEqual(result["status"], "partial_failure")
        self.assertEqual(result["operator_results"]["MyCiti"]["failed"], 1)
        self.assertEqual(result["operator_results"]["GABS"]["changed"], 1)
        self.assertEqual(len(repository.staged), 1)

    def test_parse_failure_is_both_captured_change_and_failure(self):
        repository = FakeRepository()
        checker = DailyChecker(
            repository=repository,
            requester=FakeRequester(),
            adapters=[FakeAdapter("MyCiti", parse_error=ValueError("layout changed"))],
        )
        result = checker.run()
        self.assertEqual(result["counts"]["changed"], 1)
        self.assertEqual(result["counts"]["failed"], 1)
        self.assertEqual(len(repository.parse_failures), 1)
        self.assertEqual(repository.parse_failures[0]["pdf_bytes"], b"%PDF-fake")
        self.assertEqual(repository.results[0]["outcome"], "failed")

    def test_severe_catalogue_drop_is_a_failure_but_marks_nothing_missing(self):
        repository = FakeRepository(severe_drop=True)
        checker = DailyChecker(
            repository=repository,
            requester=FakeRequester(),
            adapters=[FakeAdapter("GABS")],
        )
        result = checker.run()
        operator = result["operator_results"]["GABS"]
        self.assertEqual(operator["missing"], 0)
        self.assertEqual(operator["failed"], 1)
        self.assertIn("no sources were marked missing", operator["catalogue_coverage_error"])

    def test_automation_runs_after_staging_and_before_audit(self):
        order = []
        class Repository(FakeRepository):
            def review_gabs_timetables(self, run_id, operator_result):
                self.asserted_count = len(self.staged)
                order.append('automation')
                return {'automatic': 1, 'failed': 0}
            def ensure_weekly_audit_plan(self, **kwargs):
                order.append('audit')
                return super().ensure_weekly_audit_plan(**kwargs)
        repository = Repository()
        result = DailyChecker(repository=repository, requester=FakeRequester(),
            adapters=[FakeAdapter('GABS'), FakeAdapter('MyCiti')]).run()
        self.assertEqual(order, ['automation', 'audit'])
        self.assertEqual(repository.asserted_count, 2)
        self.assertEqual(result['operator_results']['gabs_automation']['automatic'], 1)

    def test_automation_failure_is_reported_and_audit_still_runs(self):
        class Repository(FakeRepository):
            def review_gabs_timetables(self, *args):
                raise RuntimeError('publisher unavailable')
        result = DailyChecker(repository=Repository(), requester=FakeRequester(),
            adapters=[FakeAdapter('GABS')]).run()
        self.assertEqual(result['status'], 'partial_failure')
        self.assertIn('weekly_audit', result['operator_results'])
        self.assertEqual(result['operator_results']['gabs_automation']['failed'], 1)


if __name__ == "__main__":
    unittest.main()
