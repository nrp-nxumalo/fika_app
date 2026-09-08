const {
  contributionsFromVersion, recomposeGabsServiceFamilies, inTransaction,
  lockPublicationTransaction, invalidateOpenAuditRuns, clearAffectedApiCache,
  validateCanonicalExtraction, currentCapeTownDate,
} = require('./timetablePublisher');

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sectionRecord(row) {
  return {
    sourceId: row.source_id, sourceKey: row.timetable_number,
    catalogueKey: row.catalogue_key, sectionId: row.section_id,
    sectionVersionId: row.id, versionId: row.document_version_id,
    sourceEffectiveDate: row.extraction.effective_date,
    extraction: row.extraction, override: Boolean(row.source_override),
  };
}

function sectionContributions(record) {
  const extraction = validateCanonicalExtraction(record.extraction, { operator: 'GABS', sourceKey: record.sourceKey });
  const route = extraction.routes[0];
  if (!/^[0-9]{6}$/.test(record.sourceKey) || extraction.routes.length !== 1
      || route.code !== record.sourceKey.slice(0, 4) || route.directions.length !== 1
      || route.directions[0].code !== record.sourceKey.slice(4)) {
    throw new Error('A section revision must contain only the route and direction identified by its timetable number.');
  }
  const result = contributionsFromVersion(record);
  for (const contribution of result.values()) {
    contribution.sectionVersionId = record.sectionVersionId;
    contribution.sectionId = record.sectionId;
    contribution.ownRoute = record.catalogueKey.slice(0, 4) === record.sourceKey.slice(0, 4);
    contribution.override = record.override;
    contribution.signature = stableJson({
      name: contribution.direction.name,
      trips: contribution.trips.map(({ times, serviceDays }) => ({ times, serviceDays })),
    });
  }
  return result;
}

function priority(a, b) {
  return Number(a.override) - Number(b.override) || Number(a.ownRoute) - Number(b.ownRoute)
    || String(a.effectiveDate || '').localeCompare(String(b.effectiveDate || ''));
}

function selectSectionWinners(records, { notAfter = currentCapeTownDate() } = {}) {
  const candidates = new Map();
  for (const record of records) {
    for (const [key, contribution] of sectionContributions(record)) {
      if (contribution.effectiveDate && contribution.effectiveDate > notAfter) continue;
      if (!candidates.has(key)) candidates.set(key, []);
      candidates.get(key).push(contribution);
    }
  }
  const winners = new Map();
  for (const [key, group] of candidates) {
    group.sort((a, b) => priority(b, a) || String(a.sourceId).localeCompare(String(b.sourceId), 'en', { numeric: true }));
    const preferred = group[0];
    if (group.some(candidate => priority(candidate, preferred) === 0 && candidate.signature !== preferred.signature)) {
      throw new Error(`Conflicting copies of timetable ${preferred.sourceKey} (${preferred.family}) have equal priority. Select an exact revision with a source override.`);
    }
    winners.set(key, preferred);
  }
  return winners;
}

async function loadApprovedSections(client, number, excludedSectionId) {
  const { rows } = await client.query(`
    SELECT versions.*, sections.id AS section_id, sections.source_id, sections.timetable_number,
      sources.source_key AS catalogue_key
    FROM timetable_sections sections
    JOIN timetable_sources sources ON sources.id=sections.source_id
    JOIN timetable_section_versions versions ON versions.id=sections.approved_version_id
    WHERE sections.timetable_number=$1 AND sections.id<>$2
      AND sections.status<>'withdrawn' AND versions.review_status='approved'
    ORDER BY sections.id FOR UPDATE OF sections,versions;
  `, [number, excludedSectionId]);
  return rows.map(sectionRecord);
}

function identifier(value, label) {
  if (!/^[1-9][0-9]*$/.test(String(value))) throw new Error(`${label} must be a positive identifier.`);
}

