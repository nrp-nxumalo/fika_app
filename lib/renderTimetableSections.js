function renderSectionReviews(routes, { escapeHtml: e, actionToken, comparisonSummary, returnField = '', today }, password) {
  if (!routes.length) return '';
  const labels = { needs_review: 'Needs review', eligible: 'Safe update awaiting publication', scheduled: 'Scheduled',
    automatic: 'Automatically updated', current: 'Current', withdrawn: 'Withdrawn' };
  return routes.map(route => `<article class="section-review"><h3>Route ${e(route.route_code)}${route.route_name ? ` · ${e(route.route_name)}` : ''}</h3>
    ${route.timetables.map(group => {
      const copies = group.copies || group.variants.flatMap(v => v.copies);
      const decision = group.decision || { state: copies.some(c => c.pending_version_id) ? 'needs_review' : 'current', reasons: [],
        current_dates: [], proposed_dates: [], families: [], selected_version_ids: [], snapshot: '' };
      const selected = copies.find(c => (decision.winning_version_ids || decision.selected_version_ids).includes(String(c.version_id))) || copies[0];
      const future = decision.proposed_dates.some(date => date && date > today);
      const pending = copies.filter(c => c.pending_version_id && !c.parse_error);
      const variants = [...new Map(pending.map(c => [c.content_sha256, c])).values()];
      const held = decision.state === 'withdrawn';
      const identifier = `${group.timetable_number}:${decision.snapshot}`;
      const fields = `${returnField}<input type="hidden" name="snapshot" value="${e(decision.snapshot)}">`;
      return `<section class="timetable-decision"><h4>Timetable ${e(group.timetable_number)} · ${e(selected?.direction_name || 'Direction not parsed')}</h4>
        <p><strong>${e(labels[decision.state] || decision.state)}</strong> · ${e((decision.service_days || decision.families).join(', ').replaceAll('_', ' '))}</p>
        <p>Current timetable effective date: ${e(decision.current_dates.filter(Boolean).join(', ') || 'unknown')}
          · Proposed timetable effective date: ${e(decision.proposed_dates.filter(Boolean).join(', ') || 'unknown')}</p>
        ${decision.reasons.map(reason => `<p class="parse-error">${e(reason)}</p>`).join('')}
        ${selected?.pending_version_id ? `<p>${comparisonSummary({ ...selected.comparison,
          ...(['times_or_dates','unchanged'].includes(decision.category) ? { structural_changes: {} } : {}) })}</p>` : ''}
        ${(decision.trip_changes || []).length && pending.length ? `<p>${decision.trip_changes.map(change => `${e(change.family.replaceAll('_',' '))}: ${Number(change.before)} → ${Number(change.after)} trips`).join(' · ')}</p>` : ''}
        ${decision.state === 'eligible' ? '<p>Only existing trip times or effective dates changed, or this is identical evidence. Automatic publishing must be enabled to apply eligible updates during daily checks.</p>' : ''}
        ${decision.state === 'scheduled' ? '<p>The current timetable stays live. This update will be rechecked when its effective date arrives.</p>' : ''}
        ${pending.length && !['current','automatic'].includes(decision.state) ? `<form method="post" action="/admin/timetable-reliability/timetables/${e(group.timetable_number)}/approve">
          ${fields}<input type="hidden" name="token" value="${actionToken(password, 'timetable-approve', identifier)}">
          ${held ? '<input type="hidden" name="restore" value="yes">' : ''}
          <label>Source revision<select name="selected_version_id"><option value="">Use preferred revisions for each service family</option>
            ${variants.map(c => `<option value="${Number(c.version_id)}">Explicitly select catalogue ${e(c.catalogue_key)} · timetable effective ${e(c.effective_date || 'unknown')}</option>`).join('')}</select></label>
          <p class="muted">An explicit source selection replaces an earlier override for this exact revision. Identical copies share this decision.</p>
          <label>Review note<input name="note" required maxlength="500"></label>
          <button class="approve" type="submit"${future && variants.every(c => c.effective_date && c.effective_date > today) ? ' disabled' : ''}>${held ? 'Restore timetable and publish' : 'Approve timetable and publish'}</button>
          ${future ? '<p class="muted">Future revisions cannot publish before their timetable effective date.</p>' : ''}</form>` : ''}
        ${!held ? `<details><summary>Withdraw this timetable direction</summary><form method="post" action="/admin/timetable-reliability/timetables/${e(group.timetable_number)}/withdraw">
          ${fields}<input type="hidden" name="token" value="${actionToken(password, 'timetable-withdraw', identifier)}">
          <p>This removes timetable ${e(group.timetable_number)} across all catalogue PDFs. Other directions are retained.</p>
          <label>Withdrawal evidence<input name="note" required maxlength="500"></label><button class="danger" type="submit">Withdraw timetable across all PDFs</button>
        </form></details>` : ''}
        <details><summary>PDF evidence (${copies.length} ${copies.length === 1 ? 'copy' : 'copies'})</summary>
          ${copies.map(copy => `<div class="section-copy"><p><strong>Catalogue PDF ${e(copy.catalogue_key)}</strong> · ${copy.own_route ? 'Own-route PDF' : 'Mixed PDF'}
            · Timetable ${e(group.timetable_number)} effective date: ${e(copy.effective_date || 'unknown')}
            · Catalogue entry effective date: ${e(copy.catalogue_effective_date || 'unknown')}
            ${copy.source_override ? ' · Reviewer-selected revision' : ''}</p>
            ${copy.missing_from_document ? '<p class="parse-error">Absent from the latest document; published service retained pending review.</p>' : ''}
            ${copy.parse_error ? `<p class="parse-error">${e(copy.parse_error)}</p>` : ''}
            <p>${(copy.evidence || []).map(item => `<a href="/admin/timetable-reliability/versions/${Number(item.document_version_id)}/pdf#page=${Number(item.pages?.[0] || 1)}">Captured PDF · pages ${e((item.pages || []).join(', '))}</a>`).join(' · ')}
            ${copy.version_id ? ` · <a href="/admin/timetable-reliability/section-versions/${Number(copy.version_id)}/comparison">Comparison and extraction</a>` : ''}
            ${group.preferred_version_id && copy.version_id && String(group.preferred_version_id) !== String(copy.version_id) && !copy.parse_error ? ` · <a href="/admin/timetable-reliability/section-versions/${Number(copy.version_id)}/comparison?against=${Number(group.preferred_version_id)}">Differences from preferred copy</a>` : ''}</p></div>`).join('')}
        </details></section>`;
    }).join('')}</article>`).join('');
}
module.exports = { renderSectionReviews };
