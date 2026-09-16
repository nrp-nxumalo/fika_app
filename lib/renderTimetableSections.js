function renderSectionReviews(groups, { escapeHtml: e, actionToken, comparisonSummary, returnField = '', today }, password) {
  if (!groups.length) return '';
  return `<p>Each timetable number is reviewed independently. Identical copies share a change alert. Source conflicts apply only to overlapping service days.</p>${groups.map(group => `
    <article class="section-review"><h3>Timetable ${e(group.timetable_number)}</h3>
    ${group.conflicting_copies ? '<p class="parse-error">Different copies describe overlapping service days. Prefer the own-route PDF, or record an explicit source override.</p>' : ''}
    ${group.variants.map(variant => `<details open><summary>${variant.copies.length > 1 ? `${variant.copies.length} identical copies · ` : ''}${e(variant.copies[0].direction_name || 'Section could not be parsed')}</summary>
      ${variant.copies.map(copy => {
        const versionId = copy.version_id;
        const approveId = `${copy.id}:${versionId}:${copy.content_sha256}`;
        const withdrawalVersion = copy.approved_version_id || copy.pending_version_id;
        const futureEffective = today && copy.effective_date && String(copy.effective_date).slice(0, 10) > today;
        return `<div class="section-copy">
          <p><strong>Catalogue ${e(copy.catalogue_key)}</strong> · ${copy.own_route ? 'Own-route PDF' : 'Mixed PDF'}
          ${String(copy.id) === String(group.preferred_section_id) ? ' · Preferred source' : ''}${copy.source_override ? ' · Reviewer-selected revision' : ''}
          · Effective ${e(copy.effective_date || 'not printed')} · ${e(copy.status)}</p>
          ${copy.missing_from_document ? '<p class="parse-error">Absent from the latest complete document; published service retained pending review.</p>' : ''}
          <p>${(copy.evidence || []).map(item => `<a href="/admin/timetable-reliability/versions/${Number(item.document_version_id)}/pdf#page=${Number(item.pages?.[0] || 1)}">Captured PDF${item.pages?.length ? ` · pages ${e(item.pages.join(', '))}` : ''}</a>`).join(' · ')}
          ${versionId ? ` · <a href="/admin/timetable-reliability/section-versions/${Number(versionId)}/comparison">Section comparison and extraction</a>` : ''}
          ${group.preferred_version_id && versionId && String(group.preferred_version_id) !== String(versionId) && !copy.parse_error ? ` · <a href="/admin/timetable-reliability/section-versions/${Number(versionId)}/comparison?against=${Number(group.preferred_version_id)}">Differences from preferred copy</a>` : ''}</p>
          ${copy.pending_version_id ? comparisonSummary(copy.comparison) : '<p>No pending changes.</p>'}
          ${copy.parse_error ? `<p class="parse-error">${e(copy.parse_error)}. Other timetable numbers can still be reviewed.</p>` : ''}
          ${copy.pending_version_id && !copy.parse_error ? `<form method="post" action="/admin/timetable-reliability/sections/${Number(copy.id)}/approve">
            ${returnField}
            <input type="hidden" name="version_id" value="${Number(versionId)}">
            <input type="hidden" name="token" value="${actionToken(password, 'section-approve', approveId)}">
            <label>Review note<input name="note" required maxlength="500"></label>
            <label><input type="checkbox" name="source_override" value="yes"> Explicitly prefer this exact revision over conflicting copies</label>
            <button class="approve" type="submit"${futureEffective ? ' disabled' : ''}>Approve copy and publish</button>${futureEffective ? `<p class="muted">Cannot publish before its effective date, ${e(copy.effective_date)}.</p>` : ''}</form>` : ''}
          ${copy.status !== 'withdrawn' && withdrawalVersion ? `<form method="post" action="/admin/timetable-reliability/sections/${Number(copy.id)}/withdraw">
            ${returnField}
            <input type="hidden" name="version_id" value="${Number(withdrawalVersion)}">
            <input type="hidden" name="token" value="${actionToken(password, 'section-withdraw', `${copy.id}:${withdrawalVersion}`)}">
            <label>Withdrawal evidence<input name="note" required maxlength="500"></label><button class="danger" type="submit">Withdraw this section copy</button></form>` : ''}
        </div>`;
      }).join('')}</details>`).join('')}
    </article>`).join('')}`;
}
module.exports = { renderSectionReviews };
