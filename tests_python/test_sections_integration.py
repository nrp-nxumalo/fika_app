"""Real PostgreSQL + Node publisher tests. Set FIKA_SECTION_TEST_DSN to an isolated test database."""
import copy
import json
import os
import subprocess
import unittest
import uuid
from pathlib import Path

import psycopg2
import psycopg2.extras

from timetable_verification.adapters import DiscoveredSource
from timetable_verification.repository import TimetableRepository
from timetable_verification.migrate_sections import migrate_gabs_sections
from timetable_verification.canonical import sha256_bytes
from timetable_verification.audit import build_extraction_candidates, reconcile_with_published
from tests_python.test_sections import document_from_pages, page

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(os.environ.get('FIKA_SECTION_TEST_DSN'), 'isolated PostgreSQL DSN not configured')
class SectionDatabaseTest(unittest.TestCase):
    def setUp(self):
        self.schema = 'fika_sections_' + uuid.uuid4().hex
        self.connection = psycopg2.connect(os.environ['FIKA_SECTION_TEST_DSN'])
        self.connection.autocommit = True
        with self.connection.cursor() as c:
            c.execute(f'CREATE SCHEMA {self.schema}')
            c.execute(f'SET search_path TO {self.schema}')
            c.execute('''CREATE TABLE routes(id serial PRIMARY KEY,name text,code text,agency text,effective_date date);
                CREATE TABLE directions(id serial PRIMARY KEY,route_id integer REFERENCES routes(id),direction text,code text);
                CREATE TABLE stops(id serial PRIMARY KEY,name text,agency text);
                CREATE TABLE trips(id serial PRIMARY KEY,direction_id integer REFERENCES directions(id),
                  monday boolean,tuesday boolean,wednesday boolean,thursday boolean,friday boolean,
                  saturday boolean,sunday boolean,public_holiday boolean);
                CREATE TABLE stop_times(id serial PRIMARY KEY,sequence integer,departure time,arrival time,
                  stop_id integer REFERENCES stops(id),trip_id integer REFERENCES trips(id),stop_time_type text);''')
        self.connection.autocommit = False
        self.repository = TimetableRepository(self.connection)
        self.repository.ensure_schema()
        self.run_id = self.repository.start_check_run()

    def tearDown(self):
        self.connection.rollback()
        self.connection.autocommit = True
        with self.connection.cursor() as c:
            c.execute(f'DROP SCHEMA {self.schema} CASCADE')
        self.connection.close()

    def rows(self, sql, args=()):
        with self.connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as c:
            c.execute(sql,args)
            result = [dict(r) for r in c.fetchall()] if c.description else []
        self.connection.commit()
        return result

    def stage(self, pages, key='004901', salt=''):
        source=DiscoveredSource('GABS',key,f'https://example.test/{key}.pdf')
        source_id=self.repository.upsert_discovered_source(source)['id']
        data=('\n'.join(pages)+salt).encode()
        document=document_from_pages(pages,key)
        result=self.repository.stage_document(run_id=self.run_id,source=source,source_id=source_id,
            pdf_bytes=data,pdf_sha256=sha256_bytes(data),document=document,
            http_etag=None,http_last_modified=None,parser_version='test-sections/1')
        return source_id,result

    def node(self, body, payload=None, succeeds=True):
        self.connection.commit()
        config=self.connection.get_dsn_parameters()
        node_config={k:config[k] for k in ['host','port','user','password','dbname'] if k in config}
        node_config['database']=node_config.pop('dbname')
        node_config['options']='-csearch_path='+self.schema
        env={**os.environ,'FIKA_SECTION_TEST_NODE_CONFIG':json.dumps(node_config),'FIKA_SECTION_TEST_PAYLOAD':json.dumps(payload or {})}
        script="const {Pool}=require('pg'); const db=new Pool(JSON.parse(process.env.FIKA_SECTION_TEST_NODE_CONFIG)); const p=JSON.parse(process.env.FIKA_SECTION_TEST_PAYLOAD); (async()=>{try{"+body+"}finally{await db.end();}})().catch(e=>{console.error(e.message);process.exitCode=1});"
        result=subprocess.run(['node','-e',script],cwd=ROOT,env=env,capture_output=True,text=True,timeout=30)
        if succeeds:
            self.assertEqual(result.returncode,0,result.stderr)
        else:
            self.assertNotEqual(result.returncode,0,result.stdout)
        return result

    def approve(self, number, source_id=None, override=False, succeeds=True, version_id=None):
        values=[number]
        condition='timetable_number=%s'
        if source_id:
            condition+=' AND source_id=%s';values.append(source_id)
        row=self.rows('SELECT * FROM timetable_sections WHERE '+condition+' ORDER BY id LIMIT 1',values)[0]
        result=self.node("const {approveSection}=require('./lib/timetableSectionPublisher'); const {currentCapeTownDate}=require('./lib/timetablePublisher'); console.log(JSON.stringify(await approveSection(db,{...p,verifiedOn:currentCapeTownDate(),reviewer:'integration',note:'Compared source columns'})));",
            {'sectionId':row['id'],'versionId':version_id or row['pending_version_id'],'overrideSource':override},succeeds)
        return row,result

    def test_independent_approval_change_failure_and_audit_provenance(self):
        source_id,_=self.stage([page('004901'),page('005001','BELLVILLE - KENRIDGE')])
        row,_=self.approve('004901')
        self.assertEqual([r['code'] for r in self.rows('SELECT code FROM routes')],['0049'])
        before=self.rows('SELECT * FROM trips')
        stable=self.rows('SELECT approved_version_id FROM timetable_sections WHERE id=%s',(row['id'],))[0]
        _,result=self.stage([page('004901'),page('005001','BELLVILLE - KENRIDGE',raw='06:00b')])
        self.assertEqual(result['failed'],1)
        self.assertEqual(self.rows('SELECT approved_version_id FROM timetable_sections WHERE id=%s',(row['id'],))[0],stable)
        self.assertEqual(self.rows('SELECT * FROM trips'),before)
        self.approve('005001',succeeds=False)
        versions=self.repository.approved_versions()
        candidates=build_extraction_candidates(versions)
        departures=self.repository.published_departures([v['source_version_id'] for v in versions])
        reconciled,_=reconcile_with_published(candidates,departures)
        self.assertEqual(len(reconciled),2)
        self.assertTrue(all(c.section_version_id for c in reconciled))
        self.node("const {getPublicReliabilityReport}=require('./lib/timetableReliabilityReport');const r=await getPublicReliabilityReport(db); if(r.sections.length!==2)throw Error('missing sections');")

    def test_unchanged_pdf_bytes_create_evidence_without_pending_changes(self):
        source_id,_=self.stage([page('004901')])
        self.approve('004901')
        trips=self.rows('SELECT * FROM trips')
        _,result=self.stage([page('004901')],salt='regenerated metadata')
        self.assertEqual(result['changed'],0)
        row=self.rows('SELECT * FROM timetable_sections')[0]
        self.assertIsNone(row['pending_version_id'])
        self.assertEqual(row['status'],'verified')
        self.assertEqual(self.rows('SELECT * FROM trips'),trips)
        self.assertEqual(len(self.rows('SELECT * FROM timetable_section_observations')),2)

    def test_conflicting_own_route_requires_override_and_withdrawal_restores_fallback(self):
        own,_=self.stage([page('005001','BELLVILLE - KENRIDGE')],key='005001')
        self.approve('005001',own)
        mixed,_=self.stage([page('004901'),page('005001','BELLVILLE - KENRIDGE',raw='06:30a')])
        self.approve('005001',mixed,succeeds=False)
        row,_=self.approve('005001',mixed,override=True)
        active=self.rows('SELECT * FROM timetable_sections WHERE id=%s',(row['id'],))[0]
        self.assertEqual(str(self.rows('SELECT min(departure) AS departure FROM stop_times')[0]['departure']),'06:30:00')
        self.stage([page('004901'),page('005001','BELLVILLE - KENRIDGE',raw='06:40a')])
        self.approve('005001',mixed,succeeds=False)
        self.assertEqual(str(self.rows('SELECT min(departure) AS departure FROM stop_times')[0]['departure']),'06:30:00')
        self.node("const {withdrawSection}=require('./lib/timetableSectionPublisher');await withdrawSection(db,{...p,reviewer:'integration',note:'Withdraw mixed copy'});",{'sectionId':row['id'],'versionId':active['approved_version_id']})
        self.assertEqual(str(self.rows('SELECT min(departure) AS departure FROM stop_times')[0]['departure']),'06:00:00')
        self.assertEqual(self.rows("SELECT status FROM timetable_sections WHERE timetable_number='004901'")[0]['status'],'changed_review_required')

    def test_stale_approval_rolls_back_and_route_name_is_preserved(self):
        self.stage([page('004901')])
        old=self.rows('SELECT * FROM timetable_sections')[0]
        self.stage([page('004901',raw='06:10a')])
        self.approve('004901',version_id=old['pending_version_id'],succeeds=False)
        self.assertFalse(self.rows('SELECT * FROM trips'))
        self.rows("INSERT INTO routes(name,code,agency) VALUES ('Existing route name','0049','GABS')")
        self.approve('004901')
        self.assertEqual(self.rows('SELECT name FROM routes')[0]['name'],'Existing route name')

    def test_migration_preserves_times_and_is_idempotent(self):
        # Seed a legacy approved document through the unchanged legacy publisher.
        source=DiscoveredSource('GABS','004901','https://example.test/004901.pdf')
        source_id=self.repository.upsert_discovered_source(source)['id']
        self.rows('UPDATE timetable_sources SET section_mode=false WHERE id=%s',(source_id,))
        extraction=document_from_pages([page('004901')])['sections'][0]['extraction']
        from timetable_verification.canonical import content_sha256
        result=self.repository.stage_download(run_id=self.run_id,source=source,source_id=source_id,pdf_bytes=b'legacy',
            pdf_sha256=sha256_bytes(b'legacy'),content_sha256=content_sha256(extraction),extraction=extraction,
            http_etag=None,http_last_modified=None)
        self.node("const {approvePendingVersion,currentCapeTownDate}=require('./lib/timetablePublisher');await approvePendingVersion(db,{...p,reviewer:'legacy',note:'Previously reviewed',verifiedOn:currentCapeTownDate()});",{'sourceId':source_id,'versionId':result.version_id})
        before=self.rows('SELECT id,departure,arrival,sequence FROM stop_times ORDER BY id')
        self.assertEqual(migrate_gabs_sections(self.repository),1)
        self.assertEqual(migrate_gabs_sections(self.repository),0)
        self.assertEqual(self.rows('SELECT id,departure,arrival,sequence FROM stop_times ORDER BY id'),before)
        self.assertTrue(self.rows('SELECT timetable_section_version_id FROM trips')[0]['timetable_section_version_id'])
        self.stage([page('004901')])
        self.assertIsNone(self.rows('SELECT pending_version_id FROM timetable_sections')[0]['pending_version_id'])

    def test_duplicate_copy_keeps_one_publication_and_one_logical_alert(self):
        first,_=self.stage([page('004901')])
        # Another catalogue document contains the same section plus its own section.
        other,_=self.stage([page('004901'),page('004902','TOWN CENTRE - TAFELSIG')],key='004902')
        self.node("const {readSectionReviews}=require('./lib/timetableSectionReview');const g=(await readSectionReviews(db)).find(g=>g.timetable_number==='004901');if(g.change_alert_count!==1||g.variants[0].copies.length!==2)throw Error('duplicate alerts');")
        self.approve('004901',first)
        self.approve('004901',other)
        self.assertEqual(len(self.rows('SELECT * FROM trips')),1)

    def test_stored_review_fingerprints_match_publisher_and_report_without_full_extractions(self):
        self.stage([page('004901'), page('005001', 'BELLVILLE - KENRIDGE')])
        self.node("""const {reviewSummary,readSectionReviews}=require('./lib/timetableSectionReview');
          const {stableJson}=require('./lib/timetableSectionPublisher');
          const {rows}=await db.query('SELECT extraction,review_summary FROM timetable_section_versions');
          for(const row of rows) if(stableJson(reviewSummary(row.extraction))!==stableJson(row.review_summary)) throw Error('fingerprints differ');
          const groups=await readSectionReviews(db,{publicOnly:true});
          if(groups.some(g=>g.copies.some(c=>c.extraction))) throw Error('loaded full extraction for public summary');""")

    def test_download_failure_is_reported_without_withdrawing_usable_sections(self):
        source_id,_ = self.stage([page('004901')])
        self.approve('004901')
        before = self.rows('SELECT * FROM trips')
        self.repository.record_check_result(run_id=self.run_id,source_id=source_id,
            source=DiscoveredSource('GABS','004901','https://example.test/004901.pdf'),
            outcome='failed',http_status=404,error='HTTP 404')
        self.node("""const {getPublicReliabilityReport}=require('./lib/timetableReliabilityReport');
          const r=await getPublicReliabilityReport(db);
          if(r.sources[0].latest_document_check.http_status!==404)throw Error('missing download failure');
          if(!r.sections[0].copies[0].published)throw Error('usable section hidden');""")
        self.assertEqual(self.rows('SELECT * FROM trips'), before)

    def test_section_withdrawal_and_reappearance_require_a_new_exact_revision(self):
        self.stage([page('004901')])
        row,_=self.approve('004901')
        original=self.rows('SELECT approved_version_id FROM timetable_sections')[0]['approved_version_id']
        self.node("const {withdrawSection}=require('./lib/timetableSectionPublisher');await withdrawSection(db,{...p,reviewer:'integration',note:'Withdraw this copy'});",{'sectionId':row['id'],'versionId':original})
        self.stage([page('004901')])
        current=self.rows('SELECT * FROM timetable_sections')[0]
        self.assertNotEqual(current['pending_version_id'],original)
        self.assertEqual(current['status'],'changed_review_required')
        self.assertFalse(self.rows('SELECT * FROM trips'))
        self.approve('004901')
        self.assertEqual(len(self.rows('SELECT * FROM trips')),1)

    def test_changed_sibling_clears_only_its_route_cache_and_preserves_missing_service(self):
        self.stage([page('004901'),page('005001','BELLVILLE - KENRIDGE')])
        self.approve('004901');self.approve('005001')
        tafelsig=self.rows("SELECT t.* FROM trips t JOIN directions d ON d.id=t.direction_id JOIN routes r ON r.id=d.route_id WHERE r.code='0049'")
        self.rows('CREATE TABLE api_response_cache(cache_key text PRIMARY KEY,route_id integer)')
        self.rows("INSERT INTO api_response_cache SELECT code,id FROM routes")
        self.rows("INSERT INTO api_response_cache VALUES ('schedules:v1',NULL)")
        self.stage([page('004901'),page('005001','BELLVILLE - KENRIDGE',raw='06:20a')])
        self.approve('005001')
        self.assertEqual([r['cache_key'] for r in self.rows('SELECT cache_key FROM api_response_cache')],['0049'])
        self.assertEqual(self.rows("SELECT t.* FROM trips t JOIN directions d ON d.id=t.direction_id JOIN routes r ON r.id=d.route_id WHERE r.code='0049'"),tafelsig)
        before=self.rows('SELECT * FROM trips ORDER BY id')
        self.stage([page('004901')])
        self.assertTrue(self.rows("SELECT missing_from_document FROM timetable_sections WHERE timetable_number='005001'")[0]['missing_from_document'])
        self.assertEqual(self.rows('SELECT * FROM trips ORDER BY id'),before)

    def test_audit_mismatch_stays_reviewable_when_content_is_unchanged(self):
        self.stage([page('004901')]);self.approve('004901')
        self.rows("UPDATE timetable_sections SET audit_review_required=true,status='changed_review_required'")
        self.stage([page('004901')])
        row=self.rows('SELECT * FROM timetable_sections')[0]
        self.assertTrue(row['pending_version_id'])
        self.assertEqual(row['status'],'changed_review_required')
        self.approve('004901')
        self.assertFalse(self.rows('SELECT audit_review_required FROM timetable_sections')[0]['audit_review_required'])

    def test_captured_reparse_preserves_real_download_date(self):
        from timetable_verification.reparse_sections import reparse_captured
        from tests_python.test_adapters import fixture_bytes
        from timetable_verification.adapters import GabsAdapter
        source=DiscoveredSource('GABS','004901','https://example.test/gone.pdf')
        source_id=self.repository.upsert_discovered_source(source)['id']
        data=fixture_bytes('gabs_004901_mixed.pdf.b64')
        self.repository.stage_document(run_id=self.run_id,source=source,source_id=source_id,pdf_bytes=data,
            pdf_sha256=sha256_bytes(data),document=GabsAdapter().parse_document(source,data),
            http_etag=None,http_last_modified=None,parser_version='old-parser',downloaded_at='2026-09-07T01:00:00Z')
        before=self.rows('SELECT last_downloaded_at FROM timetable_sources')[0]
        result=reparse_captured(self.repository,'004901')
        self.assertEqual(result[0]['changed'],0)
        self.assertEqual(self.rows('SELECT last_downloaded_at FROM timetable_sources')[0],before)
        self.assertFalse(self.rows('SELECT * FROM trips'))

    def check_evidence(self, source_id, key='004901', outcome='changed'):
        self.repository.record_check_result(run_id=self.run_id, source_id=source_id,
            source=DiscoveredSource('GABS', key, f'https://example.test/{key}.pdf'),
            outcome=outcome, http_status=200 if outcome != 'failed' else 404)
        self.rows("UPDATE timetable_source_check_runs SET operator_results=%s::jsonb WHERE id=%s",
            (json.dumps({'GABS': {'discovered': 2}}), self.run_id))

    def decide(self, number='004901', **options):
        return self.node("""const {loadTimetableStates,changeTimetable}=require('./lib/gabsTimetableWorkflow');
          const {reviewSnapshot}=require('./lib/gabsTimetablePolicy');
          const [s]=await loadTimetableStates(db,{number:p.number});
          const result=await changeTimetable(db,{reviewer:'integration',note:'Reviewed timetable',
            snapshot:reviewSnapshot(s.rows,s.control),...p});console.log(JSON.stringify(result));""",
          {'number': number, **options})

    def automate(self, dry_run=False):
        result = self.node("const {runAutomaticReviews}=require('./lib/gabsTimetableWorkflow');console.log(JSON.stringify(await runAutomaticReviews(db,p)));",
            {'runId': self.run_id, 'dryRun': dry_run})
        return json.loads(result.stdout)

    def test_timetable_approval_groups_identical_copies_and_preserves_direction_dates(self):
        first = page('004901').replace('2026/09/07', '2026/09/01')
        second = page('004902', 'TOWN CENTRE - TAFELSIG').replace('2026/09/07', '2026/09/14')
        a, _ = self.stage([first, second])
        b, _ = self.stage([first, second], key='004902')
        dates = self.rows('SELECT source_key,source_effective_date::text AS date FROM timetable_sources ORDER BY source_key')
        self.assertEqual([r['date'] for r in dates], ['2026-09-01', '2026-09-14'])
        self.decide()
        states = self.rows("SELECT status,pending_version_id,approved_version_id FROM timetable_sections WHERE timetable_number='004901'")
        self.assertTrue(all(r['status'] == 'verified' and r['approved_version_id'] and not r['pending_version_id'] for r in states))
        self.assertEqual(len(self.rows('SELECT * FROM trips')), 1)
        self.assertEqual(len(self.rows("SELECT * FROM timetable_sections WHERE timetable_number='004902' AND pending_version_id IS NOT NULL")), 2)
        self.node("""const {readSectionReviews,groupRouteReviews}=require('./lib/timetableSectionReview');
          const routes=groupRouteReviews(await readSectionReviews(db));
          if(routes.length!==1||routes[0].timetables.length!==2)throw Error('duplicate routes');
          const copies=routes[0].timetables[0].copies;
          if(copies[0].effective_date!=='2026-09-01'||copies.find(c=>c.catalogue_key==='004902').catalogue_effective_date!=='2026-09-14')throw Error('date leakage');""")

    def test_automatic_time_update_is_atomic_auditable_and_idempotent(self):
        source, _ = self.stage([page('004901')]); self.decide()
        verified = self.rows('SELECT last_manually_verified_on FROM timetable_sections')[0]
        self.rows('CREATE TABLE api_response_cache(cache_key text PRIMARY KEY,route_id integer)')
        self.rows("INSERT INTO api_response_cache SELECT code,id FROM routes")
        self.rows("INSERT INTO api_response_cache VALUES ('schedules:v1',NULL)")
        self.stage([page('004901', raw='06:05a')]); self.check_evidence(source)
        before = self.rows('SELECT * FROM trips')
        preview = self.automate(dry_run=True)
        self.assertEqual(preview['automatic'], 1)
        self.assertEqual(self.rows('SELECT * FROM trips'), before)
        result = self.automate()
        self.assertEqual(result['automatic'], 1)
        self.assertEqual(result['failed'], 0)
        self.assertEqual(str(self.rows('SELECT departure FROM stop_times ORDER BY sequence')[0]['departure']), '06:05:00')
        self.assertEqual(self.rows('SELECT last_manually_verified_on FROM timetable_sections')[0], verified)
        self.assertFalse(self.rows('SELECT * FROM api_response_cache'))
        version = self.rows("SELECT * FROM timetable_section_versions WHERE review_status='approved'")[0]
        self.assertEqual(version['approval_method'], 'automatic')
        self.assertEqual(version['approved_by'], 'gabs-automation')
        self.assertTrue(version['approval_policy_version'])
        after = self.rows('SELECT * FROM trips')
        self.automate()
        self.assertEqual(self.rows('SELECT * FROM trips'), after)
        self.assertEqual(len(self.rows("SELECT * FROM timetable_source_events WHERE event_type='timetable_auto_approved'")), 1)
        candidates = build_extraction_candidates(self.repository.approved_versions())
        reconciled, _ = reconcile_with_published(candidates, self.repository.published_departures([version['document_version_id']]))
        self.assertEqual(len(reconciled), 2)

    def test_identical_new_catalogue_evidence_keeps_live_trip_ids(self):
        source, _ = self.stage([page('004901')]); self.decide()
        before = self.rows('SELECT * FROM trips')
        other, _ = self.stage([page('004901'),page('004902','TOWN CENTRE - TAFELSIG')], key='004902')
        self.check_evidence(source); self.check_evidence(other, '004902')
        result = self.automate()
        self.assertEqual(result['failed'], 0)
        self.assertEqual(self.rows('SELECT * FROM trips'), before)
        self.assertTrue(self.rows("SELECT approved_version_id FROM timetable_sections WHERE source_id=%s AND timetable_number='004901'", (other,))[0]['approved_version_id'])
        self.assertFalse(self.rows("SELECT published_at FROM timetable_section_versions WHERE approval_method='automatic'")[0]['published_at'])

    def test_withdrawal_hold_covers_all_copies_and_newly_discovered_evidence(self):
        first, _ = self.stage([page('004901'),page('004902','TOWN CENTRE - TAFELSIG')])
        self.stage([page('004901')], key='004902')
        self.decide(); self.decide('004902')
        sibling = self.rows("SELECT t.* FROM trips t JOIN directions d ON d.id=t.direction_id WHERE d.code='02'")
        self.decide(withdraw=True)
        self.assertEqual(self.rows('SELECT * FROM trips'), sibling)
        self.assertTrue(self.rows('SELECT withdrawn FROM timetable_review_controls WHERE timetable_number=%s', ('004901',))[0]['withdrawn'])
        new, _ = self.stage([page('004901'),page('009901','C - D')], key='009901')
        self.check_evidence(new, '009901')
        self.stage([page('004901'),page('004902','TOWN CENTRE - TAFELSIG')]); self.check_evidence(first)
        self.assertFalse(self.automate()['timetables'][0]['published'])
        self.assertEqual(self.rows('SELECT * FROM trips'), sibling)
        self.decide(restore=True)
        self.assertEqual(len(self.rows('SELECT * FROM trips')), 2)
        self.assertEqual(self.rows("SELECT t.* FROM trips t JOIN directions d ON d.id=t.direction_id WHERE d.code='02'"), sibling)
        self.assertFalse(self.rows('SELECT withdrawn FROM timetable_review_controls WHERE timetable_number=%s', ('004901',))[0]['withdrawn'])

    def test_stale_timetable_snapshot_rolls_back_entire_decision(self):
        self.stage([page('004901')])
        snapshot = self.node("const {loadTimetableStates}=require('./lib/gabsTimetableWorkflow');const {reviewSnapshot}=require('./lib/gabsTimetablePolicy');const [s]=await loadTimetableStates(db);console.log(reviewSnapshot(s.rows,s.control));").stdout.strip()
        self.stage([page('004901', raw='06:10a')])
        self.node("const {changeTimetable}=require('./lib/gabsTimetableWorkflow');await changeTimetable(db,{...p,number:'004901',reviewer:'reviewer',note:'stale'});",
            {'snapshot': snapshot}, succeeds=False)
        self.assertFalse(self.rows('SELECT * FROM trips'))
        self.assertFalse(self.rows("SELECT * FROM timetable_section_versions WHERE review_status='approved'"))

    def test_failed_competing_download_blocks_auto_but_unrelated_failure_does_not(self):
        source, _ = self.stage([page('004901')]); self.decide()
        other, _ = self.stage([page('004901'),page('009901','C - D')], key='009901')
        self.stage([page('004901', raw='06:05a')]); self.check_evidence(source)
        self.check_evidence(other, '009901', 'failed')
        before = self.rows('SELECT * FROM trips')
        self.assertEqual(self.automate()['automatic'], 0)
        self.assertEqual(self.rows('SELECT * FROM trips'), before)
        self.stage([page('004901'),page('009901','C - D')], key='009901'); self.check_evidence(other, '009901')
        unrelated, _ = self.stage([page('008801','E - F')], key='008801')
        self.check_evidence(unrelated, '008801', 'failed')
        result = self.automate()
        self.assertEqual(result['automatic'], 1)
        self.assertEqual(result['failed'], 0)

    def test_due_date_checks_do_not_publish_future_sections(self):
        source, _ = self.stage([page('004901')]); self.decide()
        future = page('004901', raw='06:05a').replace('2026/09/07','2099/01/01')
        self.stage([future]); self.check_evidence(source)
        before = self.rows('SELECT * FROM trips')
        self.assertEqual(self.automate()['scheduled'], 1)
        self.assertEqual(self.rows('SELECT * FROM trips'), before)
        self.stage([page('004901', raw='06:05a')]); self.check_evidence(source)
        self.assertEqual(self.automate()['automatic'], 1)

    def test_explicit_source_selection_and_regular_holiday_families_coexist(self):
        a, _ = self.stage([page('004901')]); self.decide()
        holiday = page('004901', raw='08:00').replace('MONDAYS TO FRIDAYS', 'PUBLIC HOLIDAYS')
        b, _ = self.stage([holiday, page('004902','TOWN CENTRE - TAFELSIG')], key='004902')
        self.decide()
        self.assertEqual(len(self.rows('SELECT * FROM trips')), 2)
        self.stage([page('004901',raw='06:15a')]); self.check_evidence(a); self.check_evidence(b, '004902')
        self.assertEqual(self.automate()['automatic'], 1)
        self.assertEqual(len(self.rows('SELECT * FROM trips WHERE public_holiday')), 1)
        self.stage([page('004901',raw='06:30a'),page('004902','TOWN CENTRE - TAFELSIG')], key='004902')
        pending = self.rows("SELECT pending_version_id FROM timetable_sections WHERE source_id=%s AND timetable_number='004901'",(b,))[0]['pending_version_id']
        self.decide(selectedVersionId=str(pending))
        self.assertTrue(self.rows('SELECT source_override FROM timetable_section_versions WHERE id=%s',(pending,))[0]['source_override'])

    def test_publication_error_rolls_back_all_identical_copies(self):
        source, _ = self.stage([page('004901')]); self.decide()
        self.stage([page('004901',raw='06:05a')]); self.check_evidence(source)
        before = self.rows('SELECT * FROM trips')
        self.rows("""CREATE FUNCTION fail_trip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated write failure'; END $$""")
        self.rows('CREATE TRIGGER fail_trip BEFORE INSERT ON trips FOR EACH ROW EXECUTE FUNCTION fail_trip()')
        result = self.automate()
        self.assertEqual(result['failed'], 1)
        self.assertEqual(self.rows('SELECT * FROM trips'), before)
        self.assertTrue(self.rows('SELECT pending_version_id FROM timetable_sections')[0]['pending_version_id'])
        self.assertFalse(self.rows("SELECT * FROM timetable_source_events WHERE event_type='timetable_auto_approved'"))

    def test_daily_runner_records_decisions_while_disabled_then_publishes_when_enabled(self):
        from unittest.mock import patch
        source, _ = self.stage([page('004901')]); self.decide()
        self.stage([page('004901', raw='06:05a')]); self.check_evidence(source)
        before = self.rows('SELECT * FROM trips')
        # The real cron gets its schema through the connection configuration.
        connection = psycopg2.connect(os.environ['FIKA_SECTION_TEST_DSN'], options='-csearch_path=' + self.schema)
        repository = TimetableRepository(connection)
        try:
            with patch.dict(os.environ, {'GABS_AUTO_APPROVE': '0'}):
                result = repository.review_gabs_timetables(self.run_id, {'discovered': 1})
            self.assertFalse(result['publishing_enabled'])
            self.assertEqual(self.rows('SELECT * FROM trips'), before)
            self.assertEqual(self.rows("SELECT review_decision FROM timetable_section_versions WHERE review_status='pending'")[0]['review_decision']['state'], 'eligible')
            with patch.dict(os.environ, {'GABS_AUTO_APPROVE': '1'}):
                result = repository.review_gabs_timetables(self.run_id, {'discovered': 1})
            self.assertTrue(result['publishing_enabled'])
            self.assertEqual(result['failed'], 0)
            self.assertNotEqual(self.rows('SELECT * FROM trips'), before)
        finally:
            connection.close()

    def test_auto_review_retains_audit_mismatch_and_structural_changes(self):
        source, _ = self.stage([page('004901')]); self.decide()
        before = self.rows('SELECT * FROM trips')
        self.rows("UPDATE timetable_sections SET audit_review_required=true,status='changed_review_required'")
        self.stage([page('004901')]); self.check_evidence(source)
        self.assertEqual(self.automate()['manual_review'], 1)
        self.assertEqual(self.rows('SELECT * FROM trips'), before)
        self.assertTrue(self.rows('SELECT audit_review_required FROM timetable_sections')[0]['audit_review_required'])
        self.decide()
        self.stage([page('004901').replace('| TAFELSIG |','| ANOTHER STOP |')]); self.check_evidence(source)
        self.assertEqual(self.automate()['manual_review'], 1)
        self.assertEqual(self.rows('SELECT * FROM trips'), before)

    def test_new_check_or_incomplete_catalogue_blocks_runner(self):
        source, _ = self.stage([page('004901')]); self.decide()
        self.stage([page('004901',raw='06:05a')]); self.check_evidence(source)
        before = self.rows('SELECT * FROM trips')
        self.rows("UPDATE timetable_source_check_runs SET operator_results=%s::jsonb WHERE id=%s",
            (json.dumps({'GABS': {'discovered': 1, 'catalogue_coverage_error': 'incomplete'}}), self.run_id))
        self.node("const {runAutomaticReviews}=require('./lib/gabsTimetableWorkflow');await runAutomaticReviews(db,p);",
            {'runId': self.run_id, 'dryRun': False}, succeeds=False)
        self.assertEqual(self.rows('SELECT * FROM trips'), before)
