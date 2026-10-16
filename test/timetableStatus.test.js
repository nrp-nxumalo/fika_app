const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTimetableStatus, createTimetableStatusHandler, getTimetableStatus, gabsValidUntil, STATUS_CACHE_CONTROL } = require('../lib/timetableStatus');
const { POLICY_VERSION } = require('../lib/gabsTimetablePolicy');

const now = new Date('2026-10-14T12:00:00Z');
const url = (end = '20261014', number = '004901') => `https://www.gabs.co.za/timetables/A___B_from_20260901_to_${end}_${number}.pdf`;
const summary = (hash = 'same', effective = '2026-09-01', families = ['weekday']) => ({
  policy_version: POLICY_VERSION, effective_date: effective,
  families: Object.fromEntries(families.map(family => [family, { unchanged_sha256: hash,
    content_sha256: hash, structure_sha256: 'structure', service_days: [family === 'weekday' ? 'monday' : family] }])),
});
const version = (id, hash = 'same', effective = '2026-09-01', families) => ({ id,
  content_sha256: hash, review_status: id === 1 ? 'approved' : 'pending',
  policy_summary: summary(hash, effective, families), source_url: url(),
});
const section = (pending = version(2, 'changed'), options = {}) => ({ id: 8, source_id: 5,
  timetable_number: '004901', catalogue_key: '004901', status: 'changed_review_required',
  approved: version(1), pending, ...options });
const published = (options = {}) => ({ route_id: 30, agency: 'GABS', code: '0049',
  direction_id: 31, direction_name: 'A - B', direction_code: '01', family: 'weekday',
  monday: true, tuesday: true, source_id: 5, source_version_id: 50,
  section_version_id: 1, timetable_number: '004901', source_url: url(),
  effective_date: '2026-09-01', policy_summary: summary(), ...options });
const status = (rows = [published()], sections = [], legacy = [], clock = now) => buildTimetableStatus(rows, sections, legacy, { now: clock });
const first = (...args) => status(...args).routes[0].directions[0];

test('filename validity requires exact published direction and valid calendar dates', () => {
  assert.equal(gabsValidUntil(url(), '004901'), '2026-10-14');
  assert.equal(gabsValidUntil(`${url()}?download=1`, '004901'), '2026-10-14');
  for (const value of [url('99999999'), url('20260230'), url('20260101'), url('20261014', '004902'),
    'https://www.gabs.co.za/timetables/004901.pdf', 'not a URL']) {
    assert.equal(gabsValidUntil(value, '004901'), null);
  }
  assert.equal(gabsValidUntil(url().replace('20260901', '20261301'), '004901'), null);
});

test('expiry starts after the inclusive end date at Johannesburg midnight', () => {
  assert.equal(first(undefined, [], [], new Date('2026-10-14T21:59:59Z')).expired, false);
  assert.equal(first(undefined, [], [], new Date('2026-10-14T22:00:00Z')).expired, true);
  assert.equal(first([published({ source_url: url('99999999') })]).expired, false);
  assert.equal(first([published({ source_url: null, effective_date: '2019-01-01' })]).expired, false);
});

test('changed pending revisions retain exact route, direction and service-day scope', () => {
  const result = status([published(), published({ family: 'public_holiday', monday: false, tuesday: false,
    public_holiday: true, policy_summary: summary('same', '2026-09-01', ['public_holiday']) }),
  published({ direction_id: 32, direction_code: '02', timetable_number: '004902', direction_name: 'B - A' })],
  [section(version(2, 'changed', '2026-10-10', ['public_holiday']))]);
  assert.equal(result.checked_at, now.toISOString());
  assert.equal(result.routes[0].route_id, 30);
  const days = day => result.routes[0].directions.find(d => d.id === 31 && d.service_days.includes(day));
  // This revision removes the published weekday family as well as changing holidays.
  assert.equal(days('monday').pending, true);
  assert.equal(days('public_holiday').pending, true);
  assert.equal(result.routes[0].directions.find(d => d.id === 32).pending, false);

  const holidayOnly = section(version(2, 'changed', '2026-10-10', ['public_holiday']), {
    approved: version(1, 'same', '2026-09-01', ['public_holiday']), catalogue_key: '004903' });
  const regular = section(null, { id: 9, source_id: 6 });
  const scoped = status([published(), published({ family: 'public_holiday', monday: false, tuesday: false,
    public_holiday: true, policy_summary: summary('same', '2026-09-01', ['public_holiday']) })], [regular, holidayOnly]);
  assert.equal(scoped.routes[0].directions.find(d => d.service_days.includes('monday')).pending, false);
  assert.equal(scoped.routes[0].directions.find(d => d.service_days.includes('public_holiday')).pending, true);
});

test('unchanged PDF evidence and failed source checks do not create a pending notice', () => {
  assert.equal(first(undefined, [section(version(2))]).pending, false);
  assert.equal(first(undefined, [section(null, { latest_check_outcome: 'failed', missing_from_document: true })]).pending, false);
  assert.equal(first(undefined, [section({ ...version(2), parse_error: 'Cannot parse' })]).pending, false);
});

