const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');
const { migrate } = require('../scripts/migrate-timetables');
const { enqueuePublication, executePublication, runNextPublication } = require('../lib/timetablePublicationJobs');
const { refreshNextCache, refreshRouteCache } = require('../lib/timetableCacheRefresh');
const { clearAffectedApiCache } = require('../lib/timetablePublisher');
const { readAdminReviewPage } = require('../lib/timetableAdminPageData');
const { API_CACHE_PAYLOAD_KINDS: KINDS, getApiCacheKey } = require('../lib/apiCache');
const DATABASE = process.env.FIKA_PUBLICATION_TEST_DATABASE;
const silent = { log(){}, error(){} };

async function fixture(run) {
  const config = { host: process.env.FIKA_PUBLICATION_TEST_HOST || '/tmp', database: DATABASE,
    user: process.env.USER, connectionTimeoutMillis: 5000, options: '-c jit=off' };
  const admin = new Pool(config);
  const schema = 'publication_test_'+randomBytes(8).toString('hex');
  let db,worker;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    db = new Pool({ ...config, max: 2, options: `-c search_path=${schema} -c jit=off` });
    worker = new Pool({ ...config, max: 1, options: `-c search_path=${schema} -c jit=off` });
    await db.query(`CREATE TABLE routes(id serial PRIMARY KEY,name text,code text,agency text,effective_date date);
      CREATE TABLE directions(id serial PRIMARY KEY,route_id integer REFERENCES routes(id),direction text,code text);
      CREATE TABLE stops(id serial PRIMARY KEY,name text,agency text);
      CREATE TABLE trips(id serial PRIMARY KEY,direction_id integer REFERENCES directions(id),
        monday boolean,tuesday boolean,wednesday boolean,thursday boolean,friday boolean,saturday boolean,sunday boolean,public_holiday boolean);
      CREATE TABLE stop_times(id serial PRIMARY KEY,sequence integer,departure time,arrival time,
        stop_id integer REFERENCES stops(id),trip_id integer REFERENCES trips(id),stop_time_type text);`);
    await migrate(db);
    await db.query('DELETE FROM timetable_cache_refreshes');
    await run({db,worker,schema,config});
  } finally {
    await Promise.all([db?.end(),worker?.end()]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}

async function seed(db, tripCount=148, stopCount=20) {
  const days=['monday','tuesday','wednesday','thursday','friday'];
  const extraction={schema_version:1,operator:'MyCiti',source_key:'route-214a',publication_scope:'route',effective_date:'2026-01-01',
    routes:[{code:'214A',name:'PARKLANDS - TABLE VIEW',directions:[{code:'214a',name:'To Marine Circle',effective_date:'2026-01-01',
      services:[{label:'Weekdays',service_days:days,footnotes:[],trips:Array.from({length:tripCount},(_,t)=>({
        footnote_markers:[],service_days:days,times:Array.from({length:stopCount},(_,i)=>({sequence:i,stop_name:'Stop '+i,
          time:`${String(5+Math.floor((t+i)%600/60)).padStart(2,'0')}:${String((t+i)%60).padStart(2,'0')}`,
          raw_time:`${String(5+Math.floor((t+i)%600/60)).padStart(2,'0')}:${String((t+i)%60).padStart(2,'0')}`,
          stop_time_type:'scheduled'}))}))}]}]}]};
  const source=(await db.query(`INSERT INTO timetable_sources(operator,source_key,official_source_url,parser_version,import_version)
    VALUES ('MyCiti','route-214a','https://example.test/test.pdf','test','test') RETURNING id;`)).rows[0].id;
  const version=(await db.query(`INSERT INTO timetable_source_versions(source_id,pdf_sha256,content_sha256,source_url,
    source_effective_date,parser_version,import_version,extraction,comparison,pdf_bytes,pdf_size_bytes)
    VALUES ($1,$2,$3,'https://example.test/test.pdf','2026-01-01','test','test',$4::jsonb,$5::jsonb,$6,1) RETURNING id;`,
  [source,'a'.repeat(64),'b'.repeat(64),JSON.stringify(extraction),JSON.stringify({has_changes:false,changed_time_count:0,added_time_count:0,removed_time_count:0}),Buffer.from('x')])).rows[0].id;
  await db.query('UPDATE timetable_sources SET pending_version_id=$1 WHERE id=$2',[version,source]);
  return { sourceId:Number(source),versionId:Number(version),reviewer:'integration',note:'Reviewed PDF evidence' };
}
const status=async(db,id)=>(await db.query('SELECT * FROM timetable_publication_jobs WHERE id=$1',[id])).rows[0];
const count=async(db,table)=>Number((await db.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};

test('queued publishing remains responsive, deduplicates submissions, commits atomically and rebuilds only affected caches', {skip:!DATABASE,timeout:20_000}, async()=>fixture(async({db,worker})=>{
  const payload=await seed(db);
  const job=await enqueuePublication(db,'source_approve',payload,'/admin/timetable-reliability');
  assert.equal((await enqueuePublication(db,'source_approve',payload,'/admin/timetable-reliability')).id,job.id);
  const started=gate(),release=gate(),metrics=[];
  const work=runNextPublication(worker,{logger:{log:line=>metrics.push(JSON.parse(line)),error(){}},execute:async(tx,j)=>{started.resolve();await release.promise;return executePublication(tx,j)}});
  await Promise.race([started.promise,work.then(()=>{throw Error('Worker stopped before executing publication')})]);
  try {
    assert.equal((await status(db,job.id)).status,'running');
    assert.equal((await db.query('SELECT 42 AS answer')).rows[0].answer,42);
    assert.equal(await count(db,'trips'),0);
    assert.equal((await enqueuePublication(db,'source_approve',payload,'/admin/timetable-reliability')).id,job.id);
  } finally {release.resolve();await work;}
  assert.equal((await status(db,job.id)).status,'succeeded',(await status(db,job.id)).error);
  assert.equal(await count(db,'trips'),148);
  assert.equal(await count(db,'stop_times'),2960);
  const transaction=metrics.find(event=>event.event==='publication_transaction');
  assert.ok(transaction.queryCount<50, `148 trips required ${transaction.queryCount} queries`);
  console.log(JSON.stringify({event:'publication_benchmark',trips:148,stopTimes:2960,queryCount:transaction.queryCount}));
  assert.equal(await count(db,'stops'),20);
  assert.equal(await count(db,'timetable_source_events'),1);
  assert.equal(await runNextPublication(worker,{logger:silent}),false);
  assert.equal(await count(db,'timetable_cache_refreshes'),2);
  await refreshNextCache(worker,silent);await refreshNextCache(worker,silent);
  assert.equal(await count(db,'timetable_cache_refreshes'),0);
  assert.equal(await count(db,'api_response_cache'),3);
  const cache=(await db.query('SELECT payload_text FROM api_response_cache WHERE cache_key=$1',[getApiCacheKey(KINDS.scheduleTimesV2,1)])).rows[0];
  assert.equal(JSON.parse(cache.payload_text).directions[0].trips.length,148);
  // The database-backed source page clamps out-of-range pages and keeps filters.
  const page=await readAdminReviewPage(db,{review:'current',source_page:'999',per_page:'10'});
  assert.equal(page.queues.sources.total,1);assert.equal(page.queues.sources.page,1);
  assert.equal(page.queues.sources.items[0].source_key,'route-214a');
}));

test('worker failure rolls back data and cache invalidation, and the same saved request can retry', {skip:!DATABASE,timeout:20_000}, async()=>fixture(async({db,worker})=>{
  const payload=await seed(db,3,2);
  const job=await enqueuePublication(db,'source_approve',payload,'/admin/timetable-reliability');
  await runNextPublication(worker,{logger:silent,execute:async(tx,j)=>{await executePublication(tx,j);throw Error('Injected failure after publication')}});
  assert.equal((await status(db,job.id)).status,'failed');
  assert.equal(await count(db,'trips'),0);assert.equal(await count(db,'timetable_source_events'),0);
  assert.equal(await count(db,'timetable_cache_refreshes'),0);
  await enqueuePublication(db,'source_approve',payload,'/admin/timetable-reliability');
  await runNextPublication(worker,{logger:silent});
  assert.equal((await status(db,job.id)).status,'succeeded',(await status(db,job.id)).error);
  assert.equal(await count(db,'trips'),3);
}));

test('interrupted running jobs recover, a second worker cannot steal them, and terminal jobs are not repeated', {skip:!DATABASE,timeout:20_000}, async()=>fixture(async({db,worker,config,schema})=>{
  const job=await enqueuePublication(db,'source_approve',await seed(db,2,2),'/admin/timetable-reliability');
  await db.query("UPDATE timetable_publication_jobs SET status='running',attempts=1 WHERE id=$1",[job.id]);
  const second=new Pool({...config,max:1,options:`-c search_path=${schema} -c jit=off`});
  const started=gate(),release=gate();
  const work=runNextPublication(worker,{logger:silent,execute:async(tx,j)=>{started.resolve();await release.promise;return executePublication(tx,j)}});
  await Promise.race([started.promise,work.then(()=>{throw Error('Worker stopped before executing publication')})]);
  try{assert.equal(await runNextPublication(second,{logger:silent}),false);}
  finally{release.resolve();await work;await second.end();}
  assert.equal((await status(db,job.id)).attempts,2);
  assert.equal((await status(db,job.id)).status,'succeeded',(await status(db,job.id)).error);
  assert.equal(await count(db,'timetable_source_events'),1);
}));

test('stale queued decisions fail without publishing or withdrawing a newer revision', {skip:!DATABASE,timeout:20_000}, async()=>fixture(async({db,worker})=>{
  const payload=await seed(db,2,2);
  const job=await enqueuePublication(db,'source_approve',payload,'/admin/timetable-reliability');
  await db.query('UPDATE timetable_sources SET pending_version_id=NULL WHERE id=$1',[payload.sourceId]);
  await runNextPublication(worker,{logger:silent});
  assert.equal((await status(db,job.id)).status,'failed');assert.equal(await count(db,'trips'),0);
  const withdrawal=await enqueuePublication(db,'source_withdraw',{sourceId:payload.sourceId,reviewer:'integration',note:'Withdraw',
    expectedVersionId:null,expectedPendingVersionId:payload.versionId},'/admin/timetable-reliability');
  await runNextPublication(worker,{logger:silent});
  assert.equal((await status(db,withdrawal.id)).status,'failed');
  assert.equal((await db.query('SELECT status FROM timetable_sources')).rows[0].status,'changed_review_required');
}));

test('cache refresh waits for publication commit and cannot overwrite newer timetable data', {skip:!DATABASE,timeout:20_000}, async()=>fixture(async({db,worker})=>{
  const job=await enqueuePublication(db,'source_approve',await seed(db,2,2),'/admin/timetable-reliability');
  await runNextPublication(worker,{logger:silent});
  assert.equal((await status(db,job.id)).status,'succeeded',(await status(db,job.id)).error);
  await refreshRouteCache(worker,1,silent);
  const client=await db.connect();
  let refresh;
  try{
    await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('fika:timetable-publication'))");
    await client.query("UPDATE stop_times SET departure='09:45',arrival='09:45'");
    await clearAffectedApiCache(client,[1]);
    refresh=refreshRouteCache(worker,1,silent);
    await new Promise(resolve=>setTimeout(resolve,30));
    // The old committed cache is still visible while the publisher is uncommitted.
    assert.equal(await count(db,'api_response_cache'),2);
    await client.query('COMMIT');
    await refresh;
  }finally{await client.query('ROLLBACK');client.release();await refresh?.catch(()=>{});}
  const cached=JSON.parse((await db.query('SELECT payload_text FROM api_response_cache WHERE cache_key=$1',
    [getApiCacheKey(KINDS.scheduleTimesV2,1)])).rows[0].payload_text);
  assert.ok(cached.directions[0].rows.every(row=>row.stop_times.every(time=>time.arrival==='09:45:00')));
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM timetable_cache_refreshes WHERE route_id=1')).rows[0].n),0);
}));

test('lock contention retries later without holding public connections and schema checks perform no DDL', {skip:!DATABASE,timeout:20_000}, async()=>fixture(async({db,worker})=>{
  const {ensureTimetableReliabilitySchema}=require('../lib/timetableReliabilitySchema');
  const statements=[];
  await ensureTimetableReliabilitySchema({query(sql,args){statements.push(sql);return db.query(sql,args)}});
  assert.ok(statements.every(sql=>sql.startsWith('SELECT')));
  const job=await enqueuePublication(db,'source_approve',await seed(db,1,2),'/admin/timetable-reliability');
  const held=await db.connect();
  try{
    await held.query('BEGIN');await held.query("SELECT pg_advisory_xact_lock(hashtext('fika:timetable-publication'))");
    await runNextPublication(worker,{logger:silent});
    const retry=await status(db,job.id);
    assert.equal(retry.status,'queued');assert.equal(retry.attempts,1);
    assert.equal((await db.query('SELECT 1 AS ok')).rows[0].ok,1);
    assert.equal(await count(db,'trips'),0);
  }finally{await held.query('ROLLBACK');held.release();}
  await db.query('UPDATE timetable_publication_jobs SET available_at=now() WHERE id=$1',[job.id]);
  await runNextPublication(worker,{logger:silent});
  assert.equal((await status(db,job.id)).status,'succeeded',(await status(db,job.id)).error);
}));
