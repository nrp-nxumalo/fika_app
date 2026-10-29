const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('pg');
const { getTimetableStatus } = require('../lib/timetableStatus');
const { POLICY_VERSION } = require('../lib/gabsTimetablePolicy');

// Opt in against a local database. All fixtures live in pg_temp inside a rolled
// back transaction: no application table or schema is created or migrated.
test('status SQL reads exact published provenance and projected legacy changes in PostgreSQL', {
  skip: !process.env.FIKA_STATUS_TEST_DATABASE,
}, async () => {
  const db = new Client({ database: process.env.FIKA_STATUS_TEST_DATABASE,
    host: process.env.FIKA_STATUS_TEST_HOST || '/tmp', user: process.env.USER, port: 5432 });
  await db.connect();
  try {
    await db.query('BEGIN');
    await db.query('SET LOCAL search_path=pg_temp');
    await db.query("SET LOCAL statement_timeout='5s'");
    await db.query('SET LOCAL jit=off');
    await db.query(`
      CREATE TEMP TABLE routes(id bigint PRIMARY KEY,agency text,code text);
      CREATE TEMP TABLE directions(id bigint PRIMARY KEY,route_id bigint,direction text,code text,
        timetable_source_id bigint,timetable_source_version_id bigint);
      CREATE TEMP TABLE trips(id bigint PRIMARY KEY,direction_id bigint,timetable_service_family text,
        timetable_source_id bigint,timetable_source_version_id bigint,timetable_section_version_id bigint,
        timetable_effective_date date,monday boolean,tuesday boolean,wednesday boolean,thursday boolean,
        friday boolean,saturday boolean,sunday boolean,public_holiday boolean);
      CREATE TEMP TABLE timetable_sources(id bigint PRIMARY KEY,source_key text,section_mode boolean,
        status text,pending_version_id bigint);
      CREATE TEMP TABLE timetable_source_versions(id bigint PRIMARY KEY,source_id bigint,source_url text,
        source_effective_date date,extraction jsonb,comparison jsonb,review_status text);
      CREATE TEMP TABLE timetable_sections(id bigint PRIMARY KEY,source_id bigint,timetable_number text,
        status text,approved_version_id bigint,pending_version_id bigint);
      CREATE TEMP TABLE timetable_section_versions(id bigint PRIMARY KEY,section_id bigint,document_version_id bigint,
        content_sha256 text,parse_error text,review_status text,source_override boolean,policy_summary jsonb,extraction jsonb);
      CREATE TEMP TABLE timetable_review_controls(timetable_number text PRIMARY KEY,withdrawn boolean);
      INSERT INTO routes VALUES(1,'GABS','0049'),(2,'MyCiti','214A');
      INSERT INTO directions VALUES(1,1,'A - B','01',1,10),(2,2,'To B','out',2,20);
      INSERT INTO trips(id,direction_id,timetable_service_family,timetable_source_id,timetable_source_version_id,
        timetable_section_version_id,timetable_effective_date,monday) VALUES(1,1,'weekday',1,10,100,'2026-09-01',true),(2,2,NULL,2,20,NULL,'2026-09-01',true);
      INSERT INTO timetable_sources VALUES(1,'004901',true,'changed_review_required',11),(2,'214A',false,'changed_review_required',21);
      INSERT INTO timetable_sections VALUES(1,1,'004901','changed_review_required',100,101);
      INSERT INTO timetable_source_versions(id,source_id,source_url,source_effective_date) VALUES
        (10,1,'https://www.gabs.co.za/A_from_20260901_to_20261013_004901.pdf','2026-09-01'),
        (11,1,'https://www.gabs.co.za/A_from_20261101_to_99999999_004901.pdf','2026-11-01');
    `);
    for (const [id, effective, hash] of [[100, '2026-09-01', 'old'], [101, '2026-11-01', 'new']]) {
      await db.query(`INSERT INTO timetable_section_versions VALUES($1,1,$2,$3,NULL,$4,false,$5,NULL)`,
        [id, id === 100 ? 10 : 11, hash, id === 100 ? 'approved' : 'pending', {
          policy_version: POLICY_VERSION, effective_date: effective, families: { weekday: {
            unchanged_sha256: hash, content_sha256: hash, structure_sha256: 'same', service_days: ['monday'],
          } },
        }]);
    }
    for (const [id, time] of [[20, '06:00'], [21, '06:30']]) {
      await db.query(`INSERT INTO timetable_source_versions VALUES($1,2,'https://www.myciti.org.za/214A.pdf',
        '2026-09-01',$2,'{}',$3)`, [id, { effective_date: '2026-09-01', routes: [{ code: '214A', name: 'A - B',
        directions: [{ code: 'out', name: 'To B', services: [{ service_days: ['monday'], trips: [
          { service_days: ['monday'], times: [{ stop_name: 'A', time }] },
        ] }] }] }] }, id === 20 ? 'approved' : 'pending']);
    }
    const result = await getTimetableStatus(db, { now: new Date('2026-10-14T12:00:00Z') });
    assert.equal(result.routes.length, 2);
    const goldenArrow = result.routes.find(route => route.agency === 'GABS').directions[0];
    assert.equal(goldenArrow.expired, true);
    assert.equal(goldenArrow.pending, true);
    assert.equal(goldenArrow.pending_effective_date, '2026-11-01');
    assert.equal(result.routes.find(route => route.agency === 'MyCiti').directions[0].pending, true);

    // Historical documents must never be expanded or grouped with the live
    // and pending versions, even when there are many saved revisions.
    await db.query(`INSERT INTO timetable_source_versions(id,source_id,extraction)
      SELECT id,2,'{"routes":"not an array"}'::jsonb FROM generate_series(1000,1200) id`);
    // Multiple trips sharing a published contribution collapse before joining
    // document/section JSON. Direction provenance still supplies null trip IDs.
    await db.query(`INSERT INTO trips(id,direction_id,monday,tuesday)
      SELECT id,2,true,true FROM generate_series(1000,31000) id`);
    // Pending documents for unpublished routes must not be parsed. A large
    // registry used to trigger a second scan of every trip for this work.
    await db.query(`INSERT INTO timetable_sources
      SELECT id,id::text,false,'changed_review_required',id FROM generate_series(2000,3000) id;
      INSERT INTO timetable_source_versions(id,source_id,extraction,review_status)
      SELECT id,id,'{"routes":"not an array"}'::jsonb,'pending' FROM generate_series(2000,3000) id;`);
    const expanded = await getTimetableStatus(db, { now: new Date('2026-10-14T12:00:00Z') });
    assert.equal(expanded.routes.length, 2);
    const myciti = expanded.routes.find(route => route.agency === 'MyCiti');
    assert.equal(myciti.directions.find(direction => direction.service_days.includes('monday')).pending, true);
    assert.equal(myciti.directions.find(direction => direction.service_days.includes('tuesday')).pending, false);
    await db.query(`UPDATE timetable_source_versions SET extraction=(
      SELECT extraction FROM timetable_source_versions WHERE id=20) WHERE id=21`);
    const unchanged = await getTimetableStatus(db);
    assert.ok(unchanged.routes.find(route => route.agency === 'MyCiti').directions.every(direction => !direction.pending));
    await db.query('UPDATE timetable_sections SET pending_version_id=NULL');
    await db.query("UPDATE timetable_sources SET pending_version_id=NULL WHERE NOT section_mode");
    const cleared = await getTimetableStatus(db);
    assert.ok(cleared.routes.every(route => route.directions.every(direction => !direction.pending)));
  } finally {
    await db.query('ROLLBACK');
    await db.end();
  }
});
