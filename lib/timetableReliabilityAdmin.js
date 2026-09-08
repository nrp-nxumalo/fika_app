const { readSectionReviews, compareSectionCopies } = require('./timetableSectionReview');
const { renderSectionReviews } = require('./renderTimetableSections');
const { approveSection, withdrawSection } = require('./timetableSectionPublisher');
const crypto = require('crypto');
const { isAuthorized, parseBasicAuthorization } = require('./adminSearchPerformance');
const { ensureTimetableReliabilitySchema } = require('./timetableReliabilitySchema');
const {
  approvePendingVersion,
  bulkApproveUnchangedVersions,
  isUnchangedComparison,
  withdrawSource,
} = require('./timetablePublisher');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function secureEqual(first, second) {
  const firstBuffer = Buffer.from(String(first || ''));
  const secondBuffer = Buffer.from(String(second || ''));
  return firstBuffer.length === secondBuffer.length && crypto.timingSafeEqual(firstBuffer, secondBuffer);
}

function actionToken(secret, action, identifier) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update(`${action}:${identifier}`)
    .digest('hex');
}

function formatDate(value) {
  if (!value) return 'Not recorded';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return String(value);
    const year = String(value.getFullYear()).padStart(4, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().slice(0, 10);
}

function formatDateTime(value) {
  if (!value) return 'Not recorded';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}

function johannesburgDate(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const dateParts = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}`;
}

function statusLabel(status) {
  return {
    verified: 'Verified',
    changed_review_required: 'Changed / review required',
    withdrawn: 'Withdrawn',
  }[status] || status;
}

function comparisonSummary(comparison) {
  const value = comparison && typeof comparison === 'object' ? comparison : {};
  if (value.parse_error) {
    return `<strong class="parse-error">Parser failed; publication is blocked.</strong><br>${escapeHtml(String(value.parse_error).slice(0, 1000))}`;
  }
  const before = value.previous_scheduled_departure_count ?? value.previous_departure_count ?? value.before_count ?? value.old_count;
  const after = value.current_scheduled_departure_count ?? value.candidate_departure_count ?? value.current_departure_count ?? value.after_count ?? value.new_count;
  const changed = value.changed_time_count ?? value.changed_times?.length ?? 0;
  const added = value.added_time_count ?? value.added_departure_count ?? value.added_times?.length ?? 0;
  const removed = value.removed_time_count ?? value.removed_departure_count ?? value.removed_times?.length ?? 0;
  const structuralChanges = Object.entries(value.structural_changes || {})
    .filter(([, change]) => change && change.changed === true)
    .map(([category]) => category.replaceAll('_', ' '));

  if (before == null && after == null) {
    return '<span class="muted">No approved baseline yet.</span>';
  }

  const structuralSummary = structuralChanges.length
    ? `; <strong>structural changes: ${escapeHtml(structuralChanges.join(', '))}</strong>`
    : '';
  return `${escapeHtml(before ?? '—')} → ${escapeHtml(after ?? '—')} departures; ` +
    `${escapeHtml(changed)} changed, ${escapeHtml(added)} added, ${escapeHtml(removed)} removed` +
    structuralSummary;
}

function isPendingVersionEffective(source, today = johannesburgDate()) {
  if (!source.pending_source_effective_date) return true;
  const effectiveDate = formatDate(source.pending_source_effective_date);
  return /^\d{4}-\d{2}-\d{2}$/.test(effectiveDate) && effectiveDate <= today;
}

function getBulkUnchangedCandidates(sources, today = johannesburgDate()) {
  return sources
    .filter((source) => (
      !source.section_mode && source.pending_version_id &&
      source.pending_pdf_sha256 &&
      isPendingVersionEffective(source, today) &&
      isUnchangedComparison(source.pending_comparison)
    ))
    .map((source) => ({
      sourceId: Number(source.id),
      versionId: Number(source.pending_version_id),
      pdfSha256: source.pending_pdf_sha256,
    }))
    .sort((first, second) => first.sourceId - second.sourceId);
}

function bulkApprovalIdentifier(candidates) {
  return JSON.stringify(candidates.map((candidate) => [
    candidate.sourceId,
    candidate.versionId,
    candidate.pdfSha256,
  ]));
}

function renderSources(sources, password) {
  if (!sources.length) {
    return '<p class="empty">No sources have been discovered. Run the daily checker first.</p>';
  }

  const today = johannesburgDate();
  const unchangedCandidates = getBulkUnchangedCandidates(sources, today);
  const bulkAction = unchangedCandidates.length ? `<form class="bulk-action" method="post" action="/admin/timetable-reliability/sources/bulk-approve-unchanged">
    <input type="hidden" name="token" value="${actionToken(password, 'bulk-approve-unchanged', bulkApprovalIdentifier(unchangedCandidates))}">
    <label>Review note<input name="note" required maxlength="500" value="unchanged"></label>
    <button class="approve" type="submit">Approve and publish ${unchangedCandidates.length} unchanged route${unchangedCandidates.length === 1 ? '' : 's'}</button>
  </form>` : '';

  return `${bulkAction}<div class="table-wrap"><table>
    <thead><tr><th>Source</th><th>Coverage</th><th>Fingerprint / versions</th><th>Review</th><th>Actions</th></tr></thead>
    <tbody>${sources.map((source) => {
      if (source.section_mode) return `<tr><td><strong>${escapeHtml(source.operator)} ${escapeHtml(source.source_key)}</strong><br>${escapeHtml(source.route_name)}</td><td colspan="4">Document evidence · review the individual timetable sections below.
        <p><a href="${escapeHtml(source.official_source_url)}">Official source</a> · Downloaded ${escapeHtml(formatDateTime(source.last_downloaded_at))}</p>
        ${source.latest_check_error ? `<p class="parse-error">Latest document check: ${escapeHtml(source.latest_check_error)}</p>` : ''}
        ${(source.document_issues || []).map(issue => `<p class="parse-error">${escapeHtml(issue.error)}</p>`).join('')}</td></tr>`;
      const approveIdentifier = `${source.id}:${source.pending_version_id || ''}:${source.pending_pdf_sha256 || ''}`;
      const withdrawIdentifier = `${source.id}:${source.approved_version_id || ''}`;
      const parseFailed = Boolean(source.pending_comparison?.parse_error);
      const pendingNotEffective = Boolean(source.pending_version_id) && !isPendingVersionEffective(source, today);
      return `<tr>
        <td><strong>${escapeHtml(source.operator)} ${escapeHtml(source.source_key)}</strong><br>${escapeHtml(source.route_name || 'Route not parsed')}<br><a href="${escapeHtml(source.official_source_url)}">official source</a><br><span class="status ${escapeHtml(source.status)}">${escapeHtml(statusLabel(source.status))}</span></td>
        <td>${escapeHtml((source.direction_names || []).join(' · ') || 'Not parsed')}<br><small>${escapeHtml((source.service_day_coverage || []).join(', ') || 'No days parsed')}</small><br><small>Effective ${escapeHtml(formatDate(source.source_effective_date))}</small></td>
        <td><code title="${escapeHtml(source.current_pdf_sha256 || '')}">${escapeHtml((source.current_pdf_sha256 || 'Not downloaded').slice(0, 16))}${source.current_pdf_sha256 ? '…' : ''}</code><br><small>${escapeHtml(source.parser_version)} / ${escapeHtml(source.import_version)}</small><br><small>Downloaded ${escapeHtml(formatDateTime(source.last_downloaded_at))}</small></td>
        <td>${source.pending_version_id ? `${comparisonSummary(source.pending_comparison)}<br><a href="/admin/timetable-reliability/versions/${Number(source.pending_version_id)}/pdf">captured PDF (${escapeHtml(source.pending_pdf_size_bytes)} bytes)</a><br><a href="/admin/timetable-reliability/versions/${Number(source.pending_version_id)}/comparison">full comparison JSON</a>` : '<span class="muted">No pending version.</span>'}</td>
        <td>
          ${source.pending_version_id && !parseFailed ? `<form method="post" action="/admin/timetable-reliability/sources/${Number(source.id)}/approve"><input type="hidden" name="version_id" value="${Number(source.pending_version_id)}"><input type="hidden" name="token" value="${actionToken(password, 'approve', approveIdentifier)}"><label>Review note<input name="note" required maxlength="500"></label><button class="approve" type="submit"${pendingNotEffective ? ` disabled title="Available from ${escapeHtml(formatDate(source.pending_source_effective_date))}"` : ''}>Approve and publish</button>${pendingNotEffective ? `<p class="muted">Cannot publish before its effective date, ${escapeHtml(formatDate(source.pending_source_effective_date))}.</p>` : ''}</form>` : ''}
          ${parseFailed ? '<p class="parse-error">Fix and version the parser, then run the daily check again. This PDF cannot be published.</p>' : ''}
          ${source.status !== 'withdrawn' ? `<form method="post" action="/admin/timetable-reliability/sources/${Number(source.id)}/withdraw"><input type="hidden" name="token" value="${actionToken(password, 'withdraw', withdrawIdentifier)}"><label>Withdrawal evidence<input name="note" required maxlength="500"></label><button class="danger" type="submit">Mark withdrawn and unpublish</button></form>` : ''}
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function renderAudit(audit, samples, password) {
  if (!audit) {
    return '<p class="empty">No weekly audit plan exists yet. The daily checker creates one per ISO week after approved sources are available.</p>';
  }

  const token = actionToken(password, 'audit', audit.id);
  return `
    <p><strong>Week ${escapeHtml(formatDate(audit.audit_week))}</strong> · ${escapeHtml(audit.sampled_count)} samples · status ${escapeHtml(audit.status)}</p>
    ${audit.citation_text ? `<p class="audit-result">${escapeHtml(audit.citation_text)}</p>` : ''}
    <form method="post" action="/admin/timetable-reliability/audits/${Number(audit.id)}">
      <input type="hidden" name="token" value="${token}">
      <div class="table-wrap"><table><thead><tr><th>PDF</th><th>Entry to compare</th><th>Kind</th><th>Result</th></tr></thead><tbody>
      ${samples.map((sample) => `<tr>
        <td><a href="/admin/timetable-reliability/versions/${Number(sample.source_version_id)}/pdf">${escapeHtml(sample.operator)} ${escapeHtml(sample.source_key)}</a><br><code>${escapeHtml((sample.pdf_sha256 || '').slice(0, 12))}…</code></td>
        <td><strong>${escapeHtml(sample.route_code)} ${escapeHtml(sample.route_name)}</strong><br>${escapeHtml(sample.direction_name)} · ${escapeHtml(sample.service_day)}<br>${escapeHtml(sample.stop_name)}: <strong>${escapeHtml(sample.expected_departure)}</strong>${(sample.footnote_markers || []).length ? ` · footnote ${escapeHtml(sample.footnote_markers.join(','))}` : ''}</td>
        <td>${escapeHtml(sample.sample_kind.replaceAll('_', ' '))}</td>
        <td><select name="sample_${Number(sample.id)}"><option value="">Not checked</option><option value="match"${sample.matched === true ? ' selected' : ''}>Matches PDF</option><option value="mismatch"${sample.matched === false ? ' selected' : ''}>Does not match</option></select></td>
      </tr>`).join('')}
      </tbody></table></div>
      <label>Audit notes<textarea name="notes" maxlength="2000">${escapeHtml(audit.notes || '')}</textarea></label>
      <button class="approve" type="submit">Save audit results</button>
    </form>`;
}

function renderAdminPage({ sources, checkRuns, audit, samples, sectionGroups = [] }, password) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Fika timetable reliability review</title>
  <style>:root{font-family:Inter,system-ui,sans-serif;color:#17211b;background:#f4f2ed}body{margin:0;padding:24px}main{max-width:1600px;margin:auto}section{background:#fff;border-radius:12px;box-shadow:0 2px 10px #17211b0d;margin:18px 0;padding:18px}.metrics{display:flex;gap:12px;flex-wrap:wrap}.metric{background:#eef3ef;border-radius:8px;padding:10px 14px}.bulk-action{align-items:end;background:#eef3ef;border-radius:8px;display:flex;gap:12px;margin-bottom:14px;padding:12px}.bulk-action label{flex:1;margin:0;max-width:420px}.table-wrap{overflow:auto}table{border-collapse:collapse;font-size:13px;width:100%}th,td{border-bottom:1px solid #e2e6e3;padding:9px;text-align:left;vertical-align:top}th{white-space:nowrap}td form{border-top:1px solid #eee;margin-top:8px;padding-top:8px}label{display:grid;font-size:12px;gap:4px;margin:6px 0}input,select,textarea{border:1px solid #abb7af;border-radius:5px;padding:7px}textarea{min-height:60px}button{border:0;border-radius:6px;color:white;cursor:pointer;font-weight:700;padding:8px 11px}button:disabled{background:#9ba39e;color:#eef0ef;cursor:not-allowed}.approve{background:#12643d}.danger{background:#9b2d2d}.parse-error{color:#9b2d2d}.status{border-radius:999px;display:inline-block;font-size:11px;font-weight:700;margin-top:5px;padding:3px 7px}.status.verified{background:#e4f5ea;color:#17683d}.status.changed_review_required{background:#fff1c9;color:#805b00}.status.withdrawn{background:#fbe4e4;color:#8e2525}.muted,.empty{color:#647067}pre{max-height:280px;overflow:auto;white-space:pre-wrap;width:420px}.audit-result{font-size:20px;font-weight:800}@media(max-width:800px){body{padding:10px}.bulk-action{align-items:stretch;flex-direction:column}}</style></head><body><main>
  <h1>Timetable reliability review</h1><p>Changes are staged here. “Approve and publish” is the only path from a candidate extraction to passenger-facing tables.</p>
  <div class="metrics">${checkRuns.length ? checkRuns.map((run) => `<div class="metric"><strong>${escapeHtml(run.status)}</strong><br>${escapeHtml(formatDateTime(run.finished_at || run.started_at))}<br><small>${escapeHtml(run.sources_changed)} changed · ${escapeHtml(run.sources_failed)} failed</small></div>`).join('') : '<p class="empty">No checks recorded.</p>'}</div>
  <section><h2>Source registry and pending comparisons</h2>${renderSources(sources, password)}</section>
  ${renderSectionReviews(sectionGroups, { escapeHtml, actionToken, comparisonSummary }, password)}
  <section><h2>Weekly source-accuracy audit</h2><p>This compares Fika entries with captured operator PDFs. It is not a punctuality audit.</p>${renderAudit(audit, samples, password)}</section>
  </main></body></html>`;
}

function createAuthGuard(username, password) {
  return function authenticate(req, res) {
    res.set('Cache-Control', 'no-store');
    res.set('X-Robots-Tag', 'noindex, nofollow');
    if (!username || !password) {
      res.status(503).type('text/plain').send('Timetable reliability authentication is not configured.');
      return null;
    }
    if (!isAuthorized(req.get('authorization'), username, password)) {
      res.set('WWW-Authenticate', 'Basic realm="Fika timetable reliability", charset="UTF-8"');
      res.status(401).type('text/plain').send('Authentication required.');
      return null;
    }
    return parseBasicAuthorization(req.get('authorization'))?.username || username;
  };
}

function createTimetableReliabilityHandlers({ database, username, password }) {
  const authenticate = createAuthGuard(username, password);
  async function handleSectionAction(req, res, withdraw) {
    const reviewer = authenticate(req, res);
    if (!reviewer) return;
    const sectionId = req.params.id;
    const versionId = req.body.version_id;
    if (!/^[1-9][0-9]*$/.test(String(sectionId)) || !/^[1-9][0-9]*$/.test(String(versionId))) return res.status(400).send('Invalid section revision.');
    try {
      await ensureTimetableReliabilitySchema(database);
      const { rows } = await database.query('SELECT content_sha256 FROM timetable_section_versions WHERE id=$1 AND section_id=$2;', [versionId, sectionId]);
      const identifier = withdraw ? `${sectionId}:${versionId}` : `${sectionId}:${versionId}:${rows[0]?.content_sha256}`;
      if (!rows[0] || !secureEqual(req.body.token, actionToken(password, withdraw ? 'section-withdraw' : 'section-approve', identifier))) return res.status(409).send('Invalid or stale section review token. Reload the review page.');
      await (withdraw ? withdrawSection : approveSection)(database, {
        sectionId, versionId, reviewer, note: String(req.body.note || '').trim(),
        verifiedOn: johannesburgDate(), overrideSource: req.body.source_override === 'yes',
      });
      res.redirect(303, '/admin/timetable-reliability');
    } catch (error) { res.status(409).type('text/plain').send(error.message); }
  }

  return {
    async report(req, res) {
      if (!authenticate(req, res)) return;
      try {
        await ensureTimetableReliabilitySchema(database);
        const [sourceResult, checkResult, auditResult] = await Promise.all([
          database.query(`
            SELECT sources.*,
              pending.pdf_sha256 AS pending_pdf_sha256,
              pending.document_issues,
              latest_check.error AS latest_check_error,
              pending.pdf_size_bytes AS pending_pdf_size_bytes,
              pending.source_effective_date AS pending_source_effective_date,
              CASE WHEN pending.id IS NULL THEN NULL ELSE jsonb_build_object(
                'parse_error', pending.comparison->'parse_error',
                'has_changes', pending.comparison->'has_changes',
                'previous_scheduled_departure_count', pending.comparison->'previous_scheduled_departure_count',
                'current_scheduled_departure_count', pending.comparison->'current_scheduled_departure_count',
                'changed_time_count', pending.comparison->'changed_time_count',
                'added_time_count', pending.comparison->'added_time_count',
                'removed_time_count', pending.comparison->'removed_time_count',
                'structural_changes', pending.comparison->'structural_changes'
              ) END AS pending_comparison
            FROM timetable_sources AS sources
            LEFT JOIN timetable_source_versions AS pending ON pending.id = sources.pending_version_id
            LEFT JOIN LATERAL (SELECT error FROM timetable_source_check_results
              WHERE source_id=sources.id ORDER BY checked_at DESC,id DESC LIMIT 1) latest_check ON true
            ORDER BY CASE sources.status WHEN 'changed_review_required' THEN 0 WHEN 'verified' THEN 1 ELSE 2 END,
              sources.operator, sources.source_key;
          `),
          database.query(`SELECT * FROM timetable_source_check_runs ORDER BY started_at DESC, id DESC LIMIT 5;`),
          database.query(`SELECT * FROM timetable_audit_runs WHERE status != 'cancelled' ORDER BY audit_week DESC, id DESC LIMIT 1;`),
        ]);
        const audit = auditResult.rows[0] || null;
        const sampleResult = audit ? await database.query(`
          SELECT samples.*, sources.source_key, versions.pdf_sha256
          FROM timetable_audit_samples AS samples
          JOIN timetable_sources AS sources ON sources.id = samples.source_id
          JOIN timetable_source_versions AS versions ON versions.id = samples.source_version_id
          WHERE samples.audit_run_id = $1
          ORDER BY samples.operator, samples.direction_ordinal, samples.service_day, samples.id;
        `, [audit.id]) : { rows: [] };
        res.type('html').send(renderAdminPage({
          sources: sourceResult.rows,
          checkRuns: checkResult.rows,
          audit,
          samples: sampleResult.rows,
          sectionGroups: await readSectionReviews(database),
        }, password));
      } catch (error) {
        console.error('Unable to render timetable reliability admin', error);
        res.status(500).type('text/plain').send('Unable to load timetable reliability review.');
      }
    },

    async pdf(req, res) {
      if (!authenticate(req, res)) return;
      if (!/^\d+$/.test(req.params.id)) {
        res.status(400).type('text/plain').send('Version id must be numeric.');
        return;
      }
      try {
        await ensureTimetableReliabilitySchema(database);
        const { rows } = await database.query(`
          SELECT versions.pdf_bytes, versions.pdf_sha256, sources.operator, sources.source_key
          FROM timetable_source_versions AS versions
          JOIN timetable_sources AS sources ON sources.id = versions.source_id
          WHERE versions.id = $1 LIMIT 1;
        `, [req.params.id]);
        if (!rows[0]) {
          res.status(404).type('text/plain').send('Captured PDF not found.');
          return;
        }
        res.set('Content-Disposition', `inline; filename="${rows[0].operator}-${rows[0].source_key}-${rows[0].pdf_sha256.slice(0, 12)}.pdf"`);
        res.set('X-Content-Type-Options', 'nosniff');
        res.type('application/pdf').send(rows[0].pdf_bytes);
      } catch (error) {
        console.error('Unable to load captured timetable PDF', error);
        res.status(500).type('text/plain').send('Unable to load captured PDF.');
      }
    },

    async comparison(req, res) {
      if (!authenticate(req, res)) return;
      if (!/^\d+$/.test(req.params.id)) {
        res.status(400).type('text/plain').send('Version id must be numeric.');
        return;
      }
      try {
        await ensureTimetableReliabilitySchema(database);
        const { rows } = await database.query(`
          SELECT versions.id, versions.comparison, sources.operator, sources.source_key
          FROM timetable_source_versions AS versions
          JOIN timetable_sources AS sources ON sources.id = versions.source_id
          WHERE versions.id = $1 LIMIT 1;
        `, [req.params.id]);
        if (!rows[0]) {
          res.status(404).type('text/plain').send('Comparison not found.');
          return;
        }
        res.set('Content-Disposition', `inline; filename="${rows[0].operator}-${rows[0].source_key}-comparison.json"`);
        res.set('X-Content-Type-Options', 'nosniff');
        res.json({
          source_version_id: Number(rows[0].id),
          operator: rows[0].operator,
          source_key: rows[0].source_key,
          comparison: rows[0].comparison,
        });
      } catch (error) {
        console.error('Unable to load timetable comparison', error);
        res.status(500).type('text/plain').send('Unable to load comparison.');
      }
    },

    async sectionComparison(req, res) {
      if (!authenticate(req, res)) return;
      if (!/^[1-9][0-9]*$/.test(req.params.id)) return res.status(400).send('Invalid section revision.');
      const against = req.query?.against;
      if (against && !/^[1-9][0-9]*$/.test(against)) return res.status(400).send('Invalid comparison revision.');
      try {
        await ensureTimetableReliabilitySchema(database);
        const { rows } = await database.query('SELECT id,section_id,document_version_id,extraction,parse_error,comparison,source_pages FROM timetable_section_versions WHERE id=$1;', [req.params.id]);
        if (!rows[0]) return res.status(404).send('Section revision not found.');
        if (against) {
          const other = await database.query('SELECT id,extraction FROM timetable_section_versions WHERE id=$1;', [against]);
          if (!other.rows[0]) return res.status(404).send('Comparison revision not found.');
          if (!rows[0].extraction || other.rows[0].extraction?.source_key !== rows[0].extraction.source_key) {
            return res.status(400).send('Compare two valid copies of the same timetable number.');
          }
          rows[0].against_section_version_id = Number(against);
          rows[0].copy_differences = compareSectionCopies(other.rows[0].extraction, rows[0].extraction);
        }
        res.json(rows[0]);
      } catch (error) { res.status(500).send('Unable to load section evidence.'); }
    },

    async approveSection(req, res) {
      return handleSectionAction(req, res, false);
    },

    async withdrawSection(req, res) {
      return handleSectionAction(req, res, true);
    },

    async approve(req, res) {
      const reviewer = authenticate(req, res);
      if (!reviewer) return;
      const { id: sourceId } = req.params;
      const versionId = req.body.version_id;
      if (!/^\d+$/.test(sourceId) || !/^\d+$/.test(String(versionId || ''))) {
        res.status(400).type('text/plain').send('Source and version ids must be numeric.');
        return;
      }
      try {
        await ensureTimetableReliabilitySchema(database);
        const { rows } = await database.query('SELECT pending_version_id FROM timetable_sources WHERE id = $1 LIMIT 1;', [sourceId]);
        const versionResult = await database.query('SELECT pdf_sha256 FROM timetable_source_versions WHERE id = $1 AND source_id = $2 LIMIT 1;', [versionId, sourceId]);
        const identifier = `${sourceId}:${versionId}:${versionResult.rows[0]?.pdf_sha256 || ''}`;
        if (!rows[0] || Number(rows[0].pending_version_id) !== Number(versionId) || !secureEqual(req.body.token, actionToken(password, 'approve', identifier))) {
          res.status(409).type('text/plain').send('This review candidate changed or the approval token is invalid. Reload the review page.');
          return;
        }
        await approvePendingVersion(database, {
          sourceId: Number(sourceId),
          versionId: Number(versionId),
          reviewer,
          note: String(req.body.note || '').trim(),
          verifiedOn: johannesburgDate(),
        });
        res.redirect(303, '/admin/timetable-reliability');
      } catch (error) {
        console.error('Unable to approve timetable source version', error);
        res.status(409).type('text/plain').send(`Approval failed: ${error.message}`);
      }
    },

    async bulkApproveUnchanged(req, res) {
      const reviewer = authenticate(req, res);
      if (!reviewer) return;
      try {
        await ensureTimetableReliabilitySchema(database);
        const { rows } = await database.query(`
          SELECT
            sources.id,
            sources.pending_version_id,
            pending.pdf_sha256 AS pending_pdf_sha256,
            pending.source_effective_date AS pending_source_effective_date,
            pending.comparison AS pending_comparison
          FROM timetable_sources AS sources
          JOIN timetable_source_versions AS pending ON pending.id = sources.pending_version_id
          WHERE pending.review_status = 'pending'
          ORDER BY sources.id;
        `);
        const candidates = getBulkUnchangedCandidates(rows);
        const identifier = bulkApprovalIdentifier(candidates);
        if (!candidates.length || !secureEqual(
          req.body.token,
          actionToken(password, 'bulk-approve-unchanged', identifier)
        )) {
          res.status(409).type('text/plain').send('The unchanged candidate list changed or the approval token is invalid. Reload the review page.');
          return;
        }

        await bulkApproveUnchangedVersions(database, {
          candidates,
          reviewer,
          note: String(req.body.note || '').trim() || 'unchanged',
          verifiedOn: johannesburgDate(),
        });
        res.redirect(303, '/admin/timetable-reliability');
      } catch (error) {
        console.error('Unable to bulk approve unchanged timetable source versions', error);
        res.status(409).type('text/plain').send(`Bulk approval failed: ${error.message}`);
      }
    },

    async withdraw(req, res) {
      const reviewer = authenticate(req, res);
      if (!reviewer) return;
      const sourceId = req.params.id;
      if (!/^\d+$/.test(sourceId)) {
        res.status(400).type('text/plain').send('Source id must be numeric.');
        return;
      }
      try {
        await ensureTimetableReliabilitySchema(database);
        const { rows } = await database.query('SELECT approved_version_id FROM timetable_sources WHERE id = $1 LIMIT 1;', [sourceId]);
        const identifier = `${sourceId}:${rows[0]?.approved_version_id || ''}`;
        if (!rows[0] || !secureEqual(req.body.token, actionToken(password, 'withdraw', identifier))) {
          res.status(409).type('text/plain').send('The source changed or the withdrawal token is invalid. Reload the review page.');
          return;
        }
        await withdrawSource(database, {
          sourceId: Number(sourceId),
          reviewer,
          note: String(req.body.note || '').trim(),
        });
        res.redirect(303, '/admin/timetable-reliability');
      } catch (error) {
        console.error('Unable to withdraw timetable source', error);
        res.status(409).type('text/plain').send(`Withdrawal failed: ${error.message}`);
      }
    },

    async audit(req, res) {
      const reviewer = authenticate(req, res);
      if (!reviewer) return;
      const auditId = req.params.id;
      if (!/^\d+$/.test(auditId) || !secureEqual(req.body.token, actionToken(password, 'audit', auditId))) {
        res.status(409).type('text/plain').send('The audit token is invalid. Reload the review page.');
        return;
      }
      const client = typeof database.connect === 'function' ? await database.connect() : database;
      try {
        await ensureTimetableReliabilitySchema(database);
        await client.query('BEGIN');
        const auditResult = await client.query('SELECT * FROM timetable_audit_runs WHERE id = $1 FOR UPDATE;', [auditId]);
        if (!auditResult.rows[0] || !['planned', 'in_progress'].includes(auditResult.rows[0].status)) {
          throw new Error('Audit is missing, complete, or was invalidated by a timetable publication.');
        }
        const sampleResult = await client.query('SELECT id FROM timetable_audit_samples WHERE audit_run_id = $1 ORDER BY id;', [auditId]);
        for (const sample of sampleResult.rows) {
          const result = req.body[`sample_${sample.id}`];
          if (result !== 'match' && result !== 'mismatch') continue;
          await client.query(`UPDATE timetable_audit_samples SET matched = $1, reviewed_at = now() WHERE id = $2 AND audit_run_id = $3;`, [result === 'match', sample.id, auditId]);
        }
        const totalsResult = await client.query(`
          SELECT COUNT(*)::integer AS sampled_count,
            COUNT(matched)::integer AS reviewed_count,
            COUNT(*) FILTER (WHERE matched)::integer AS matched_count,
            COUNT(*) FILTER (WHERE matched = false)::integer AS mismatched_count
          FROM timetable_audit_samples WHERE audit_run_id = $1;
        `, [auditId]);
        const totals = totalsResult.rows[0];
        const complete = Number(totals.sampled_count) >= 100 && Number(totals.reviewed_count) === Number(totals.sampled_count);
        const citation = complete ? `${totals.matched_count} of ${totals.sampled_count} sampled departures matched the cited operator PDF.` : null;
        await client.query(`
          UPDATE timetable_audit_runs SET sampled_count = $2, matched_count = $3, mismatched_count = $4,
            status = $5, citation_text = $6, reviewer = $7, notes = $8,
            completed_at = CASE WHEN $5 = 'completed' THEN now() ELSE NULL END
          WHERE id = $1;
        `, [auditId, totals.sampled_count, totals.matched_count, totals.mismatched_count, complete ? 'completed' : 'in_progress', citation, reviewer, String(req.body.notes || '').trim() || null]);
        if (complete) {
          await client.query(`UPDATE timetable_sources SET last_manually_verified_on = (now() AT TIME ZONE 'Africa/Johannesburg')::date, updated_at = now() WHERE id IN (SELECT DISTINCT source_id FROM timetable_audit_samples WHERE audit_run_id = $1);`, [auditId]);
          await client.query(`
            UPDATE timetable_sources
            SET status = 'changed_review_required', updated_at = now()
            WHERE id IN (
              SELECT DISTINCT source_id
              FROM timetable_audit_samples
              WHERE audit_run_id = $1 AND matched = false
            );
          `, [auditId]);
          await client.query(`UPDATE timetable_sections SET audit_review_required=true,status='changed_review_required'
            WHERE id IN (SELECT versions.section_id FROM timetable_audit_samples samples
              JOIN timetable_section_versions versions ON versions.id=samples.section_version_id
              WHERE samples.audit_run_id=$1 AND samples.matched=false);`, [auditId]);
          await client.query(`UPDATE timetable_sections SET last_manually_verified_on=(now() AT TIME ZONE 'Africa/Johannesburg')::date
            WHERE id IN (SELECT versions.section_id FROM timetable_audit_samples samples
              JOIN timetable_section_versions versions ON versions.id=samples.section_version_id
              WHERE samples.audit_run_id=$1);`, [auditId]);
          await client.query(`
            INSERT INTO timetable_source_events (source_id, event_type, actor, details)
            SELECT source_id, 'weekly_audit_mismatch', $2,
              jsonb_build_object(
                'audit_run_id', $1::bigint,
                'mismatched_sample_count', COUNT(*)::integer
              )
            FROM timetable_audit_samples
            WHERE audit_run_id = $1 AND matched = false
            GROUP BY source_id;
          `, [auditId, reviewer]);
          await client.query(`INSERT INTO timetable_source_events (event_type, actor, details) VALUES ('weekly_audit_completed', $1, jsonb_build_object('audit_run_id', $2::bigint, 'sampled_count', $3::integer, 'matched_count', $4::integer, 'statement', $5::text));`, [reviewer, auditId, totals.sampled_count, totals.matched_count, citation]);
        }
        await client.query('COMMIT');
        res.redirect(303, '/admin/timetable-reliability');
      } catch (error) {
        try { await client.query('ROLLBACK'); } catch {}
        console.error('Unable to record timetable audit', error);
        res.status(409).type('text/plain').send(`Audit update failed: ${error.message}`);
      } finally {
        if (client !== database && typeof client.release === 'function') client.release();
      }
    },
  };
}

module.exports = {
  actionToken,
  bulkApprovalIdentifier,
  comparisonSummary,
  createTimetableReliabilityHandlers,
  getBulkUnchangedCandidates,
  isPendingVersionEffective,
  johannesburgDate,
  renderAdminPage,
  secureEqual,
};
