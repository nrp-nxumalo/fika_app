const { createHash } = require('node:crypto');
const { sectionContributions, stableJson } = require('./timetableSectionPublisher');
const { loadTimetableStates } = require('./gabsTimetableWorkflow');
const { evaluateTimetable, POLICY_VERSION, reviewSnapshot } = require('./gabsTimetablePolicy');

async function readSectionReviews(database, { publicOnly = false, numbers = null } = {}) {
  const { rows } = await database.query(`
    SELECT sections.*, sources.source_key AS catalogue_key,
      versions.id AS version_id, versions.document_version_id, versions.content_sha256,
      versions.review_summary,
      CASE WHEN versions.review_summary='{}'::jsonb THEN versions.extraction END AS extraction,
      versions.parse_error, ${publicOnly ? "'{}'::jsonb" : `jsonb_build_object(
        'changed_time_count',versions.comparison->'changed_time_count',
        'added_time_count',versions.comparison->'added_time_count',
        'removed_time_count',versions.comparison->'removed_time_count',
        'previous_scheduled_departure_count',versions.comparison->'previous_scheduled_departure_count',
        'current_scheduled_departure_count',versions.comparison->'current_scheduled_departure_count')`} AS comparison, versions.source_pages,
      versions.review_status, versions.source_override, versions.approval_method,
      EXISTS(SELECT 1 FROM trips t JOIN timetable_section_versions sv ON sv.id=t.timetable_section_version_id
        WHERE sv.section_id=sections.id) AS published,
      documents.source_url, documents.pdf_sha256,
      ${publicOnly ? "'[]'::jsonb" : `COALESCE((SELECT jsonb_agg(jsonb_build_object('document_version_id',o.document_version_id,
        'pages',o.source_pages) ORDER BY o.document_version_id DESC)
        FROM timetable_section_observations o WHERE o.section_version_id=versions.id),'[]')`} AS evidence
    FROM timetable_sections sections
    JOIN timetable_sources sources ON sources.id=sections.source_id
    LEFT JOIN timetable_section_versions versions ON versions.id=COALESCE(sections.pending_version_id,sections.approved_version_id,
      (SELECT historical.id FROM timetable_section_versions historical WHERE historical.section_id=sections.id ORDER BY historical.id DESC LIMIT 1))
    LEFT JOIN timetable_source_versions documents ON documents.id=versions.document_version_id
    WHERE sources.section_mode AND ($1::text[] IS NULL OR sections.timetable_number=ANY($1::text[]))
    ORDER BY sections.timetable_number,sections.source_id;
  `, [numbers]);
  if (!rows.length) return [];
  const states = new Map((await loadTimetableStates(database, { numbers })).map(state => [state.number, state]));
  return groupSectionReviews(rows).map(group => {
    const state = states.get(group.timetable_number);
    if (!state) return group;
    group.decision = evaluateTimetable(state.rows, state.control);
    group.route_name = state.rows[0].pending?.policy_summary?.route_name
      || state.rows[0].approved?.policy_summary?.route_name || state.rows[0].route_name;
    group.control = state.control;
    group.conflicting_copies = group.decision.category === 'conflict';
    group.change_alert_count = ['needs_review', 'eligible'].includes(group.decision.state) ? 1 : 0;
    for (const copy of group.copies) {
      const row = state.rows.find(r => String(r.id) === String(copy.id));
      copy.catalogue_effective_date = row?.catalogue_effective_date || null;
      copy.current_effective_date = row?.approved?.policy_summary?.effective_date || null;
    }
    return group;
  });
}

// Policy filtering needs compact metadata for all copies, but PDF evidence,
// publication provenance and extraction fallbacks are fetched only for the page.
async function readSectionReviewIndex(database) {
  const states = await loadTimetableStates(database, { compact: true });
  const groups = [];
  for (const state of states) {
    const unavailable = state.rows.some(row => [row.pending,row.approved].some(version =>
      version && !version.parse_error && version.policy_summary?.policy_version !== POLICY_VERSION));
    const decision = unavailable ? { state: state.control.withdrawn ? 'withdrawn' : 'needs_review',
      category: 'summary_pending', snapshot: reviewSnapshot(state.rows,state.control), reasons: ['Review summary is being prepared.'] }
      : evaluateTimetable(state.rows, state.control);
    groups.push({ timetable_number: state.number, decision,
      route_name: state.rows[0].pending?.policy_summary?.route_name || state.rows[0].approved?.policy_summary?.route_name || state.rows[0].route_name,
      copies: state.rows.map(row => ({ ...row,
        direction_name: row.pending?.policy_summary?.direction_name || row.pending?.review_summary?.direction_name
          || row.approved?.policy_summary?.direction_name || row.approved?.review_summary?.direction_name || '',
      })),
    });
    // Leave time for enqueues and status responses on large catalogues.
    if (groups.length % 25 === 0) await new Promise(resolve => setImmediate(resolve));
  }
  return groups;
}

