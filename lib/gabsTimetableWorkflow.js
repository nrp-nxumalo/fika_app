const { sectionRecord, sectionContributions, selectSectionWinners } = require('./timetableSectionPublisher');
const { POLICY_VERSION, policySummary, policyWinners, evaluateTimetable, reviewSnapshot } = require('./gabsTimetablePolicy');
const { inTransaction, lockPublicationTransaction, recomposeGabsServiceFamilies,
  invalidateOpenAuditRuns, clearAffectedApiCache, currentCapeTownDate } = require('./timetablePublisher');

function versionJson(alias, full) {
  return `jsonb_build_object('id',${alias}.id,'section_id',${alias}.section_id,
    'document_version_id',${alias}.document_version_id,'previous_version_id',${alias}.previous_version_id,
    'content_sha256',${alias}.content_sha256,'review_status',${alias}.review_status,
    'parse_error',${alias}.parse_error,'source_override',${alias}.source_override,
    'approval_method',${alias}.approval_method,'policy_summary',${alias}.policy_summary,
    'extraction', CASE WHEN ${full ? 'true' : `${alias}.policy_summary->>'policy_version' IS DISTINCT FROM '${POLICY_VERSION}'`} THEN ${alias}.extraction END,
    'comparison', jsonb_build_object('changed_time_count',${alias}.comparison->'changed_time_count',
      'added_time_count',${alias}.comparison->'added_time_count','removed_time_count',${alias}.comparison->'removed_time_count',
      'previous_scheduled_departure_count',${alias}.comparison->'previous_scheduled_departure_count',
      'current_scheduled_departure_count',${alias}.comparison->'current_scheduled_departure_count'))`;
}

async function loadTimetableStates(database, { number = null, full = false } = {}) {
  const { rows } = await database.query(`
    SELECT s.*, src.source_key AS catalogue_key,
      COALESCE((SELECT name FROM routes WHERE agency='GABS' AND code=left(s.timetable_number,4) ORDER BY id LIMIT 1),src.route_name) AS route_name,
      CASE WHEN a.id IS NOT NULL THEN ${versionJson('a', full)} END AS approved,
      CASE WHEN p.id IS NOT NULL THEN ${versionJson('p', full)} END AS pending,
      COALESCE(to_jsonb(control),'{}'::jsonb) AS control,
      latest.id AS latest_check_id, latest.check_run_id AS latest_check_run_id,
      latest.outcome AS latest_check_outcome,
      COALESCE(doc.document_issues,'[]'::jsonb) AS document_issues,
      (latest.http_status BETWEEN 200 AND 299 AND EXISTS(SELECT 1 FROM timetable_section_observations o
        JOIN timetable_source_events e ON e.source_version_id=o.document_version_id
          AND e.event_type='document_sections_checked' AND e.check_run_id=latest.check_run_id
        WHERE o.section_version_id=COALESCE(s.pending_version_id,s.approved_version_id)
          AND o.document_version_id=s.last_seen_document_version_id
          AND e.source_id=s.source_id)) AS observed_in_check,
      (SELECT item->'extraction'->>'effective_date'
        FROM jsonb_array_elements(COALESCE(doc.extraction->'sections','[]'::jsonb)) item
        WHERE item->>'timetable_number'=src.source_key LIMIT 1) AS catalogue_effective_date
    FROM timetable_sections s JOIN timetable_sources src ON src.id=s.source_id
    LEFT JOIN timetable_section_versions a ON a.id=s.approved_version_id
    LEFT JOIN timetable_section_versions p ON p.id=s.pending_version_id
    LEFT JOIN timetable_review_controls control ON control.timetable_number=s.timetable_number
    LEFT JOIN timetable_source_versions doc ON doc.id=src.pending_version_id
    LEFT JOIN LATERAL (SELECT id,check_run_id,outcome,http_status FROM timetable_source_check_results
      WHERE source_id=s.source_id ORDER BY id DESC LIMIT 1) latest ON true
    WHERE src.section_mode AND ($1::text IS NULL OR s.timetable_number=$1)
    ORDER BY s.timetable_number,s.id;`, [number]);
  const groups = new Map();
  for (const row of rows) {
    for (const key of ['approved', 'pending']) if (row[key]) {
      Object.assign(row[key], { section_id: row.id, source_id: row.source_id,
        timetable_number: row.timetable_number, catalogue_key: row.catalogue_key });
      if (!row[key].parse_error && (full || row[key].policy_summary?.policy_version !== POLICY_VERSION)) {
        row[key].policy_summary = policySummary(row[key].extraction);
      }
    }
    if (!groups.has(row.timetable_number)) groups.set(row.timetable_number, {
      number: row.timetable_number, control: row.control, rows: [],
    });
    groups.get(row.timetable_number).rows.push(row);
  }
  return [...groups.values()];
}

