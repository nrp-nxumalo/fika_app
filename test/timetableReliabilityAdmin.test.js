const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeQuery, reviewReturnUrl } = require('../lib/reliabilityReviewQueue');
const {
  actionToken,
  bulkApprovalIdentifier,
  comparisonSummary,
  createTimetableReliabilityHandlers,
  getBulkUnchangedCandidates,
  isPendingVersionEffective,
  johannesburgDate,
  renderAdminPage,
  secureEqual,
} = require('../lib/timetableReliabilityAdmin');

function reviewSource(id, overrides = {}) {
  return { id, operator: 'MyCiti', source_key: `route-${id}`, route_name: `Route ${id}`,
    status: 'changed_review_required', pending_version_id: id + 100,
    pending_pdf_sha256: String(id).padStart(64, 'a'),
    pending_comparison: { has_changes: false, changed_time_count: 0, added_time_count: 0, removed_time_count: 0 },
    ...overrides };
}

function reviewPage(sources, query = {}, sectionGroups = []) {
  return renderAdminPage({ sources, query, sectionGroups, checkRuns: [], audit: null, samples: [] }, 'secret');
}

test('review defaults to ten rows with publishable sources before blocked and future candidates', () => {
  const sources = [
    reviewSource(1, { pending_comparison: { parse_error: 'bad PDF' } }),
    reviewSource(2, { pending_source_effective_date: '2099-01-01' }),
    reviewSource(3, { section_mode: true }),
    ...Array.from({ length: 11 }, (_, i) => reviewSource(i + 4)),
  ];
  const html = reviewPage(sources);
  assert.match(html, /1–10 of 12 sources/);
  assert.match(html, /sources\/4\/approve/);
  assert.match(html, /sources\/13\/approve/);
  assert.doesNotMatch(html, /sources\/(1|2|3|14)\/(approve|withdraw)/);
  assert.match(html, /source_page=2/);
  const next = reviewPage(sources, { source_page: '2' });
  assert.match(next, /11–12 of 12 sources/);
  assert.ok(next.indexOf('sources/14/approve') < next.indexOf('sources/1/withdraw'));
});

