const { createHash } = require('node:crypto');
const { sectionContributions, stableJson, priority } = require('./timetableSectionPublisher');
const { currentCapeTownDate } = require('./timetablePublisher');

const POLICY_VERSION = 'gabs-safe-updates/1';
const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');
const sorted = values => values.sort((a, b) => {
  const left = stableJson(a), right = stableJson(b);
  return left < right ? -1 : left > right ? 1 : 0;
});
const unique = values => sorted([...new Map(values.map(value => [stableJson(value), value])).values()]);

// Full validation happens before fingerprinting. Retain annotations when masking
// clock values: a changed footnote must never be classified as just a time edit.
function policySummary(extraction) {
  const contributions = sectionContributions({ extraction, sourceKey: extraction.source_key,
    catalogueKey: extraction.source_key });
  const route = extraction.routes[0];
  const direction = route.directions[0];
  const families = {};
  for (const c of contributions.values()) {
    const days = new Set(c.trips.flatMap(t => t.serviceDays));
    const services = direction.services.flatMap(service => {
      const trips = service.trips.filter(t => (t.service_days || service.service_days).some(day => days.has(day)))
        .map(trip => ({ ...trip, service_days: (trip.service_days || service.service_days).filter(day => days.has(day)) }));
      return trips.length ? [{ ...service, service_days: service.service_days.filter(day => days.has(day)), trips }] : [];
    });
    const project = mask => services.map(service => ({ ...service, trips: sorted(service.trips.map(trip => ({
      ...trip, times: trip.times.map(cell => mask ? { ...cell, time: null,
        raw_time: cell.stop_time_type === 'scheduled' ? cell.raw_time.replace(/\d{1,2}:\d{2}/, '<time>') : cell.raw_time } : cell),
    }))) }));
    const identity = { route: route.code, route_name: route.name, direction: direction.code, name: direction.name };
    const maskedTrips = project(true).flatMap(s => s.trips);
    families[c.family] = {
      content_sha256: hash({ name: c.direction.name, trips: c.trips.map(({ times, serviceDays }) => ({ times, serviceDays })) }),
      unchanged_sha256: hash({ ...identity, services: project(false) }),
      structure_sha256: hash({ ...identity, services: project(true) }),
      stops_sha256: hash(unique(c.trips.map(t => t.times.map(cell => [cell.sequence, cell.stop_name])))),
      days_sha256: hash(unique(services.flatMap(s => [s.service_days, ...s.trips.map(t => t.service_days)]))),
      annotations_sha256: hash({ footnotes: services.map(s => s.footnotes),
        markers: unique(maskedTrips.map(t => [t.footnote_markers, t.times.map(cell => cell.raw_time)])) }),
      patterns_sha256: hash(unique(c.trips.map(t => t.times.map(cell => cell.stop_time_type)))),
      trip_count: c.trips.length,
      scheduled_count: c.trips.reduce((n, t) => n + t.times.filter(cell => cell.stop_time_type === 'scheduled').length, 0),
      service_days: [...days],
    };
  }
  return { policy_version: POLICY_VERSION, effective_date: extraction.effective_date,
    route_name: route.name, direction_name: direction.name, families };
}

function summary(record) {
  return record.policy_summary?.policy_version === POLICY_VERSION ? record.policy_summary : policySummary(record.extraction);
}

function policyWinners(records, { notAfter = '9999-12-31' } = {}) {
  const grouped = new Map();
  for (const record of records) {
    const s = summary(record);
    if (s.effective_date && s.effective_date > notAfter) continue;
    for (const [family, fingerprint] of Object.entries(s.families)) {
      if (!grouped.has(family)) grouped.set(family, []);
      grouped.get(family).push({ ...fingerprint, family, record, effectiveDate: s.effective_date,
        ownRoute: record.catalogue_key.slice(0, 4) === record.timetable_number.slice(0, 4),
        override: Boolean(record.source_override) });
    }
  }
  const winners = new Map();
  for (const [family, copies] of grouped) {
    copies.sort((a, b) => priority(b, a) || Number(a.record.source_id) - Number(b.record.source_id));
    const winner = copies[0];
    if (copies.some(c => priority(c, winner) === 0 &&
      (c.content_sha256 !== winner.content_sha256 || c.structure_sha256 !== winner.structure_sha256))) {
      throw new Error(`Conflicting ${family} copies have equal priority. Choose an exact source revision.`);
    }
    winners.set(family, winner);
  }
  return winners;
}

function reviewSnapshot(rows, control = {}) {
  return hash({ control: [Boolean(control.withdrawn), String(control.revision || 0)],
    rows: rows.map(r => [String(r.id), r.status, r.missing_from_document, r.audit_review_required, r.withdrawal_review_required,
      String(r.last_seen_document_version_id || ''), r.latest_check_id && String(r.latest_check_id),
      ...['approved', 'pending'].map(key => r[key] && [String(r[key].id), r[key].content_sha256,
        r[key].review_status, Boolean(r[key].source_override)])]).sort((a, b) => a[0].localeCompare(b[0])) });
}

