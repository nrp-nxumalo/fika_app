const { normalizeQuery, buildReviewQueues } = require('./reliabilityReviewQueue');
const { readSectionReviewIndex, readSectionReviews, groupRouteReviews } = require('./timetableSectionReview');
const { currentCapeTownDate } = require('./timetablePublisher');

// Keep filter/count queries on compact columns. Large comparisons and PDF
// evidence are loaded only for the selected page, after filtering and LIMIT.
const SOURCE_INDEX = `WITH indexed AS (
  SELECT s.*,p.pdf_sha256 AS pending_pdf_sha256,p.source_effective_date AS pending_source_effective_date,
    CASE WHEN s.section_mode THEN 'sections' WHEN s.pending_version_id IS NULL THEN 'current'
      WHEN p.comparison->>'parse_error' IS NOT NULL THEN 'blocked'
      WHEN p.source_effective_date>$1::date THEN 'future' ELSE 'ready' END AS review_state
  FROM timetable_sources s LEFT JOIN timetable_source_versions p ON p.id=s.pending_version_id
), filtered AS (SELECT * FROM indexed WHERE
  ($2='' OR operator=$2) AND ($3='' OR status=$3)
  AND ($4='' OR ($4='needs_review' AND review_state IN ('ready','blocked'))
    OR ($4='pending' AND pending_version_id IS NOT NULL) OR review_state=$4)
  AND ($5='' OR strpos(lower(concat_ws(' ',operator,source_key,route_name,array_to_string(direction_names,' '))),lower($5))>0))`;

function pageInfo(total, requested, size) {
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(Number(requested), pages);
  return { total, page, pages, start: total ? (page - 1) * size + 1 : 0, end: Math.min(page * size, total) };
}

async function readAdminReviewPage(database, query) {
  const started = Date.now();
  const options = normalizeQuery(query);
  const today = currentCapeTownDate();
  const args = [today,options.operator,options.status,options.review,options.q];
  const total = Number((await database.query(`${SOURCE_INDEX} SELECT count(*) AS total FROM filtered;`,args)).rows[0].total);
  const sourcePage = pageInfo(total, options.source_page, Number(options.per_page));
  options.source_page = String(sourcePage.page);
  const sourceResult = await database.query(`${SOURCE_INDEX}
    SELECT f.*,jsonb_build_object('parse_error',p.comparison->'parse_error','has_changes',p.comparison->'has_changes',
      'previous_scheduled_departure_count',p.comparison->'previous_scheduled_departure_count',
      'current_scheduled_departure_count',p.comparison->'current_scheduled_departure_count',
      'changed_time_count',p.comparison->'changed_time_count','added_time_count',p.comparison->'added_time_count',
      'removed_time_count',p.comparison->'removed_time_count','structural_changes',p.comparison->'structural_changes') AS pending_comparison,
      p.pdf_size_bytes AS pending_pdf_size_bytes,p.document_issues
    FROM filtered f LEFT JOIN timetable_source_versions p ON p.id=f.pending_version_id
    ORDER BY CASE WHEN $6='ready' THEN CASE f.review_state WHEN 'ready' THEN 0 WHEN 'blocked' THEN 2
      WHEN 'future' THEN 3 WHEN 'sections' THEN 4 ELSE 5 END ELSE 0 END,
      f.operator,regexp_replace(f.source_key,'[0-9]+$',''),
      length(substring(f.source_key from '[0-9]+$')),substring(f.source_key from '[0-9]+$'),f.source_key,f.id
    LIMIT $7 OFFSET $8;`,[...args,options.sort,Number(options.per_page),(sourcePage.page-1)*Number(options.per_page)]);
  const index = options.operator && options.operator !== 'GABS' ? [] : await readSectionReviewIndex(database);
  const queues = buildReviewQueues([], index, options, () => 'current', today);
  queues.sources = { ...sourcePage, items: sourceResult.rows };
  queues.options.source_page = String(sourcePage.page);
  const numbers = queues.sections.items.flatMap(route => route.timetables.map(group => group.timetable_number));
  const detailed = numbers.length ? await readSectionReviews(database, { numbers }) : [];
  const byRoute = new Map(groupRouteReviews(detailed).map(route => [route.route_code,route]));
  queues.sections.items = queues.sections.items.map(route => byRoute.get(route.route_code) || route);
  const operators = (await database.query('SELECT DISTINCT operator FROM timetable_sources ORDER BY operator;')).rows.map(row => row.operator);
  const problems = await database.query(`SELECT s.source_key,p.document_issues,c.error AS latest_check_error
    FROM timetable_sources s LEFT JOIN timetable_source_versions p ON p.id=s.pending_version_id
    LEFT JOIN LATERAL (SELECT error FROM timetable_source_check_results WHERE source_id=s.id ORDER BY id DESC LIMIT 1) c ON true
    WHERE s.section_mode AND (jsonb_array_length(p.document_issues)>0 OR c.error IS NOT NULL)
    ORDER BY s.source_key LIMIT 50;`);
  console.log(JSON.stringify({ event: 'timetable_admin_page_data', durationMs: Date.now()-started,
    sourceCount: total, routeCount: queues.sections.total, loadedTimetables: numbers.length }));
  return { queues, operators, sources: sourceResult.rows, sectionGroups: detailed, documentIssues: problems.rows };
}
module.exports = { readAdminReviewPage, pageInfo };
