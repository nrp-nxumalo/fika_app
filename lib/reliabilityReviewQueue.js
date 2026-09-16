const REVIEW_PATH = '/admin/timetable-reliability';
const REVIEW_STATES = {
  ready: 'Ready to approve',
  pending: 'All pending reviews',
  blocked: 'Parser errors',
  future: 'Not effective yet',
  conflict: 'Conflicting section copies',
  sections: 'Review by section',
  current: 'No pending version',
};
const SORTS = { ready: 'Ready to approve first', source: 'Source / timetable number' };
const STATUSES = { verified: 'Verified', changed_review_required: 'Review required', withdrawn: 'Withdrawn' };

function normalizeQuery(query = {}) {
  const string = key => typeof query[key] === 'string' ? query[key].trim() : '';
  const choice = (key, values, fallback = '') => values.includes(string(key)) ? string(key) : fallback;
  const page = key => /^[1-9]\d{0,6}$/.test(string(key)) ? string(key) : '1';
  return {
    q: string('q').slice(0, 200), operator: string('operator').slice(0, 80),
    status: choice('status', Object.keys(STATUSES)),
    review: choice('review', Object.keys(REVIEW_STATES)),
    sort: choice('sort', Object.keys(SORTS), 'ready'),
    per_page: choice('per_page', ['10', '25', '50'], '10'),
    source_page: page('source_page'), section_page: page('section_page'),
  };
}

function reviewUrl(query, changes = {}, anchor = '') {
  const params = new URLSearchParams(normalizeQuery({ ...query, ...changes }));
  return `${REVIEW_PATH}?${params}${anchor ? `#${anchor}` : ''}`;
}

// Rebuild a local URL from known query fields; never redirect to a posted URL.
function reviewReturnUrl(value, anchor = 'sources') {
  return reviewUrl(Object.fromEntries(new URLSearchParams(typeof value === 'string' ? value : '')), {}, anchor);
}

function sectionCopies(group) {
  return group.variants.flatMap(variant => variant.copies);
}

function sectionReviewState(copy, group, today) {
  if (!copy.pending_version_id) return 'current';
  if (copy.parse_error) return 'blocked';
  if (copy.effective_date && String(copy.effective_date).slice(0, 10) > today) return 'future';
  if (group.conflicting_copies || copy.missing_from_document) return 'conflict';
  return 'ready';
}

function buildReviewQueues(sources, groups, query, sourceState, today) {
  const options = normalizeQuery(query);
  const search = options.q.toLowerCase();
  function matches(item, state, text) {
    return (!options.operator || item.operator === options.operator)
      && (!options.status || item.status === options.status)
      && (!options.review || (options.review === 'pending' ? Boolean(item.pending_version_id) : state === options.review))
      && (!search || text.toLowerCase().includes(search));
  }
  const compare = (a, b) => (options.sort === 'ready' ? a.rank - b.rank : 0)
    || a.key.localeCompare(b.key, 'en', { numeric: true }) || a.id - b.id;
  const rank = state => ({ ready: 0, conflict: 1, blocked: 2, future: 3, sections: 4, current: 5 })[state];
  const filteredSources = sources.map(source => ({
    item: source, state: sourceState(source), key: `${source.operator} ${source.source_key}`, id: Number(source.id),
  })).filter(row => matches(row.item, row.state,
    [row.item.operator, row.item.source_key, row.item.route_name, ...(row.item.direction_names || [])].join(' ')))
    .map(row => ({ ...row, rank: rank(row.state) })).sort(compare).map(row => row.item);
  const filteredGroups = groups.map(group => {
    const copies = sectionCopies(group);
    return { item: group, key: group.timetable_number, id: 0,
      rank: Math.min(...copies.map(copy => rank(sectionReviewState(copy, group, today)))),
      matches: copies.some(copy => matches({ ...copy, operator: 'GABS' }, sectionReviewState(copy, group, today),
        [group.timetable_number, copy.catalogue_key, copy.direction_name].join(' '))),
    };
  }).filter(row => row.matches).sort(compare).map(row => row.item);
  function paginate(items, key) {
    const size = Number(options.per_page);
    const pages = Math.max(1, Math.ceil(items.length / size));
    const page = Math.min(Number(options[key]), pages);
    options[key] = String(page);
    return { items: items.slice((page - 1) * size, page * size), total: items.length, page, pages,
      start: items.length ? (page - 1) * size + 1 : 0, end: Math.min(page * size, items.length) };
  }
  return { options, sources: paginate(filteredSources, 'source_page'), sections: paginate(filteredGroups, 'section_page') };
}

function renderFilters(options, operators, e) {
  const select = (name, label, choices, all) => `<label>${label}<select name="${name}">${all ? `<option value="">${all}</option>` : ''}${Object.entries(choices).map(([value, text]) => `<option value="${e(value)}"${options[name] === value ? ' selected' : ''}>${e(text)}</option>`).join('')}</select></label>`;
  return `<form class="review-filters" method="get" action="${REVIEW_PATH}">
    <label class="search-filter">Search sources and sections<input type="search" name="q" value="${e(options.q)}" placeholder="Route, source or timetable number"></label>
    ${select('operator', 'Operator', Object.fromEntries(operators.map(operator => [operator, operator])), 'All operators')}
    ${select('status', 'Status', STATUSES, 'All statuses')}
    ${select('review', 'Review queue', REVIEW_STATES, 'All reviews')}
    ${select('sort', 'Sort by', SORTS)}
    ${select('per_page', 'Per page', { 10: '10', 25: '25', 50: '50' })}
    <button class="approve" type="submit">Apply filters</button><a href="${REVIEW_PATH}">Clear filters</a>
  </form>`;
}

function renderPagination(queue, key, options, e) {
  const label = key === 'source_page' ? 'sources' : 'timetable sections';
  const anchor = key === 'source_page' ? 'sources' : 'sections';
  const link = (page, text) => `<a href="${e(reviewUrl(options, { [key]: String(page) }, anchor))}">${text}</a>`;
  return `<nav class="pagination" aria-label="${label} pages"><span>${queue.start}–${queue.end} of ${queue.total} ${label}</span>
    <div>${queue.page > 1 ? `${link(1, 'First')} ${link(queue.page - 1, 'Previous')}` : '<span aria-disabled="true">Previous</span>'}
    <strong>Page ${queue.page} of ${queue.pages}</strong>
    ${queue.page < queue.pages ? `${link(queue.page + 1, 'Next')} ${link(queue.pages, 'Last')}` : '<span aria-disabled="true">Next</span>'}</div></nav>`;
}

module.exports = { buildReviewQueues, normalizeQuery, renderFilters, renderPagination, reviewReturnUrl, sectionReviewState };