async function changeSection(database, { sectionId, versionId, reviewer, note, verifiedOn, overrideSource = false }, withdraw = false) {
  identifier(sectionId, 'sectionId');
  identifier(versionId, 'versionId');
  if (!reviewer?.trim() || !note?.trim()) throw new Error('Reviewer and review note are required.');
  const today = currentCapeTownDate();
  if (!withdraw && (verifiedOn !== today)) throw new Error('Section approvals must be verified today in Cape Town.');
  return inTransaction(database, async client => {
    await lockPublicationTransaction(client);
    const { rows } = await client.query(`
      SELECT sections.*, sources.source_key AS catalogue_key, sources.section_mode
      FROM timetable_sections sections JOIN timetable_sources sources ON sources.id=sections.source_id
      WHERE sections.id=$1 FOR UPDATE OF sections;
    `, [sectionId]);
    const section = rows[0];
    if (!section?.section_mode) throw new Error('Section publishing has not been enabled for this document.');
    const targetId = withdraw ? (section.approved_version_id || section.pending_version_id) : section.pending_version_id;
    if (String(targetId) !== String(versionId)) throw new Error('This section revision changed. Reload the review page.');
    const versions = await client.query('SELECT * FROM timetable_section_versions WHERE section_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE;',
      [sectionId, [...new Set([targetId, section.approved_version_id].filter(Boolean))]]);
    const target = versions.rows.find(v => String(v.id) === String(versionId));
    const previous = versions.rows.find(v => String(v.id) === String(section.approved_version_id));
    if (!target) throw new Error('The section revision was not found.');
    const makeRecord = version => sectionRecord({ ...version, source_id: section.source_id,
      timetable_number: section.timetable_number, catalogue_key: section.catalogue_key });
    const approved = await loadApprovedSections(client, section.timetable_number, sectionId);
    let candidate;
    if (!withdraw) {
      if (target.review_status !== 'pending' || target.parse_error || !target.extraction) throw new Error('Only a valid pending section can be approved.');
      if (String(target.previous_version_id || '') !== String(section.approved_version_id || '')) throw new Error('The approved section baseline changed.');
      validateCanonicalExtraction(target.extraction, { operator: 'GABS', sourceKey: section.timetable_number });
      if (target.extraction.effective_date && target.extraction.effective_date > verifiedOn) throw new Error('Cannot publish before the section effective date.');
      candidate = makeRecord({ ...target, source_override: overrideSource });
    }
    const affected = new Map(previous?.extraction ? sectionContributions(makeRecord(previous)) : []);
    if (candidate) for (const [key, value] of sectionContributions(candidate)) affected.set(key, value);
    // An explicit replacement choice clears prior overrides for this number.
    if (overrideSource && candidate) approved.forEach(record => { record.override = false; });
    if (candidate && !overrideSource) {
      const pendingCopies = await client.query(`SELECT v.*, s.id AS section_id,s.source_id,s.timetable_number,
          documents.source_key AS catalogue_key FROM timetable_sections s
          JOIN timetable_sources documents ON documents.id=s.source_id
          JOIN timetable_section_versions v ON v.id=s.pending_version_id
          WHERE s.timetable_number=$1 AND s.id<>$2 AND s.status<>'withdrawn' AND v.parse_error IS NULL;`,
        [section.timetable_number,sectionId]);
      const pendingRecords = pendingCopies.rows.map(sectionRecord);
      const pendingIds = new Set(pendingRecords.map(r => String(r.sectionId)));
      const preview = selectSectionWinners([...approved.filter(r => !pendingIds.has(String(r.sectionId))), ...pendingRecords, candidate]);
      for (const [key, contribution] of sectionContributions(candidate)) {
        if (preview.get(key)?.signature !== contribution.signature) throw new Error('A preferred pending copy differs. Review that copy or explicitly override its source.');
      }
    }
    const winners = selectSectionWinners([...approved, ...(candidate ? [candidate] : [])]);
    if (candidate && !overrideSource) {
      for (const [key, contribution] of sectionContributions(candidate)) {
        const winner = winners.get(key);
        if (winner && winner.sectionVersionId !== contribution.sectionVersionId && winner.signature !== contribution.signature) {
          throw new Error(`The preferred copy of ${section.timetable_number} differs. Review it or explicitly override its source.`);
        }
      }
    }
    await invalidateOpenAuditRuns(client);
    const routeIds = await recomposeGabsServiceFamilies(client, affected, winners, { preserveRouteNames: true });
    await clearAffectedApiCache(client, routeIds);
    if (overrideSource && candidate) {
      await client.query(`UPDATE timetable_section_versions SET source_override=false WHERE section_id IN
        (SELECT id FROM timetable_sections WHERE timetable_number=$1);`, [section.timetable_number]);
    }
    if (withdraw) {
      await client.query("UPDATE timetable_section_versions SET review_status='superseded',source_override=false WHERE section_id=$1 AND review_status IN ('approved','pending');", [sectionId]);
      await client.query("UPDATE timetable_sections SET status='withdrawn',approved_version_id=NULL,pending_version_id=NULL,updated_at=now() WHERE id=$1;", [sectionId]);
    } else {
      await client.query("UPDATE timetable_section_versions SET review_status='superseded',source_override=false WHERE id=$1;", [section.approved_version_id]);
      await client.query(`UPDATE timetable_section_versions SET review_status='approved',approved_by=$1,approved_at=now(),
        review_note=$2,published_at=now(),source_override=$3 WHERE id=$4;`, [reviewer.trim(), note.trim(), overrideSource, versionId]);
      await client.query(`UPDATE timetable_sections SET approved_version_id=$1,pending_version_id=NULL,status='verified',
        last_manually_verified_on=$2::date,audit_review_required=false,updated_at=now() WHERE id=$3;`, [versionId,verifiedOn,sectionId]);
    }
    await client.query(`UPDATE timetable_sources SET status=CASE WHEN EXISTS
      (SELECT 1 FROM timetable_sections WHERE source_id=$1 AND status='changed_review_required')
      OR EXISTS(SELECT 1 FROM timetable_source_versions v WHERE v.id=timetable_sources.pending_version_id
        AND jsonb_array_length(v.document_issues)>0)
      THEN 'changed_review_required' ELSE 'verified' END, updated_at=now() WHERE id=$1;`, [section.source_id]);
    await client.query(`INSERT INTO timetable_source_events(source_id,source_version_id,event_type,actor,details)
      VALUES ($1,$2,$3,$4,$5::jsonb);`, [section.source_id,target.document_version_id,
      withdraw ? 'section_withdrawn' : 'section_approved',reviewer.trim(),JSON.stringify({ section_id: sectionId,
        section_version_id: versionId, timetable_number: section.timetable_number, note: note.trim(),
        source_override: overrideSource, affected_route_ids: routeIds })]);
    return { sectionId, versionId, routeIds };
  });
}

module.exports = {
  stableJson, sectionRecord, sectionContributions, selectSectionWinners,
  approveSection: (database, options) => changeSection(database, options),
  withdrawSection: (database, options) => changeSection(database, options, true),
};
