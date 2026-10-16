const { POLICY_VERSION, policySummary, policyWinners } = require('./gabsTimetablePolicy');
const { priority } = require('./timetableSectionPublisher');
const { currentCapeTownDate, SERVICE_DAYS } = require('./timetablePublisher');

const STATUS_CACHE_CONTROL = 'public, max-age=300, must-revalidate';
const FAMILY_DAYS = { weekday: SERVICE_DAYS.slice(0, 5), saturday: ['saturday'],
  sunday: ['sunday'], public_holiday: ['public_holiday'] };

function date(value) {
  if (!value) return null;
  const text = value instanceof Date
    ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
    : String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

// The filename dates apply only to the exact numbered section advertised by
// that filename, never to other directions embedded in the same PDF.
function gabsValidUntil(sourceUrl, timetableNumber) {
  let filename;
  try { filename = decodeURIComponent(new URL(sourceUrl).pathname.split('/').at(-1)); }
  catch { return null; }
  const match = filename.match(/_from_(\d{8})_to_(\d{8})_(\d{6})\.pdf$/i);
  if (!match || match[3] !== timetableNumber || match[2] === '99999999') return null;
  const iso = value => date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`);
  const from = iso(match[1]), until = iso(match[2]);
  return from && until && until >= from ? until : null;
}

const PUBLISHED_SQL = `
  SELECT r.id AS route_id,r.agency,r.code,d.id AS direction_id,d.direction AS direction_name,
    d.code AS direction_code,t.timetable_service_family AS family,
    COALESCE(t.timetable_source_id,d.timetable_source_id) AS source_id,
    COALESCE(t.timetable_source_version_id,d.timetable_source_version_id) AS source_version_id,
    t.timetable_section_version_id AS section_version_id,
    t.timetable_effective_date AS effective_date,sv.source_effective_date,
    sv.source_url,src.source_key,src.section_mode,sections.timetable_number,
    section.policy_summary,
    CASE WHEN section.policy_summary->>'policy_version' IS DISTINCT FROM '${POLICY_VERSION}' THEN section.extraction END AS section_extraction,
    ${SERVICE_DAYS.map(day => `bool_or(t.${day}) AS ${day}`).join(',')}
  FROM routes r JOIN directions d ON d.route_id=r.id JOIN trips t ON t.direction_id=d.id
  LEFT JOIN timetable_sources src ON src.id=COALESCE(t.timetable_source_id,d.timetable_source_id)
  LEFT JOIN timetable_source_versions sv ON sv.id=COALESCE(t.timetable_source_version_id,d.timetable_source_version_id)
  LEFT JOIN timetable_section_versions section ON section.id=t.timetable_section_version_id
  LEFT JOIN timetable_sections sections ON sections.id=section.section_id
  GROUP BY r.id,d.id,t.timetable_service_family,COALESCE(t.timetable_source_id,d.timetable_source_id),
    COALESCE(t.timetable_source_version_id,d.timetable_source_version_id),t.timetable_section_version_id,
    t.timetable_effective_date,sv.id,src.id,section.id,sections.id
  ORDER BY r.agency,r.code,d.id,t.timetable_service_family;`;

function versionJson(alias, document) {
  return `CASE WHEN ${alias}.id IS NOT NULL THEN jsonb_build_object('id',${alias}.id,
    'content_sha256',${alias}.content_sha256,'parse_error',${alias}.parse_error,
    'review_status',${alias}.review_status,'source_override',${alias}.source_override,
    'policy_summary',${alias}.policy_summary,'source_url',${document}.source_url,
    'extraction',CASE WHEN ${alias}.policy_summary->>'policy_version' IS DISTINCT FROM '${POLICY_VERSION}' THEN ${alias}.extraction END) END`;
}

const SECTIONS_SQL = `
  SELECT s.id,s.source_id,s.timetable_number,s.status,src.source_key AS catalogue_key,
    COALESCE(control.withdrawn,false) AS withdrawn,
    ${versionJson('a', 'ad')} AS approved,${versionJson('p', 'pd')} AS pending
  FROM timetable_sections s JOIN timetable_sources src ON src.id=s.source_id
  LEFT JOIN timetable_section_versions a ON a.id=s.approved_version_id
  LEFT JOIN timetable_section_versions p ON p.id=s.pending_version_id
  LEFT JOIN timetable_source_versions ad ON ad.id=a.document_version_id
  LEFT JOIN timetable_source_versions pd ON pd.id=p.document_version_id
  LEFT JOIN timetable_review_controls control ON control.timetable_number=s.timetable_number
  WHERE src.section_mode ORDER BY s.timetable_number,s.id;`;

// Hash the relevant services inside Postgres. No PDFs, full stop-time
// extractions, audit rows, or check-run histories are sent to this endpoint.
const LEGACY_SQL = `
  WITH documents AS (
    SELECT DISTINCT src.id AS source_id,src.pending_version_id,v.id,v.source_url,
      v.source_effective_date,v.extraction,v.comparison,v.review_status
    FROM timetable_sources src JOIN timetable_source_versions v ON v.source_id=src.id
    WHERE NOT src.section_mode AND src.status<>'withdrawn' AND src.pending_version_id IS NOT NULL
      AND (v.id=src.pending_version_id OR EXISTS(SELECT 1 FROM trips t JOIN directions d ON d.id=t.direction_id
        WHERE COALESCE(t.timetable_source_version_id,d.timetable_source_version_id)=v.id))
  )
  SELECT docs.source_id,docs.id AS version_id,docs.id=docs.pending_version_id AS pending,
    docs.source_url,docs.review_status,docs.comparison->>'parse_error' AS parse_error,
    route->>'code' AS route_code,direction->>'code' AS direction_code,direction->>'name' AS direction_name,
    COALESCE(direction->>'effective_date',docs.extraction->>'effective_date',docs.source_effective_date::text) AS effective_date,
    day.value AS service_day,
    md5(jsonb_build_object('route',route->>'name','direction',direction->>'name','services',
      jsonb_agg((service-'trips') || jsonb_build_object('trips',matching.trips)))::text) AS fingerprint
  FROM documents docs
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(docs.extraction->'routes','[]')) route
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(route->'directions','[]')) direction
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(direction->'services','[]')) service
  CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(service->'service_days','[]')) day(value)
  CROSS JOIN LATERAL (SELECT jsonb_agg(trip) AS trips FROM jsonb_array_elements(service->'trips') trip
    WHERE COALESCE(trip->'service_days',service->'service_days') ? day.value) matching
  WHERE matching.trips IS NOT NULL
  GROUP BY docs.source_id,docs.id,docs.pending_version_id,docs.source_url,docs.review_status,docs.comparison,
    route->>'code',route->>'name',direction->>'code',direction->>'name',direction->>'effective_date',
    docs.extraction->>'effective_date',docs.source_effective_date,day.value;`;

function prepareSections(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.timetable_number)) groups.set(row.timetable_number, []);
    const prepared = { ...row };
    for (const key of ['approved', 'pending']) {
      const version = row[key];
      if (!version || version.parse_error || !['approved', 'pending'].includes(version.review_status)) {
        prepared[key] = null;
        continue;
      }
      let summary = version.policy_summary;
      try { if (summary?.policy_version !== POLICY_VERSION) summary = policySummary(version.extraction); }
      catch { prepared[key] = null; continue; }
      prepared[key] = { ...version, policy_summary: summary, section_id: row.id, source_id: row.source_id,
        timetable_number: row.timetable_number, catalogue_key: row.catalogue_key, isPending: key === 'pending' };
    }
    groups.get(row.timetable_number).push(prepared);
  }
  return groups;
}

function changedFamily(before, after) {
  return !before || !after || before.unchanged_sha256 !== after.unchanged_sha256
    || before.content_sha256 !== after.content_sha256 || before.structure_sha256 !== after.structure_sha256;
}

function sectionPending(rows, published, family) {
  if (!rows?.length || rows.some(row => row.withdrawn)) return null;
  let baseline = published.policy_summary;
  try { if (baseline?.policy_version !== POLICY_VERSION && published.section_extraction) baseline = policySummary(published.section_extraction); }
  catch { return null; }
  const candidates = rows.filter(row => row.status !== 'withdrawn').map(row => row.pending || row.approved).filter(Boolean);
  let winners;
  try { winners = [...policyWinners(candidates).values()].filter(winner => winner.family === family); }
  catch {
    // An equal-priority conflict still needs a commuter notice, but never a
    // promise about which proposed effective date will win manual review.
    const copies = candidates.filter(record => record.policy_summary.families[family]).map(record => ({
      record, effectiveDate: record.policy_summary.effective_date,
      ...record.policy_summary.families[family], override: Boolean(record.source_override),
      ownRoute: record.catalogue_key.slice(0, 4) === record.timetable_number.slice(0, 4),
    })).sort((a, b) => priority(b, a));
    winners = copies.filter(copy => priority(copy, copies[0]) === 0);
  }
  const changed = winners.filter(winner => winner.record.isPending && (
    changedFamily(baseline?.families?.[family], winner.record.policy_summary.families[family])
    || date(published.effective_date || baseline?.effective_date) !== date(winner.effectiveDate)));
  // A changed revision can remove a service family or cause publication to
  // fall back to another PDF. Both require notice while old trips remain live.
  for (const row of rows) {
    if (row.pending && String(row.approved?.id) === String(published.section_version_id)
      && row.approved.policy_summary.families[family] && !row.pending.policy_summary.families[family]
      && (!winners.length || winners.some(winner => changedFamily(baseline?.families?.[family], winner.record.policy_summary.families[family])
        || date(published.effective_date || baseline?.effective_date) !== date(winner.effectiveDate)))) {
      changed.push({ record: row.pending, effectiveDate: row.pending.policy_summary.effective_date });
    }
  }
  if (!changed.length) return null;
  return { effective_date: winners.length > 1 ? null : date(changed[0].effectiveDate), source_url: changed[0].record.source_url };
}

function legacyPending(rows, published, day) {
  const matches = row => String(row.source_id) === String(published.source_id) && row.route_code === published.code
    && (published.direction_code ? row.direction_code === published.direction_code : row.direction_name === published.direction_name)
    && row.service_day === day;
  const before = rows.find(row => matches(row) && String(row.version_id) === String(published.source_version_id));
  const after = rows.find(row => matches(row) && row.pending && row.review_status === 'pending' && !row.parse_error);
  if (!after) {
    const replacement = rows.find(row => String(row.source_id) === String(published.source_id)
      && row.pending && row.review_status === 'pending' && !row.parse_error);
    // An absent day/direction in an otherwise parsed replacement is a service
    // removal, not evidence that the old published times remain unchanged.
    return before && replacement ? { effective_date: null, source_url: replacement.source_url } : null;
  }
  if (before && before.fingerprint === after.fingerprint && date(before.effective_date) === date(after.effective_date)) return null;
  return { effective_date: date(after.effective_date), source_url: after.source_url };
}

function buildTimetableStatus(publishedRows, sectionRows = [], legacyRows = [], { now = new Date() } = {}) {
  const today = currentCapeTownDate(now), sections = prepareSections(sectionRows), routes = new Map();
  const directionDays = new Map();
  for (const row of publishedRows) {
    const key = `${row.route_id}:${row.direction_id}`;
    if (!directionDays.has(key)) directionDays.set(key, new Set());
    for (const day of SERVICE_DAYS) if (row[day]) directionDays.get(key).add(day);
  }
  const additionsHandled = new Set();
  for (const published of publishedRows) {
    const routeKey = `${published.agency}:${published.route_id}`;
    if (!routes.has(routeKey)) routes.set(routeKey, { agency: published.agency, code: published.code,
      route_id: Number(published.route_id), directions: [] });
    const route = routes.get(routeKey);
    const number = published.timetable_number || (published.agency === 'GABS' && /^\d{2}$/.test(published.direction_code || '')
      ? `${published.code}${published.direction_code}` : null);
    const validUntil = published.agency === 'GABS' ? gabsValidUntil(published.source_url, number) : null;
    const originalDays = SERVICE_DAYS.filter(day => published[day]);
    const directionKey = `${published.route_id}:${published.direction_id}`;
    let addedDays = [];
    if (!additionsHandled.has(directionKey)) {
      additionsHandled.add(directionKey);
      const candidates = published.section_version_id
        ? (sections.get(number) || []).flatMap(row => Object.values(row.pending?.policy_summary.families || {})
          .flatMap(family => family.service_days || []))
        : legacyRows.filter(row => String(row.source_id) === String(published.source_id) && row.pending
          && row.route_code === published.code && (published.direction_code
            ? row.direction_code === published.direction_code : row.direction_name === published.direction_name))
          .map(row => row.service_day);
      addedDays = [...new Set(candidates)].filter(day => !directionDays.get(directionKey).has(day));
    }
    const days = SERVICE_DAYS.filter(day => originalDays.includes(day) || addedDays.includes(day));
    for (const day of days) {
      const family = Object.keys(FAMILY_DAYS).find(key => FAMILY_DAYS[key].includes(day));
      const pending = published.section_version_id
        ? sectionPending(sections.get(number), published, family)
        : legacyPending(legacyRows, published, day);
      const isAddition = addedDays.includes(day);
      if (isAddition && !pending) continue;
      const contribution = { id: Number(published.direction_id), name: published.direction_name,
        service_days: [], effective_date: isAddition ? null : date(published.effective_date || published.policy_summary?.effective_date || published.source_effective_date),
        valid_until: isAddition ? null : validUntil, expired: Boolean(!isAddition && validUntil && validUntil < today), pending: Boolean(pending),
        pending_effective_date: pending?.effective_date || null,
        official_source_url: published.source_url || null, pending_source_url: pending?.source_url || null };
      const key = JSON.stringify(contribution);
      let existing = route.directions.find(item => item.key === key);
      if (!existing) { existing = { key, value: contribution }; route.directions.push(existing); }
      if (!existing.value.service_days.includes(day)) existing.value.service_days.push(day);
    }
  }
  return { checked_at: now.toISOString(), routes: [...routes.values()].map(route => ({ ...route,
    directions: route.directions.map(item => ({ ...item.value, service_days: SERVICE_DAYS.filter(day => item.value.service_days.includes(day)) })) })) };
}

async function getTimetableStatus(database, options = {}) {
  // Read-only on purpose: public requests must not run schema migrations.
  const [published, sections, legacy] = await Promise.all([
    database.query(PUBLISHED_SQL), database.query(SECTIONS_SQL), database.query(LEGACY_SQL),
  ]);
  return buildTimetableStatus(published.rows, sections.rows, legacy.rows, options);
}

function createTimetableStatusHandler(database) {
  return async (_req, res) => {
    try {
      const status = await getTimetableStatus(database);
      res.set('Cache-Control', STATUS_CACHE_CONTROL).json(status);
    } catch (error) {
      console.error('Unable to load timetable status', error.message);
      res.set('Cache-Control', 'no-store').status(503).json({ error: 'Timetable update information is temporarily unavailable.' });
    }
  };
}

module.exports = { buildTimetableStatus, createTimetableStatusHandler, getTimetableStatus, gabsValidUntil, STATUS_CACHE_CONTROL };