test('source priorities discard redundant lower-priority candidates', () => {
  const unrelated = section(version(3, 'changed', '2026-10-01'), { id: 9, source_id: 6,
    catalogue_key: '009901', approved: null });
  assert.equal(first(undefined, [section(null), unrelated]).pending, false);
  unrelated.catalogue_key = '004902';
  assert.equal(first(undefined, [section(null), unrelated]).pending, true);
});

test('equal-priority conflicting revisions show pending without promising a future date', () => {
  const second = section(version(3, 'other', '2026-11-01'), { id: 9, source_id: 6, catalogue_key: '004902' });
  const item = first(undefined, [section(version(2, 'changed', '2026-11-01')), second]);
  assert.equal(item.pending, true);
  assert.equal(item.pending_effective_date, null);
});

test('future dates, pending-plus-expired, publication clearing and withdrawal hold', () => {
  const pending = section(version(2, 'changed', '2026-11-01'));
  const item = first([published({ source_url: url('20261013') })], [pending]);
  assert.equal(item.pending, true);
  assert.equal(item.expired, true);
  assert.equal(item.pending_effective_date, '2026-11-01');
  assert.equal(item.official_source_url, url('20261013'));
  assert.equal(item.pending_source_url, url());
  assert.equal(first(undefined, [section(null, { approved: { ...version(2, 'changed'), review_status: 'approved' } })]).pending, false);
  assert.equal(first(undefined, [{ ...pending, withdrawn: true }]).pending, false);
});

test('legacy MyCiTi changes are scoped to the changed direction and weekday', () => {
  const row = published({ agency: 'MyCiti', code: '214A', direction_code: 'out', section_version_id: null,
    timetable_number: null, source_url: 'https://www.myciti.org.za/214a.pdf' });
  const baseline = { source_id: 5, version_id: 50, route_code: '214A', direction_code: 'out',
    direction_name: 'A - B', service_day: 'monday', effective_date: '2026-09-01', fingerprint: 'a' };
  const after = { ...baseline, version_id: 51, pending: true, review_status: 'pending',
    fingerprint: 'b', source_url: 'https://www.myciti.org.za/214a-new.pdf' };
  const result = status([row], [], [baseline, after]);
  assert.equal(result.routes[0].directions.find(d => d.service_days.includes('monday')).pending, true);
  assert.equal(result.routes[0].directions.find(d => d.service_days.includes('tuesday')).pending, false);
  assert.equal(result.routes[0].directions[0].valid_until, null);
});

test('new service families get pending notices even when no published trips run that day', () => {
  const result = status(undefined, [section(version(2, 'changed', '2026-11-01', ['weekday', 'public_holiday']))]);
  const added = result.routes[0].directions.find(d => d.service_days.includes('public_holiday'));
  assert.equal(added.pending, true);
  assert.equal(added.pending_effective_date, '2026-11-01');
  assert.equal(added.effective_date, null);
  assert.equal(added.valid_until, null);
  assert.equal(added.expired, false);
});

test('removing the published family also warns when another approved PDF would replace it', () => {
  const replacement = section(null, { id: 9, source_id: 6, catalogue_key: '009901',
    approved: { ...version(3, 'older', '2026-08-01'), review_status: 'approved' } });
  const removal = section(version(2, 'changed', '2026-11-01', ['public_holiday']));
  const result = status(undefined, [removal, replacement]);
  assert.equal(result.routes[0].directions.find(d => d.service_days.includes('monday')).pending, true);
});

test('legacy added and removed service days are both marked pending', () => {
  const row = published({ agency: 'MyCiti', code: '214A', direction_code: 'out', section_version_id: null });
  const before = { source_id: 5, version_id: 50, route_code: '214A', direction_code: 'out',
    service_day: 'monday', effective_date: '2026-09-01', fingerprint: 'a' };
  const after = { ...before, version_id: 51, pending: true, review_status: 'pending',
    service_day: 'sunday', effective_date: '2026-11-01', source_url: url(), fingerprint: 'b' };
  const result = status([row], [], [before, after]);
  assert.equal(result.routes[0].directions.find(d => d.service_days.includes('monday')).pending, true);
  assert.equal(result.routes[0].directions.find(d => d.service_days.includes('sunday')).pending, true);
  assert.equal(result.routes[0].directions.find(d => d.service_days.includes('sunday')).effective_date, null);
});

test('status reads only compact evidence and never initializes schema or timetable caches', async () => {
  const queries = [];
  const result = await getTimetableStatus({ async query(sql) { queries.push(sql); return { rows: [] }; } }, { now });
  assert.deepEqual(result, { checked_at: now.toISOString(), routes: [] });
  assert.equal(queries.length, 3);
  for (const sql of queries) assert.doesNotMatch(sql, /CREATE|INSERT|UPDATE|DELETE|pdf_bytes|timetable_audit|api_response_cache/);
  assert.equal(STATUS_CACHE_CONTROL, 'public, max-age=300, must-revalidate');
});

test('missing evidence schema produces a non-cached 503 response', async () => {
  const response = { headers: {}, set(key, value) { this.headers[key] = value; return this; },
    status(value) { this.code = value; return this; }, json(value) { this.body = value; return this; } };
  await createTimetableStatusHandler({ async query() { throw new Error('relation does not exist'); } })({}, response);
  assert.equal(response.code, 503);
  assert.equal(response.headers['Cache-Control'], 'no-store');
  assert.match(response.body.error, /temporarily unavailable/);
});