function evaluateTimetable(rows, control = {}, { today = currentCapeTownDate(), runId = null, selectedVersionId = null } = {}) {
  const approved = rows.filter(r => r.status !== 'withdrawn').flatMap(r => r.approved ? [r.approved] : []);
  const valid = r => r && !r.parse_error && (r.extraction || r.policy_summary?.policy_version === POLICY_VERSION);
  let candidates = rows.flatMap(row => {
    const version = row.pending || (row.status !== 'withdrawn' ? row.approved : null);
    return valid(version) ? [version] : [];
  });
  const selected = selectedVersionId && candidates.find(r => String(r.id) === String(selectedVersionId));
  if (selectedVersionId && !selected) throw new Error('The selected revision is no longer available.');
  if (selected) candidates = candidates.map(r => ({ ...r, source_override: r === selected }));
  const decision = { policy_version: POLICY_VERSION, snapshot: reviewSnapshot(rows, control),
    state: 'current', category: 'unchanged', reasons: [], selected_version_ids: [], identical_version_ids: [],
    current_dates: [], proposed_dates: [], families: [], service_days: [], trip_changes: [], winning_version_ids: [], automatic: false };
  const block = reason => { if (!decision.reasons.includes(reason)) decision.reasons.push(reason); };
  let baseline = new Map();
  let winners = new Map();
  try { baseline = policyWinners(approved.filter(valid), { notAfter: today }); }
  catch (error) { block(error.message); }
  try { winners = policyWinners(candidates); }
  catch (error) { block(error.message); decision.category = 'conflict'; }
  const selectedIds = new Set([...winners.values()].map(c => String(c.record.id)));
  const selectedRecords = candidates.filter(c => selectedIds.has(String(c.id)));
  const pendingIds = new Set(rows.flatMap(r => r.pending ? [String(r.pending.id)] : []));
  // Identical evidence gets one decision even when it came from several PDFs.
  const accepted = candidates.filter(c => selectedRecords.some(s => s.content_sha256 === c.content_sha256));
  decision.selected_version_ids = selectedRecords.filter(c => pendingIds.has(String(c.id))).map(c => String(c.id));
  decision.winning_version_ids = selectedRecords.map(c => String(c.id));
  decision.identical_version_ids = accepted.filter(c => pendingIds.has(String(c.id))).map(c => String(c.id));
  decision.current_dates = [...new Set([...baseline.values()].map(c => c.effectiveDate))];
  decision.proposed_dates = [...new Set([...winners.values()].map(c => c.effectiveDate))];
  decision.families = [...winners.keys()];
  decision.service_days = [...new Set([...winners.values()].flatMap(c => c.service_days))];
  if (control.withdrawn) block('This timetable is withdrawn. Explicit manual restoration is required.');
  for (const row of rows) {
    if (row.status === 'withdrawn' && !row.pending) continue;
    if (row.audit_review_required) block('A source audit found a mismatch.');
    if (row.missing_from_document) block('A timetable section is absent from the latest document.');
    if (row.pending?.parse_error || row.document_issues?.length) block('Source parsing or section boundaries need review.');
    if (row.latest_check_outcome === 'missing' || (row.latest_check_outcome === 'failed' && !row.observed_in_check)) {
      block('A relevant catalogue PDF could not be checked.');
    }
    if (runId && (String(row.latest_check_run_id) !== String(runId) || !row.observed_in_check)) {
      block('All competing copies must be captured successfully in this check.');
    }
    if ((row.status === 'withdrawn' || row.withdrawal_review_required) && row.pending && accepted.some(c => String(c.id) === String(row.pending.id))) {
      block('A withdrawn copy has reappeared and requires manual review.');
    }
    if (row.approved?.source_override && row.pending) block('An explicitly selected revision has changed.');
  }
  let changed = false;
  for (const [family, winner] of winners) {
    const before = baseline.get(family);
    decision.trip_changes.push({ family, before: before?.trip_count || 0, after: winner.trip_count });
    if (!before) { block(`No approved baseline for ${family}.`); decision.category = 'new'; continue; }
    if (before.structure_sha256 !== winner.structure_sha256) {
      const changes = [];
      if (before.trip_count !== winner.trip_count) changes.push('trip count');
      if (before.stops_sha256 !== winner.stops_sha256) changes.push('stops or stop order');
      if (before.days_sha256 !== winner.days_sha256) changes.push('operating days');
      if (before.annotations_sha256 !== winner.annotations_sha256) changes.push('annotations');
      if (before.patterns_sha256 !== winner.patterns_sha256) changes.push('stop-serving patterns');
      block(`Changed ${changes.join(', ') || 'timetable labels or service structure'} for ${family}.`);
      decision.category = 'structural';
    }
    if (before.unchanged_sha256 !== winner.unchanged_sha256 || before.effectiveDate !== winner.effectiveDate) {
      changed = true;
      if (!winner.effectiveDate || (before.effectiveDate && winner.effectiveDate < before.effectiveDate)) {
        block('Changed content has a missing or regressing effective date.');
      }
      if (before.override) block('Automation cannot replace an explicitly selected revision.');
    }
  }
  for (const family of baseline.keys()) if (!winners.has(family)) block(`Service family ${family} would be removed.`);
  if (changed && decision.category === 'unchanged') decision.category = 'times_or_dates';
  const pending = decision.identical_version_ids.length > 0;
  if (control.withdrawn) decision.state = 'withdrawn';
  else if (decision.reasons.length) decision.state = 'needs_review';
  else if (pending) {
    decision.automatic = true;
    decision.state = decision.proposed_dates.some(date => date && date > today) ? 'scheduled' : 'eligible';
  } else if (approved.some(c => c.approval_method === 'automatic')) decision.state = 'automatic';
  return decision;
}

module.exports = { POLICY_VERSION, policySummary, policyWinners, reviewSnapshot, evaluateTimetable };
