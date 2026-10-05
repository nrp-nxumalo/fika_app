const test = require('node:test');
const assert = require('node:assert/strict');
const { policySummary, evaluateTimetable, reviewSnapshot } = require('../lib/gabsTimetablePolicy');

function version(id, { time = '06:00', date = '2026-09-01', catalogue = '004901', days = ['monday'], override = false } = {}) {
  return { id, section_id: 1, source_id: 1, timetable_number: '004901', catalogue_key: catalogue,
    content_sha256: `hash-${id}`, source_override: override, review_status: id === 1 ? 'approved' : 'pending',
    extraction: { schema_version: 1, operator: 'GABS', source_key: '004901', publication_scope: 'service_days', effective_date: date,
      routes: [{ code: '0049', name: 'A - B', directions: [{ code: '01', name: 'A - B', effective_date: date,
        services: [{ label: 'Service', service_days: days, footnotes: [], trips: [{ service_days: days, footnote_markers: [],
          times: [{ sequence: 0, stop_name: 'A', time, raw_time: time, stop_time_type: 'scheduled' },
            { sequence: 1, stop_name: 'B', time: '07:00', raw_time: '07:00', stop_time_type: 'scheduled' }] }] }] }] }] } };
}
function row(approved = version(1), pending = version(2)) {
  return { id: 1, status: 'changed_review_required', approved, pending, latest_check_run_id: 7,
    latest_check_outcome: 'changed', observed_in_check: true };
}
const evaluate = (rows, control = {}, options = {}) => evaluateTimetable(rows, control, { today: '2026-10-05', runId: 7, ...options });
const trip = v => v.extraction.routes[0].directions[0].services[0].trips[0];

test('unchanged, clock-only and date-only revisions are eligible', () => {
  for (const [options, category] of [[{}, 'unchanged'], [{ time: '06:05' }, 'times_or_dates'], [{ date: '2026-09-14' }, 'times_or_dates']]) {
    const result = evaluate([row(version(1), version(2, options))]);
    assert.equal(result.state, 'eligible');
    assert.equal(result.automatic, true);
    assert.equal(result.category, category);
  }
});

test('reordered trip columns remain safe while trip multiplicity is retained', () => {
  const a = version(1), b = version(2, { time: '06:05' });
  const ta = structuredClone(trip(a)), tb = structuredClone(trip(b));
  ta.times[0].time = ta.times[0].raw_time = '08:00';
  tb.times[0].time = tb.times[0].raw_time = '08:05';
  a.extraction.routes[0].directions[0].services[0].trips.push(ta);
  b.extraction.routes[0].directions[0].services[0].trips.unshift(tb);
  assert.equal(evaluate([row(a, b)]).automatic, true);
  b.extraction.routes[0].directions[0].services[0].trips.pop();
  assert.equal(evaluate([row(a, b)]).category, 'structural');
});

test('stop identity, order, serving patterns, days and annotations block automation', () => {
  const mutations = [
    v => { trip(v).times[0].stop_name = 'C'; },
    v => { trip(v).times.reverse().forEach((cell, i) => { cell.sequence = i; }); },
    v => { Object.assign(trip(v).times[1], { time: null, raw_time: 'via', stop_time_type: 'via' }); },
    v => { Object.assign(trip(v).times[1], { time: null, raw_time: '--', stop_time_type: 'not_served' }); },
    v => { const s = v.extraction.routes[0].directions[0].services[0]; s.service_days = trip(v).service_days = ['tuesday']; },
    v => { v.extraction.routes[0].directions[0].services[0].footnotes = [{ marker: 'a', text: 'School days' }]; trip(v).footnote_markers = ['a']; trip(v).times[0].raw_time += 'a'; },
    v => { v.extraction.routes[0].directions[0].services[0].trips.push(structuredClone(trip(v))); },
  ];
  for (const mutate of mutations) {
    const candidate = version(2); mutate(candidate);
    assert.equal(evaluate([row(version(1), candidate)]).automatic, false);
  }
});

test('missing/regressing dates, new timetables, audits and holds require review', () => {
  for (const date of [null, '2026-08-01']) assert.equal(evaluate([row(version(1), version(2, { date }))]).state, 'needs_review');
  assert.equal(evaluate([row(null, version(2))]).state, 'needs_review');
  assert.equal(evaluate([{ ...row(), audit_review_required: true }]).automatic, false);
  assert.equal(evaluate([row()], { withdrawn: true }).state, 'withdrawn');
  assert.equal(evaluate([{ ...row(), missing_from_document: true }]).automatic, false);
});

test('future revisions become eligible on their own effective date', () => {
  const rows = [row(version(1), version(2, { date: '2026-10-06' }))];
  assert.equal(evaluate(rows).state, 'scheduled');
  assert.equal(evaluate(rows, {}, { today: '2026-10-06' }).state, 'eligible');
});

test('own-route then newest date chooses a revision; equal priority conflicts need review', () => {
  const second = row(null, { ...version(3, { time: '06:10', catalogue: '009901', date: '2026-09-14' }), source_id: 2 });
  second.id = 2;
  const result = evaluate([row(version(1), version(2, { time: '06:05' })), second]);
  assert.equal(result.automatic, true);
  assert.deepEqual(result.selected_version_ids, ['2']);
  second.pending.catalogue_key = '004902';
  assert.deepEqual(evaluate([row(), second]).selected_version_ids, ['3']);
  second.pending.extraction.effective_date = '2026-09-01';
  second.pending.extraction.routes[0].directions[0].effective_date = '2026-09-01';
  assert.equal(evaluate([row(), second]).category, 'conflict');
});

test('overrides cannot be replaced automatically, even by time-only changes', () => {
  assert.equal(evaluate([row(version(1, { override: true }), version(2, { time: '06:05' }))]).automatic, false);
});

test('all relevant copies must be freshly captured, including lower-priority sources', () => {
  for (const patch of [{ latest_check_run_id: 6 }, { observed_in_check: false, latest_check_outcome: 'failed' }, { document_issues: [{ error: 'boundary' }] }]) {
    assert.equal(evaluate([{ ...row(), ...patch }]).automatic, false);
  }
  // A successfully observed section can coexist with a failed sibling section.
  assert.equal(evaluate([{ ...row(), latest_check_outcome: 'failed', observed_in_check: true }]).automatic, true);
});

test('identical copies share one decision and compact summaries give the same result', () => {
  const first = row();
  const second = { ...row(null, version(3)), id: 2 };
  second.pending.content_sha256 = first.pending.content_sha256;
  const full = evaluate([first, second]);
  assert.deepEqual(full.identical_version_ids, ['2', '3']);
  for (const r of [first, second]) for (const v of [r.approved, r.pending].filter(Boolean)) {
    v.policy_summary = policySummary(v.extraction); delete v.extraction;
  }
  assert.deepEqual(evaluate([first, second]), full);
});

test('review snapshot covers baseline, membership, audit flags and persistent holds', () => {
  const rows = [row()];
  const original = reviewSnapshot(rows);
  assert.notEqual(reviewSnapshot(rows, { withdrawn: true, revision: 1 }), original);
  assert.notEqual(reviewSnapshot([...rows, { ...row(), id: 2 }]), original);
  rows[0].audit_review_required = true;
  assert.notEqual(reviewSnapshot(rows), original);
});