function reviewSummary(extraction) {
  if (!extraction) return {};
  const contributions = sectionContributions({ extraction, sourceKey: extraction.source_key,
    catalogueKey: extraction.source_key });
  return { effective_date: extraction.effective_date,
    direction_name: extraction.routes[0].directions[0].name,
    families: Object.fromEntries([...contributions.values()].map(c => [c.family, {
      content_sha256: createHash('sha256').update(c.signature).digest('hex'), trip_count: c.trips.length,
    }])) };
}

function groupSectionReviews(rows) {
  const groups = new Map();
  for (const row of rows) {
    const number = row.timetable_number;
    if (!groups.has(number)) groups.set(number, { timetable_number: number, copies: [], variants: [] });
    const summary = row.review_summary?.families ? row.review_summary : reviewSummary(row.extraction);
    groups.get(number).copies.push({ ...row, review_summary: summary,
      own_route: row.catalogue_key.slice(0, 4) === number.slice(0, 4),
      effective_date: summary.effective_date || null,
      direction_name: summary.direction_name || '',
    });
  }
  for (const group of groups.values()) {
    group.copies.sort((a, b) => Number(Boolean(b.source_override)) - Number(Boolean(a.source_override))
      || Number(b.own_route) - Number(a.own_route)
      || String(b.effective_date || '').localeCompare(String(a.effective_date || ''))
      || Number(a.id) - Number(b.id));
    const preferred = group.copies.find(c => c.version_id && !c.parse_error && c.status !== 'withdrawn');
    group.preferred_section_id = preferred?.id || null;
    group.preferred_version_id = preferred?.version_id || null;
    const byHash = new Map();
    for (const copy of group.copies) {
      const key = copy.content_sha256 || `unparsed:${copy.id}`;
      if (!byHash.has(key)) byHash.set(key, { content_sha256: copy.content_sha256, copies: [] });
      byHash.get(key).copies.push(copy);
    }
    group.variants = [...byHash.values()];
    // Use the same service families as publication; holiday-only copies coexist.
    const signatures = new Map();
    for (const copy of group.copies.filter(c => !c.parse_error && c.status !== 'withdrawn')) {
      for (const [family, summary] of Object.entries(copy.review_summary.families || {})) {
        if (!signatures.has(family)) signatures.set(family, new Set());
        signatures.get(family).add(summary.content_sha256);
      }
    }
    group.conflicting_copies = [...signatures.values()].some(s => s.size > 1);
    group.change_alert_count = group.variants.filter(v => v.copies.some(c => c.pending_version_id)).length;
  }
  return [...groups.values()];
}

function compareSectionCopies(previous, current) {
  if (!previous || !current || previous.source_key !== current.source_key) {
    throw new Error('Compare two valid copies of the same timetable number.');
  }
  const changes = [];
  let changeCount = 0;
  function visit(before, after, path) {
    if (stableJson(before) === stableJson(after)) return;
    if (before && after && typeof before === 'object' && typeof after === 'object') {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
        visit(before[key], after[key], `${path}/${key}`);
      }
    } else {
      changeCount += 1;
      if (changes.length < 100) changes.push({ path, before: before ?? null, after: after ?? null });
    }
  }
  visit(previous, current, '');
  return { change_count: changeCount, changes, truncated: changeCount > changes.length };
}

function publicSectionSummaries(groups) {
  return groups.map(group => ({ timetable_number: group.timetable_number,
    review_disposition: group.decision?.state || null,
    review_reasons: group.decision?.reasons || [],
    conflicting_copies: group.conflicting_copies, change_alert_count: group.change_alert_count,
    copies: group.copies.map(copy => ({ section_id: Number(copy.id), source_id: Number(copy.source_id),
      catalogue_key: copy.catalogue_key, status: copy.status, direction: copy.direction_name,
      effective_date: copy.effective_date, catalogue_effective_date: copy.catalogue_effective_date || null,
      approval_method: copy.approval_method || (copy.approved_version_id ? 'manual' : null), own_route: copy.own_route,
      approved_section_version_id: copy.approved_version_id && Number(copy.approved_version_id),
      pending_section_version_id: copy.pending_version_id && Number(copy.pending_version_id),
      content_sha256: copy.content_sha256, pdf_sha256: copy.pdf_sha256, source_pages: copy.source_pages,
      official_source_url: copy.source_url, parse_error: copy.parse_error,
      published: copy.published, last_manually_verified_on: copy.last_manually_verified_on,
      missing_from_document: copy.missing_from_document })) }));
}

function groupRouteReviews(groups) {
  const routes = new Map();
  for (const group of groups) {
    const code = group.timetable_number.slice(0, 4);
    if (!routes.has(code)) routes.set(code, { route_code: code, route_name: group.route_name || '', timetables: [] });
    routes.get(code).timetables.push(group);
  }
  return [...routes.values()];
}

module.exports = { readSectionReviewIndex, readSectionReviews, reviewSummary, groupSectionReviews, groupRouteReviews, publicSectionSummaries, compareSectionCopies };
