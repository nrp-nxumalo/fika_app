import copy
import unittest
from unittest.mock import patch

from timetable_verification.adapters import GabsAdapter, DiscoveredSource
from timetable_verification.sections import parse_gabs_document, scan_pages
from timetable_verification.canonical import content_sha256
from tests_python.test_adapters import fixture_bytes


def document_from_pages(pages, key='004901'):
    class Page:
        def __init__(self, text): self.text = text
        def extract_text(self): return self.text
    class PDF:
        def __enter__(self): self.pages = [Page(t) for t in pages]; return self
        def __exit__(self, *args): pass
    with patch('timetable_verification.sections.pdfplumber.open', return_value=PDF()):
        return parse_gabs_document(DiscoveredSource('GABS',key,'https://example.test/'+key+'.pdf'), b'pdf')


def page(number, title='TAFELSIG - TOWN CENTRE', definition='Mondays', raw='06:00a'):
    return f'{title}\nMONDAYS TO FRIDAYS EFFECTIVE DATE: 2026/09/07 TIMETABLE NUMBER: {number}\n| TAFELSIG |{raw}|\n| TOWN CENTRE |07:00|\nABBREVIATIONS\na - {definition}\nPAGE: 1'


class SectionParsingTest(unittest.TestCase):
    def test_supplied_patterns_keep_monday_and_friday_departures(self):
        doc = GabsAdapter().parse_document(DiscoveredSource('GABS','004501','https://example.test/004501.pdf'), fixture_bytes('gabs_004501_patterns.pdf.b64'))
        section = next(s for s in doc['sections'] if s['timetable_number']=='004502')
        self.assertEqual(section['pages'], [3,4])
        trips = section['extraction']['routes'][0]['directions'][0]['services'][0]['trips']
        self.assertEqual(sum('monday' in t['service_days'] for t in trips),25)
        self.assertEqual(sum('friday' in t['service_days'] for t in trips),22)
        at_one = [t for t in trips if 'monday' in t['service_days'] and t['times'][0]['time']=='13:00']
        self.assertEqual(len(at_one),2)
        self.assertEqual({next(c['stop_name'] for c in reversed(t['times']) if c['stop_time_type']!='not_served') for t in at_one}, {'HARARE','MAKHAZA'})
        patterns = {next(c['stop_name'] for c in reversed(t['times']) if c['stop_time_type']!='not_served'): t['service_days'] for t in at_one}
        self.assertEqual(patterns['HARARE'], ['monday','tuesday','wednesday','thursday','friday'])
        self.assertEqual(patterns['MAKHAZA'], ['monday','tuesday','wednesday','thursday'])

    def test_mixed_pdf_is_independently_valid(self):
        doc=GabsAdapter().parse_document(DiscoveredSource('GABS','004901','https://example.test/004901.pdf'), fixture_bytes('gabs_004901_mixed.pdf.b64'))
        self.assertTrue(doc['complete'])
        self.assertEqual([s['timetable_number'] for s in doc['sections']],['004901','005001'])
        self.assertEqual(len(doc['sections'][0]['extraction']['routes'][0]['directions'][0]['services'][0]['trips']),35)

    def test_footnote_meaning_and_failure_are_local(self):
        doc=document_from_pages([page('004901'), page('005001','BELLVILLE - KENRIDGE','Fridays')])
        self.assertTrue(doc['complete'])
        self.assertEqual([s['extraction']['routes'][0]['directions'][0]['services'][0]['trips'][0]['service_days'] for s in doc['sections']], [['monday'],['friday']])
        bad=document_from_pages([page('004901'),page('005001','BELLVILLE - KENRIDGE',raw='06:00b')])
        self.assertFalse(bad['complete'])
        self.assertIn('extraction',bad['sections'][0])
        self.assertIn('undefined',bad['sections'][1]['error'])

    def test_hash_ignores_siblings_and_physical_page_position(self):
        one=document_from_pages([page('004901')])['sections'][0]
        many=document_from_pages([page('005001','BELLVILLE - KENRIDGE'),page('004901')])['sections'][0]
        self.assertNotEqual(one['pages'],many['pages'])
        self.assertEqual(one['content_sha256'],many['content_sha256'])

    def test_repeated_sections_coalesce_only_when_identical(self):
        same=document_from_pages([page('004901'),page('004901')])
        self.assertTrue(same['complete'])
        self.assertEqual(same['sections'][0]['pages'],[1,2])
        conflict=document_from_pages([page('004901'),page('004901',raw='06:01a'),page('005001','BELLVILLE - KENRIDGE')])
        self.assertIn('conflicting',conflict['sections'][0]['error'])
        self.assertIn('extraction',conflict['sections'][1])

    def test_mixed_headerless_identity_is_not_invented(self):
        headerless='UNKNOWN - ROUTE\nMONDAYS TO FRIDAYS\n| A |08:00|\n| B |09:00|'
        doc=document_from_pages([page('004901'),page('005001','BELLVILLE - KENRIDGE'),headerless])
        self.assertTrue(doc['issues'])
        self.assertEqual(len(doc['sections']),2)
        possible_mixed = document_from_pages([page('004901'),headerless])
        self.assertTrue(possible_mixed['issues'])
        self.assertEqual([s['timetable_number'] for s in possible_mixed['sections']], ['004901'])

    def test_repeated_continuation_page_keeps_columns_and_page_evidence(self):
        first = page('004901')
        continuation = page('004901', raw='08:00a').replace('07:00', '09:00').replace('PAGE: 1', 'PAGE: 2')
        once = document_from_pages([first, continuation])['sections'][0]
        repeated = document_from_pages([first, continuation, continuation])['sections'][0]
        self.assertEqual(once['content_sha256'], repeated['content_sha256'])
        self.assertEqual(repeated['pages'], [1, 2, 3])
        self.assertEqual(len(repeated['extraction']['routes'][0]['directions'][0]['services'][0]['trips']), 2)

    def test_malformed_header_or_cell_blocks_only_identified_sibling(self):
        malformed = page('005001', 'BELLVILLE - KENRIDGE').replace('2026/09/07', 'unknown')
        doc = document_from_pages([page('004901'), malformed])
        self.assertIn('extraction', doc['sections'][0])
        self.assertEqual(doc['sections'][1]['timetable_number'], '005001')
        self.assertIn('malformed header', doc['sections'][1]['error'])
        bad_cell = document_from_pages([page('004901'), page('005001', 'BELLVILLE - KENRIDGE', raw='26:00')])
        self.assertIn('extraction', bad_cell['sections'][0])
        self.assertIn('unrecognized cell', bad_cell['sections'][1]['error'])
        no_title = document_from_pages([page('004901'), '\n'.join(page('005001').splitlines()[1:])])
        self.assertIn('extraction', no_title['sections'][0])
        self.assertIn('error', no_title['sections'][1])

    def test_trip_day_and_via_changes_are_reviewable(self):
        from timetable_verification.diff import compare_extractions
        original=document_from_pages([page('004901')])['sections'][0]['extraction']
        changed=copy.deepcopy(original)
        changed['routes'][0]['directions'][0]['services'][0]['trips'][0]['service_days']=['tuesday']
        self.assertNotEqual(content_sha256(original),content_sha256(changed))
        self.assertTrue(compare_extractions(original,changed)['structural_changes']['trip_patterns']['changed'])