async function refreshSourceStatuses(client, sourceIds) {
  await client.query(`UPDATE timetable_sources src SET status=CASE WHEN EXISTS
    (SELECT 1 FROM timetable_sections s WHERE s.source_id=src.id AND s.status='changed_review_required')
    OR EXISTS(SELECT 1 FROM timetable_source_versions v WHERE v.id=src.pending_version_id AND jsonb_array_length(v.document_issues)>0)
    THEN 'changed_review_required' WHEN NOT EXISTS
    (SELECT 1 FROM timetable_sections s WHERE s.source_id=src.id AND s.status<>'withdrawn') THEN 'withdrawn'
    ELSE 'verified' END,updated_at=now() WHERE src.id=ANY($1::bigint[]);`, [sourceIds]);
}

async function recordDecision(client, state, decision) {
  for (const row of state.rows) if (row.pending) {
    await client.query('UPDATE timetable_section_versions SET review_decision=$1::jsonb,policy_summary=$2::jsonb WHERE id=$3;',
      [JSON.stringify(decision), JSON.stringify(row.pending.policy_summary), row.pending.id]);
  }
}

async function changeTimetable(database, options) {
  const { number, snapshot, reviewer, note, automatic = false, withdraw = false,
    restore = false, selectedVersionId = null, runId = null, dryRun = false, recordOnly = false } = options;
  if (!/^\d{6}$/.test(number)) throw new Error('Invalid timetable number.');
  if (!automatic && (!reviewer?.trim() || !note?.trim())) throw new Error('Reviewer and review note are required.');
  return inTransaction(database, async client => {
    await lockPublicationTransaction(client);
    const [state] = await loadTimetableStates(client, { number, full: true });
    if (!state) throw new Error('Timetable not found.');
    if (!automatic && snapshot !== reviewSnapshot(state.rows, state.control)) throw new Error('This timetable changed. Reload the review page.');
    const decision = evaluateTimetable(state.rows, state.control, { runId, selectedVersionId });
    if (automatic && (dryRun || recordOnly || !decision.automatic || decision.state === 'scheduled')) {
      if (!dryRun) await recordDecision(client, state, decision);
      return { number, decision, routeIds: [], published: false };
    }
    if (!withdraw && state.control.withdrawn && !restore) throw new Error('Explicit restoration is required.');
    if (automatic && (selectedVersionId || restore || withdraw || !runId)) throw new Error('Automatic publication requires a source check and cannot override a review decision.');
    if (automatic) await assertReviewRun(client, runId);
    const today = currentCapeTownDate();
    const approved = state.rows.filter(r => r.status !== 'withdrawn').flatMap(r => r.approved ? [r.approved] : []);
    const acceptedIds = new Set(decision.identical_version_ids);
    const accepted = withdraw ? [] : state.rows.flatMap(r => r.pending && acceptedIds.has(String(r.pending.id)) ? [r.pending] : []);
    if (!withdraw && !accepted.length) throw new Error(decision.reasons[0] || 'There is no pending selected revision to approve.');
    for (const candidate of accepted) {
      const row = state.rows.find(r => String(r.id) === String(candidate.section_id));
      if (candidate.review_status !== 'pending' || candidate.parse_error) throw new Error('Only valid pending revisions can be approved.');
      if (String(candidate.previous_version_id || '') !== String(row.approved_version_id || '')) throw new Error('The approved baseline changed.');
      if (candidate.extraction.effective_date && candidate.extraction.effective_date > today) throw new Error('Cannot publish before the timetable effective date.');
      if (!selectedVersionId && row.approved?.source_override) throw new Error('Select the exact replacement revision to replace a source override.');
    }
    const acceptedSections = new Set(accepted.map(c => String(c.section_id)));
    const retained = approved.filter(c => !acceptedSections.has(String(c.section_id)));
    // Choosing a revision is an explicit replacement of any earlier override.
    const records = withdraw ? [] : [...retained, ...accepted].map(c => sectionRecord({ ...c,
      source_override: selectedVersionId ? String(c.id) === String(selectedVersionId) : c.source_override }));
    const winners = selectSectionWinners(records);
    if (!withdraw) {
      const planned = policyWinners(state.rows.flatMap(r => r.pending || r.approved ? [r.pending || r.approved] : [])
        .filter(v => !v.parse_error && v.policy_summary?.policy_version === POLICY_VERSION)
        .map(v => ({ ...v, source_override: selectedVersionId ? String(v.id) === String(selectedVersionId) : v.source_override })));
      for (const winner of winners.values()) {
        const intended = planned.get(winner.family);
        const actual = records.find(r => String(r.sectionVersionId) === String(winner.sectionVersionId));
        const actualSummary = policySummary(actual.extraction).families[winner.family];
        if (intended && (intended.content_sha256 !== actualSummary.content_sha256 || intended.effectiveDate !== winner.effectiveDate)) {
          throw new Error('An existing approved source takes precedence. Select the exact replacement revision.');
        }
      }
    }
    const affected = new Map();
    for (const c of [...approved, ...accepted]) for (const [key, value] of sectionContributions(sectionRecord(c))) affected.set(key, value);
    // Adding identical evidence must not churn trip IDs, caches or audit samples.
    let before = new Map();
    try { before = selectSectionWinners(approved.map(sectionRecord)); }
    catch (error) { if (automatic || (!selectedVersionId && !withdraw)) throw error; }
    const changed = new Map([...affected].filter(([key]) => {
      const a = before.get(key), b = winners.get(key);
      return !a || !b || a.signature !== b.signature || a.effectiveDate !== b.effectiveDate;
    }));
    let routeIds = [];
    if (changed.size) {
      await invalidateOpenAuditRuns(client);
      routeIds = await recomposeGabsServiceFamilies(client, changed, winners, { preserveRouteNames: true });
      await clearAffectedApiCache(client, routeIds);
    }
    const actor = automatic ? 'gabs-automation' : reviewer.trim();
    const reviewNote = automatic ? `Automatically approved: ${decision.category}.` : note.trim();
    if (withdraw) {
      await client.query(`UPDATE timetable_section_versions SET review_status='superseded',source_override=false
        WHERE section_id=ANY($1::bigint[]) AND review_status IN ('approved','pending');`, [state.rows.map(r => r.id)]);
      await client.query(`UPDATE timetable_sections SET status='withdrawn',withdrawal_review_required=true,approved_version_id=NULL,pending_version_id=NULL,
        updated_at=now() WHERE timetable_number=$1;`, [number]);
    } else {
      if (selectedVersionId) await client.query(`UPDATE timetable_section_versions SET source_override=false
        WHERE section_id=ANY($1::bigint[]);`, [state.rows.map(r => r.id)]);
      for (const candidate of accepted) {
        const row = state.rows.find(r => String(r.id) === String(candidate.section_id));
        await client.query("UPDATE timetable_section_versions SET review_status='superseded',source_override=false WHERE id=$1;", [row.approved_version_id]);
        await client.query(`UPDATE timetable_section_versions SET review_status='approved',approved_by=$1,approved_at=now(),
          review_note=$2,published_at=CASE WHEN $9 THEN now() ELSE published_at END,source_override=$3,approval_method=$4,approval_policy_version=$5,
          review_decision=$6::jsonb,policy_summary=$7::jsonb WHERE id=$8;`,
        [actor, reviewNote, selectedVersionId ? String(candidate.id) === String(selectedVersionId) : Boolean(candidate.source_override),
          automatic ? 'automatic' : 'manual', POLICY_VERSION, JSON.stringify(decision), JSON.stringify(candidate.policy_summary), candidate.id, changed.size > 0]);
        await client.query(`UPDATE timetable_sections SET approved_version_id=$1,pending_version_id=NULL,status='verified',
          last_manually_verified_on=CASE WHEN $2 THEN last_manually_verified_on ELSE $3::date END,
          audit_review_required=false,withdrawal_review_required=false,updated_at=now() WHERE id=$4;`, [candidate.id, automatic, today, row.id]);
      }
    }
    await client.query(`INSERT INTO timetable_review_controls(timetable_number,withdrawn,revision,changed_by,note)
      VALUES ($1,$2,1,$3,$4) ON CONFLICT(timetable_number) DO UPDATE SET withdrawn=EXCLUDED.withdrawn,
      revision=timetable_review_controls.revision+1,changed_by=EXCLUDED.changed_by,note=EXCLUDED.note,updated_at=now();`,
    [number, withdraw, actor, reviewNote]);
    await refreshSourceStatuses(client, state.rows.map(r => r.source_id));
    await client.query(`INSERT INTO timetable_source_events(source_id,source_version_id,check_run_id,event_type,actor,details)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb);`, [accepted[0]?.source_id || state.rows[0].source_id, accepted[0]?.document_version_id || null, runId,
      withdraw ? 'timetable_withdrawn' : automatic ? 'timetable_auto_approved' : restore ? 'timetable_restored' : 'timetable_approved',
      actor, JSON.stringify({ timetable_number: number, note: reviewNote, policy_version: POLICY_VERSION,
        category: decision.category, baseline_version_ids: approved.map(c => c.id),
        approved_version_ids: accepted.map(c => c.id), selected_version_ids: decision.selected_version_ids,
        source_ids: state.rows.map(r => r.source_id),
        affected_route_ids: routeIds })]);
    return { number, decision, routeIds, published: !withdraw, withdrawn: withdraw };
  });
}