test('filters combine search, operator, status and readiness before pagination', () => {
  const sources = [reviewSource(1, { route_name: 'Cape Town' }),
    reviewSource(2, { route_name: 'Cape Town', operator: 'GABS' }),
    reviewSource(3, { route_name: 'Cape Town', pending_comparison: { parse_error: 'bad PDF' } }),
    reviewSource(4, { route_name: 'Cape Town', status: 'verified' }), reviewSource(5)];
  const html = reviewPage(sources, { q: 'cApE', operator: 'MyCiti', review: 'ready', status: 'changed_review_required', source_page: '99' });
  assert.match(html, /1–1 of 1 sources/);
  assert.match(html, /sources\/1\/approve/);
  assert.doesNotMatch(html, /sources\/[2-5]\/approve/);
  assert.match(html, /name="return_query" value="q=cApE&amp;operator=MyCiti/);
  assert.match(html, /source_page=1/);
  assert.match(reviewPage(sources, { q: 'unmatched' }), /0–0 of 0 sources/);
  assert.match(reviewPage(sources, { q: 'unmatched' }), /No sources match these filters/);
});

test('pagination preserves filters, supports page sizes and deterministic source sorting', () => {
  const sources = Array.from({ length: 31 }, (_, i) => reviewSource(31 - i));
  const html = reviewPage(sources, { q: 'route', operator: 'MyCiti', per_page: '25', sort: 'source' });
  assert.match(html, /1–25 of 31 sources/);
  assert.ok(html.indexOf('sources/2/approve') < html.indexOf('sources/10/approve'));
  assert.match(html, /q=route&amp;operator=MyCiti&amp;status=&amp;review=needs_review&amp;sort=source&amp;per_page=25&amp;source_page=2/);
  assert.doesNotMatch(html, /sources\/26\/approve/);
});

test('bulk approval is signed for only the visible eligible source revisions', () => {
  const sources = Array.from({ length: 12 }, (_, i) => reviewSource(i + 1));
  const html = reviewPage(sources, { source_page: '2' });
  assert.match(html, /name="candidate_ids" value="\[11,12\]"/);
  assert.match(html, /Approve and publish 2 unchanged routes on this page/);
  assert.match(html, new RegExp(actionToken('secret', 'bulk-approve-unchanged',
    bulkApprovalIdentifier(getBulkUnchangedCandidates(sources.slice(10))))));
});

test('route pagination keeps directions and duplicate evidence together', () => {
  const groups = Array.from({ length: 12 }, (_, i) => ({ timetable_number: String(i + 1).padStart(4, '0') + '01',
    conflicting_copies: i === 0, variants: [{ copies: [{ id: i + 1, version_id: i + 101,
      pending_version_id: i + 101, catalogue_key: '001001', direction_name: 'Cape Town',
      status: 'changed_review_required', effective_date: '2026-01-01' }] }] }));
  groups[1].variants[0].copies.push({ ...groups[1].variants[0].copies[0], id: 99, catalogue_key: '009901' });
  groups.push({ ...groups[1], timetable_number: '000202' });
  const html = reviewPage([], {}, groups);
  assert.match(html, /1–10 of 12 routes/);
  assert.equal((html.match(/<h3>Route 0002/g) || []).length, 1);
  assert.match(html, /timetables\/000201\/approve/);
  assert.match(html, /timetables\/000202\/approve/);
  assert.equal((html.match(/action="[^"]*timetables\/000201\/approve"/g) || []).length, 1);
  assert.doesNotMatch(html, /sections\/(2|99)\/approve/);
  assert.match(reviewPage([], { q: '009901' }, groups), /timetables\/000202\/approve/);
  assert.match(reviewPage([], { review: 'conflict' }, groups), /1–1 of 1 routes/);
  assert.match(reviewPage([], { operator: 'MyCiti' }, groups), /0–0 of 0 routes/);
  assert.match(reviewPage([], { section_page: '2' }, groups), /11–12 of 12 routes/);
});

test('untrusted query parameters are bounded, escaped and cannot redirect away from review', () => {
  assert.equal(normalizeQuery({ source_page: '-3', per_page: '100000', sort: ['ready'], q: {} }).source_page, '1');
  assert.equal(normalizeQuery({ per_page: '100000' }).per_page, '10');
  const html = reviewPage([], { q: '\"><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.ok(reviewReturnUrl('https://evil.example/?q=test').startsWith('/admin/timetable-reliability?'));
  assert.match(reviewReturnUrl('q=route&source_page=2'), /q=route.*source_page=2/);
  assert.match(reviewReturnUrl('section_page=2', 'sections'), /section_page=2#sections$/);
});

test('scheduled routes retain their own date and cannot publish early', () => {
  const groups = [{ timetable_number: '001001', decision: { state: 'scheduled', reasons: [], snapshot: 'a'.repeat(64),
    current_dates: ['2026-09-01'], proposed_dates: ['2099-01-01'], selected_version_ids: ['2'], families: ['weekday'] },
    variants: [{ copies: [{ id: 1, version_id: 2, pending_version_id: 2, effective_date: '2099-01-01', catalogue_key: '001001' }] }] }];
  assert.match(reviewPage([], { review: 'scheduled' }, groups), /disabled>Approve timetable and publish/);
  assert.match(reviewPage([], {}, groups), /0–0 of 0 routes/);
  assert.match(reviewPage([], { review: 'scheduled' }, groups), /1–1 of 1 routes/);
});

test('bulk selection rejects tampered, duplicate and stale visible candidates before publication', async () => {
  const sources = [reviewSource(1), reviewSource(2)];
  const database = { async query(sql) {
    if (sql.includes('fika_schema_versions')) return { rows: [{ version: 1 }] };
    if (sql.includes('FROM timetable_sources AS sources')) return { rows: sources };
    throw Error('Unexpected publication query');
  } };
  const handlers = createTimetableReliabilityHandlers({ database, username: 'reviewer', password: 'secret' });
  const token = actionToken('secret', 'bulk-approve-unchanged', bulkApprovalIdentifier(getBulkUnchangedCandidates([sources[0]])));
  for (const [ids, expected] of [['[1,2]', 409], ['[1,1]', 400], ['[3]', 409], ['{}', 400]]) {
    const response = { set() { return this; }, status(code) { this.code = code; return this; }, type() { return this; }, send() { return this; } };
    await handlers.bulkApproveUnchanged({ get: () => `Basic ${Buffer.from('reviewer:secret').toString('base64')}`,
      body: { candidate_ids: ids, token } }, response);
    assert.equal(response.code, expected);
  }
});

test('manual verification dates use the Cape Town calendar day', () => {
  assert.equal(johannesburgDate(new Date('2026-08-16T22:30:00Z')), '2026-08-17');
});

test('action tokens are scoped to the action and exact candidate', () => {
  const token = actionToken('secret', 'approve', '3:8:abc');
  assert.equal(secureEqual(token, actionToken('secret', 'approve', '3:8:abc')), true);
  assert.equal(secureEqual(token, actionToken('secret', 'approve', '3:9:def')), false);
  assert.equal(secureEqual(token, actionToken('secret', 'withdraw', '3:8:abc')), false);
});

test('comparison summary reports counts and changed times', () => {
  const summary = comparisonSummary({
    previous_scheduled_departure_count: 180,
    current_scheduled_departure_count: 182,
    changed_time_count: 2,
    added_time_count: 3,
    removed_time_count: 1,
  });
  assert.match(summary, /180 → 182 departures/);
  assert.match(summary, /2 changed, 3 added, 1 removed/);
});

test('comparison summary makes zero-time structural changes visible', () => {
  const summary = comparisonSummary({
    previous_scheduled_departure_count: 180,
    current_scheduled_departure_count: 180,
    changed_time_count: 0,
    added_time_count: 0,
    removed_time_count: 0,
    structural_changes: {
      routes: { changed: true },
      service_days: { changed: true },
      stops: { changed: false },
    },
  });

  assert.match(summary, /structural changes: routes, service days/);
});

test('bulk approval candidates require zero changes and an effective pending version', () => {
  const candidates = getBulkUnchangedCandidates([
    {
      id: 3,
      pending_version_id: 8,
      pending_pdf_sha256: 'a'.repeat(64),
      pending_source_effective_date: '2026-08-17',
      pending_comparison: {
        has_changes: false,
        changed_time_count: 0,
        added_time_count: 0,
        removed_time_count: 0,
      },
    },
    {
      id: 4,
      pending_version_id: 9,
      pending_pdf_sha256: 'b'.repeat(64),
      pending_comparison: {
        has_changes: true,
        changed_time_count: 1,
        added_time_count: 0,
        removed_time_count: 0,
      },
    },
    {
      id: 5,
      pending_version_id: 10,
      pending_pdf_sha256: 'c'.repeat(64),
      pending_comparison: { changed_time_count: 0 },
    },
    {
      id: 6,
      pending_version_id: 11,
      pending_pdf_sha256: 'd'.repeat(64),
      pending_source_effective_date: '2026-08-18',
      pending_comparison: {
        has_changes: false,
        changed_time_count: 0,
        added_time_count: 0,
        removed_time_count: 0,
      },
    },
  ], '2026-08-17');

  assert.deepEqual(candidates, [{
    sourceId: 3,
    versionId: 8,
    pdfSha256: 'a'.repeat(64),
  }]);
  assert.equal(bulkApprovalIdentifier(candidates), JSON.stringify([[3, 8, 'a'.repeat(64)]]));
  assert.equal(isPendingVersionEffective({ pending_source_effective_date: '2026-08-17' }, '2026-08-17'), true);
  assert.equal(isPendingVersionEffective({ pending_source_effective_date: '2026-08-18' }, '2026-08-17'), false);
});

test('bulk approval excludes zero-time comparisons with structural changes', () => {
  const candidates = getBulkUnchangedCandidates([{
    id: 7,
    pending_version_id: 12,
    pending_pdf_sha256: 'e'.repeat(64),
    pending_comparison: {
      has_changes: true,
      changed_time_count: 0,
      added_time_count: 0,
      removed_time_count: 0,
      structural_changes: {
        routes: { changed: true },
      },
    },
  }]);

  assert.deepEqual(candidates, []);
});

test('admin page offers a signed bulk action with the unchanged review note by default', () => {
  const html = renderAdminPage({
    sources: [{
      id: 3,
      operator: 'GABS',
      source_key: '000401',
      official_source_url: 'https://operator.example/source.pdf',
      direction_names: ['Outbound'],
      service_day_coverage: ['monday'],
      parser_version: 'gabs-2',
      import_version: 'canonical-1',
      status: 'changed_review_required',
      pending_version_id: 8,
      pending_pdf_sha256: 'a'.repeat(64),
      pending_pdf_size_bytes: 1234,
      pending_comparison: {
        has_changes: false,
        changed_time_count: 0,
        added_time_count: 0,
        removed_time_count: 0,
      },
    }],
    checkRuns: [],
    audit: null,
    samples: [],
  }, 'secret');

  assert.match(html, /action="\/admin\/timetable-reliability\/sources\/bulk-approve-unchanged"/);
  assert.match(html, /value="unchanged"/);
  assert.match(html, /Approve and publish 1 unchanged route/);
  assert.match(html, new RegExp(actionToken(
    'secret',
    'bulk-approve-unchanged',
    JSON.stringify([[3, 8, 'a'.repeat(64)]])
  )));
});

test('admin page disables publication and excludes a future-effective route from bulk approval', () => {
  const html = renderAdminPage({
    sources: [{
      id: 6,
      operator: 'MyCiti',
      source_key: '215',
      official_source_url: 'https://operator.example/215.pdf',
      direction_names: ['Outbound'],
      service_day_coverage: ['monday'],
      parser_version: 'myciti-2',
      import_version: 'canonical-1',
      status: 'changed_review_required',
      pending_version_id: 11,
      pending_pdf_sha256: 'd'.repeat(64),
      pending_pdf_size_bytes: 1234,
      pending_source_effective_date: '2099-01-01',
      pending_comparison: {
        has_changes: false,
        changed_time_count: 0,
        added_time_count: 0,
        removed_time_count: 0,
      },
    }],
    query: { review: 'future' },
    checkRuns: [],
    audit: null,
    samples: [],
  }, 'secret');

  assert.match(html, /type="submit" disabled title="Available from 2099-01-01">Approve and publish/);
  assert.match(html, /Cannot publish before its effective date, 2099-01-01/);
  assert.doesNotMatch(html, /sources\/bulk-approve-unchanged/);
});

test('admin page makes publication an explicit review action and scopes the accuracy claim', () => {
  const html = renderAdminPage({
    sources: [{
      id: 3,
      operator: 'GABS',
      source_key: '000401',
      route_name: '<route>',
      direction_names: ['Outbound'],
      service_day_coverage: ['monday'],
      official_source_url: 'https://operator.example/source.pdf',
      source_effective_date: new Date(2026, 7, 10),
      last_downloaded_at: '2026-08-17T01:00:00Z',
      current_pdf_sha256: 'a'.repeat(64),
      parser_version: 'gabs-2',
      import_version: 'canonical-1',
      status: 'changed_review_required',
      approved_version_id: 7,
      pending_version_id: 8,
      pending_pdf_sha256: 'b'.repeat(64),
      pending_pdf_size_bytes: 1234,
      pending_comparison: { previous_departure_count: 10, candidate_departure_count: 11 },
    }],
    checkRuns: [],
    audit: null,
    samples: [],
  }, 'secret');

  assert.match(html, /Approve and publish/);
  assert.match(html, /versions\/8\/comparison/);
  assert.match(html, /not a punctuality audit/);
  assert.match(html, /&lt;route&gt;/);
  assert.doesNotMatch(html, /<route>/);
  assert.match(html, /Effective 2026-08-10/);
});

test('admin page quarantines parser failures without offering publication', () => {
  const html = renderAdminPage({
    sources: [{
      id: 4,
      operator: 'GABS',
      source_key: '006603',
      official_source_url: 'https://operator.example/006603.pdf',
      direction_names: [],
      service_day_coverage: [],
      parser_version: 'parser-v2',
      import_version: 'canonical-v1',
      status: 'changed_review_required',
      pending_version_id: 12,
      pending_pdf_sha256: 'c'.repeat(64),
      pending_pdf_size_bytes: 4567,
      pending_comparison: { parse_error: '<unexpected layout>' },
    }],
    checkRuns: [],
    audit: null,
    samples: [],
  }, 'secret');

  assert.match(html, /Parser failed; publication is blocked/);
  assert.match(html, /&lt;unexpected layout&gt;/);
  assert.doesNotMatch(html, /Approve and publish<\/button>/);
  assert.match(html, /captured PDF/);
});

test('timetable review signs shared actions and links physical page evidence and copy differences', () => {
  const html = renderAdminPage({sources:[],checkRuns:[],audit:null,samples:[],sectionGroups:[{
    timetable_number:'004901',preferred_section_id:1,preferred_version_id:10,conflicting_copies:true,
    decision:{state:'needs_review',snapshot:'b'.repeat(64),reasons:[],current_dates:['2026-08-01'],proposed_dates:['2026-09-01'],families:['weekday'],selected_version_ids:['20']},
    variants:[{copies:[{id:2,version_id:20,pending_version_id:20,content_sha256:'a'.repeat(64),
      catalogue_key:'005001',status:'changed_review_required',direction_name:'<Tafelsig>',
      effective_date:'2026-09-01',evidence:[{document_version_id:5,pages:[1,2]}]}]}],
  }]}, 'secret');
  assert.match(html, /timetables\/004901\/approve/);
  assert.match(html, new RegExp(actionToken('secret','timetable-approve',`004901:${'b'.repeat(64)}`)));
  assert.match(html, /versions\/5\/pdf#page=1/);
  assert.match(html, /pages 1, 2/);
  assert.match(html, /comparison\?against=10/);
  assert.match(html, /&lt;Tafelsig&gt;/);
  assert.doesNotMatch(html, /sources\/bulk-approve/);
});

test('section evidence and mutations require authentication before database access', async () => {
  const handlers = createTimetableReliabilityHandlers({database:{query(){throw Error('unexpected database access');}},
    username:'reviewer',password:'secret'});
  for (const name of ['sectionComparison','approveSection','withdrawSection','approveTimetable','withdrawTimetable']) {
    const response = {headers:{},set(k,v){this.headers[k]=v;return this;},status(v){this.statusCode=v;return this;},
      type(){return this;},send(){return this;}};
    await handlers[name]({get:()=>'',params:{id:'1'},body:{}},response);
    assert.equal(response.statusCode,401);
    assert.equal(response.headers['Cache-Control'],'no-store');
  }
});

test('timetable actions reject altered snapshots and invalid selections before database access', async () => {
  const handlers = createTimetableReliabilityHandlers({ database: { query() { throw Error('unexpected database access'); } },
    username: 'reviewer', password: 'secret' });
  const auth = `Basic ${Buffer.from('reviewer:secret').toString('base64')}`;
  for (const body of [
    { snapshot: 'a'.repeat(64), token: 'bad-token' },
    { snapshot: 'a'.repeat(64), selected_version_id: '-1' },
    { snapshot: 'not-a-snapshot' },
  ]) {
    const response = { set() { return this; }, status(value) { this.statusCode = value; return this; },
      type() { return this; }, send() { return this; } };
    await handlers.approveTimetable({ get: () => auth, params: { number: '004901' }, body }, response);
    assert.ok([400, 409].includes(response.statusCode));
  }
});

test('route decisions show distinct timetable and catalogue dates without duplicate actions', () => {
  const decision = { state: 'eligible', category: 'times_or_dates', snapshot: 'c'.repeat(64), reasons: [],
    current_dates: ['2026-09-01'], proposed_dates: ['2026-09-14'], families: ['weekday'], selected_version_ids: ['2'] };
  const copy = { id: 1, version_id: 2, pending_version_id: 2, content_sha256: 'h', catalogue_key: '004901',
    effective_date: '2026-09-14', catalogue_effective_date: '2026-09-14' };
  const groups = [{ timetable_number: '004901', decision, copies: [copy, { ...copy, id: 2, version_id: 3,
    pending_version_id: 3, catalogue_key: '004902', catalogue_effective_date: '2026-08-20' }], variants: [] }];
  const html = reviewPage([], {}, groups);
  assert.match(html, /Current timetable effective date: 2026-09-01/);
  assert.match(html, /Proposed timetable effective date: 2026-09-14/);
  assert.match(html, /Catalogue entry effective date: 2026-08-20/);
  assert.equal((html.match(/action="[^\"]*timetables\/004901\/approve"/g) || []).length, 1);
  assert.doesNotMatch(html, /sections\/\d+\/approve/);
});

test('a signed approval queues the exact decision and returns a status page without running publication', async () => {
  const calls=[];
  const database={async query(sql,params){
    calls.push({sql,params});
    if(sql.includes('fika_schema_versions'))return {rows:[{version:1}]};
    if(sql.includes('INSERT INTO timetable_publication_jobs'))return {rows:[{id:'42',status:'queued'}]};
    throw Error('Approval must not execute timetable writes');
  }};
  const handler=createTimetableReliabilityHandlers({database,username:'reviewer',password:'secret'});
  const snapshot='a'.repeat(64);
  const res={set(){return this;},redirect(code,url){this.code=code;this.url=url;}};
  await handler.approveTimetable({get:()=>`Basic ${Buffer.from('reviewer:secret').toString('base64')}`,
    params:{number:'004901'},body:{snapshot,note:'Compared captured PDF',selected_version_id:'7',
      token:actionToken('secret','timetable-approve',`004901:${snapshot}`)}},res);
  assert.equal(res.code,303);assert.equal(res.url,'/admin/timetable-reliability/jobs/42');
  const queued=calls.find(call=>call.sql.includes('INSERT INTO timetable_publication_jobs'));
  assert.deepEqual(JSON.parse(queued.params[2]),{number:'004901',snapshot,reviewer:'reviewer',note:'Compared captured PDF',
    withdraw:false,restore:false,selectedVersionId:'7'});
  assert.ok(calls.every(call=>!call.sql.includes('CREATE TABLE')));
});

test('publishing status is authenticated, escapes errors and refreshes only unfinished jobs', async () => {
  const auth=`Basic ${Buffer.from('reviewer:secret').toString('base64')}`;
  let state='running',queries=0;
  const handler=createTimetableReliabilityHandlers({username:'reviewer',password:'secret',database:{async query(){
    queries++;return {rows:[{id:42,action:'source_approve',status:state,error:'<failed>',created_at:new Date(),return_url:'/admin/timetable-reliability'}]};
  }}});
  const response=()=>({headers:{},set(k,v){this.headers[k]=v;return this;},type(){return this;},status(v){this.code=v;return this;},send(v){this.body=v;return this;}});
  const denied=response();await handler.job({get:()=>'',params:{id:'42'}},denied);
  assert.equal(denied.code,401);assert.equal(queries,0);
  const running=response();await handler.job({get:()=>auth,params:{id:'42'}},running);
  assert.equal(running.headers.Refresh,'2');assert.match(running.body,/Publishing timetable/);
  state='failed';const failed=response();await handler.job({get:()=>auth,params:{id:'42'}},failed);
  assert.equal(failed.headers.Refresh,undefined);assert.match(failed.body,/&lt;failed&gt;/);
});
