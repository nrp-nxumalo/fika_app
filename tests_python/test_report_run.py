import unittest
from unittest.mock import MagicMock, patch

from timetable_verification.report_run import main, report_run


class ReportRunTest(unittest.TestCase):
    def test_read_only_report_includes_old_source_section_and_automation_errors(self):
        connection = MagicMock()
        cursor = connection.cursor.return_value.__enter__.return_value
        cursor.fetchone.return_value = {
            'id': 41, 'status': 'partial_failure', 'sources_failed': 3,
            'operator_results': {
                'GABS': {'failed': 2, 'warnings': [{'alternate_urls': ['copy.pdf']}]},
                'gabs_automation': {'failed': 1, 'timetables': [
                    {'number': '004901', 'error': 'publication failed'}]},
                'weekly_audit': {'status': 'failed', 'error': 'audit unavailable'},
            },
        }
        cursor.fetchall.side_effect = [
            [{'source_key': '004901', 'outcome': 'failed', 'error': 'HTTP 404'},
             {'source_key': '005001', 'outcome': 'missing', 'error': None}],
            [{'source_key': '006001', 'pages': [2], 'error': 'ambiguous footnote'}],
        ]
        logs = []

        report_run(connection, log=logs.append)

        connection.set_session.assert_called_once_with(readonly=True)
        self.assertEqual([row['event'] for row in logs], [
            'saved_check_run', 'saved_source_failure', 'saved_source_failure',
            'saved_section_failure', 'saved_automation_failure'])
        self.assertEqual(logs[0]['operator_results']['weekly_audit']['error'], 'audit unavailable')
        self.assertNotIn('warnings', logs[0]['operator_results']['GABS'])
        self.assertEqual(logs[-1]['error'], 'publication failed')
        self.assertTrue(all(call.args[0].lstrip().startswith('SELECT')
                            for call in cursor.execute.call_args_list))
        self.assertEqual(cursor.execute.call_args_list[0].args[1], (None,))
        self.assertEqual(cursor.execute.call_args_list[1].args[1], (41,))

    def test_unknown_run_fails_and_cli_closes_connection(self):
        connection = MagicMock()
        connection.cursor.return_value.__enter__.return_value.fetchone.return_value = None
        with patch('timetable_verification.report_run.psycopg2.connect', return_value=connection):
            with self.assertRaisesRegex(ValueError, 'No matching'):
                main(['--database-url', 'unused', '--run-id', '42'])
        connection.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