async function rebuildReviewSummaries(database) {
  return inTransaction(database, async client => {
    await lockPublicationTransaction(client);
    const { rows } = await client.query(`SELECT id,extraction FROM timetable_section_versions
      WHERE extraction IS NOT NULL AND policy_summary->>'policy_version' IS DISTINCT FROM $1;`, [POLICY_VERSION]);
    for (const row of rows) await client.query('UPDATE timetable_section_versions SET policy_summary=$1::jsonb WHERE id=$2;',
      [JSON.stringify(policySummary(row.extraction)), row.id]);
    await client.query(`UPDATE timetable_sources src SET source_effective_date=(SELECT (item->'extraction'->>'effective_date')::date
      FROM timetable_source_versions doc, jsonb_array_elements(COALESCE(doc.extraction->'sections','[]'::jsonb)) item
      WHERE doc.id=src.pending_version_id AND item->>'timetable_number'=src.source_key LIMIT 1)
      WHERE src.section_mode AND src.pending_version_id IS NOT NULL;`);
    return rows.length;
  });
}

async function assertReviewRun(database, runId) {
  if (!/^[1-9]\d*$/.test(String(runId))) throw new Error('A source check run ID is required.');
  const run = await database.query(`SELECT id,operator_results FROM timetable_source_check_runs
    WHERE id=$1 AND started_at>now()-interval '36 hours'
      AND id=(SELECT max(id) FROM timetable_source_check_runs);`, [runId]);
  const gabs = run.rows[0]?.operator_results?.GABS;
  if (!gabs || gabs.error || gabs.catalogue_coverage_error || !gabs.discovered) {
    throw new Error('Automatic review requires a recent, complete GABS catalogue discovery.');
  }
}

async function runAutomaticReviews(database, { runId, dryRun = true, recordOnly = false } = {}) {
  await assertReviewRun(database, runId);
  const states = await loadTimetableStates(database);
  const result = { automatic: 0, unchanged: 0, scheduled: 0, manual_review: 0, failed: 0,
    dry_run: dryRun, publishing_enabled: !dryRun && !recordOnly, timetables: [] };
  for (const state of states) {
    try {
      const outcome = await changeTimetable(database, { number: state.number, automatic: true, runId, dryRun, recordOnly });
      const decision = outcome.decision;
      const key = decision.state === 'scheduled' ? 'scheduled' : ['needs_review', 'withdrawn'].includes(decision.state)
        ? 'manual_review' : decision.category === 'unchanged' ? 'unchanged' : 'automatic';
      result[key] += 1;
      result.timetables.push({ number: state.number, state: decision.state, category: decision.category,
        reasons: decision.reasons, published: outcome.published });
    } catch (error) {
      result.failed += 1;
      result.timetables.push({ number: state.number, state: 'failed', error: error.message });
    }
  }
  return result;
}

module.exports = { loadTimetableStates, changeTimetable, rebuildReviewSummaries, runAutomaticReviews };
