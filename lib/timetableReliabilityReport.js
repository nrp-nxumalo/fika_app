const { readSectionReviews, publicSectionSummaries } = require('./timetableSectionReview');
const { ensureTimetableReliabilitySchema } = require('./timetableReliabilitySchema');

function toIsoDate(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    // PostgreSQL DATE values are materialized by node-postgres at local
    // midnight. Preserve the calendar fields instead of shifting through UTC.
    const year = String(value.getFullYear()).padStart(4, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  const match = String(value).match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function toIsoDateTime(value) {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeSource(row) {
  return {
    id: Number(row.id),
    operator: row.operator,
    source_key: row.source_key,
    route: row.route_name,
    directions: row.direction_names || [],
    service_days: row.service_day_coverage || [],
    official_source_url: row.official_source_url,
    source_effective_date: toIsoDate(row.source_effective_date),
    last_downloaded_at: toIsoDateTime(row.last_downloaded_at),
    last_manually_verified_on: toIsoDate(row.last_manually_verified_on),
    pdf_sha256: row.current_pdf_sha256,
    approved_pdf_sha256: row.approved_pdf_sha256,
    content_sha256: row.current_content_sha256,
    parser_version: row.parser_version,
    import_version: row.import_version,
    status: row.status,
    section_mode: Boolean(row.section_mode),
    document_issues: row.document_issues || [],
    latest_document_check: row.latest_document_check || null,
  };
}

function serializeCheckRun(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    started_at: toIsoDateTime(row.started_at),
    finished_at: toIsoDateTime(row.finished_at),
    status: row.status,
    sources_discovered: Number(row.sources_discovered) || 0,
    sources_downloaded: Number(row.sources_downloaded) || 0,
    sources_unchanged: Number(row.sources_unchanged) || 0,
    sources_changed: Number(row.sources_changed) || 0,
    sources_failed: Number(row.sources_failed) || 0,
  };
}

function serializeAudit(row) {
  if (!row) {
    return null;
  }

  const sampledCount = Number(row.sampled_count) || 0;
  const matchedCount = Number(row.matched_count) || 0;

  return {
    id: Number(row.id),
    audit_week: toIsoDate(row.audit_week),
    sampled_count: sampledCount,
    matched_count: matchedCount,
    mismatched_count: Number(row.mismatched_count) || 0,
    completed_at: toIsoDateTime(row.completed_at),
    latest_publication_at: toIsoDateTime(row.latest_publication_at),
    statement: row.citation_text || (
      sampledCount
        ? `${matchedCount} of ${sampledCount} sampled departures matched the cited operator PDF.`
        : null
    ),
  };
}

async function getPublicReliabilityReport(database, { now = new Date() } = {}) {
  await ensureTimetableReliabilitySchema(database);

  const [sourceResult, checkRunResult, auditResult, eventResult] = await Promise.all([
    database.query(`
      SELECT
        sources.id,
        sources.operator,
        sources.source_key,
        sources.route_name,
        sources.direction_names,
        sources.service_day_coverage,
        sources.official_source_url,
        sources.source_effective_date,
        sources.last_downloaded_at,
        sources.last_manually_verified_on,
        sources.current_pdf_sha256,
        sources.current_content_sha256,
        sources.parser_version,
        sources.import_version,
        sources.status, sources.section_mode,
        observed.document_issues,
        latest_check.result AS latest_document_check,
        approved.pdf_sha256 AS approved_pdf_sha256
      FROM timetable_sources AS sources
      LEFT JOIN timetable_source_versions AS approved ON approved.id = sources.approved_version_id
      LEFT JOIN timetable_source_versions AS observed ON observed.id = sources.pending_version_id
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object('checked_at',checked_at,'outcome',outcome,
          'http_status',http_status,'error',error) AS result
        FROM timetable_source_check_results WHERE source_id=sources.id
        ORDER BY checked_at DESC,id DESC LIMIT 1
      ) latest_check ON true
      ORDER BY sources.operator, sources.source_key;
    `),
    database.query(`
      SELECT
        id,
        started_at,
        finished_at,
        status,
        sources_discovered,
        sources_downloaded,
        sources_unchanged,
        sources_changed,
        sources_failed
      FROM timetable_source_check_runs
      WHERE status != 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1;
    `),
    database.query(`
      SELECT
        id,
        audit_week,
        sampled_count,
        matched_count,
        mismatched_count,
        citation_text,
        completed_at,
        (
          SELECT MAX(occurred_at)
          FROM timetable_source_events
          WHERE event_type IN ('source_approved', 'source_withdrawn', 'section_approved', 'section_withdrawn')
        ) AS latest_publication_at
      FROM timetable_audit_runs
      WHERE status = 'completed'
      ORDER BY audit_week DESC, id DESC
      LIMIT 1;
    `),
    database.query(`
      SELECT
        events.id,
        events.event_type,
        events.occurred_at,
        sources.operator,
        sources.source_key,
        sources.route_name
      FROM timetable_source_events AS events
      LEFT JOIN timetable_sources AS sources ON sources.id = events.source_id
      ORDER BY events.occurred_at DESC, events.id DESC
      LIMIT 100;
    `),
  ]);

  const sources = sourceResult.rows.map(serializeSource);
  const statusCounts = sources.reduce((counts, source) => {
    counts[source.status] = (counts[source.status] || 0) + 1;
    return counts;
  }, {
    verified: 0,
    changed_review_required: 0,
    withdrawn: 0,
  });

  const generatedAt = new Date(now);
  const latestCheck = serializeCheckRun(checkRunResult.rows[0]);
  const latestAudit = serializeAudit(auditResult.rows[0]);
  const latestCheckFinishedAt = latestCheck?.finished_at ? new Date(latestCheck.finished_at) : null;
  const dailyCheckCurrent = Boolean(
    latestCheck &&
    latestCheck.status !== 'failed' &&
    latestCheck.sources_failed === 0 &&
    latestCheckFinishedAt &&
    !Number.isNaN(latestCheckFinishedAt.getTime()) &&
    generatedAt.getTime() - latestCheckFinishedAt.getTime() <= 36 * 60 * 60 * 1000
  );
  const latestAuditCompletedAt = latestAudit?.completed_at ? new Date(latestAudit.completed_at) : null;
  const latestPublicationAt = latestAudit?.latest_publication_at
    ? new Date(latestAudit.latest_publication_at)
    : null;
  const weeklyAuditCurrent = Boolean(
    latestAudit &&
    latestAudit.sampled_count >= 100 &&
    statusCounts.changed_review_required === 0 &&
    latestAuditCompletedAt &&
    !Number.isNaN(latestAuditCompletedAt.getTime()) &&
    generatedAt.getTime() - latestAuditCompletedAt.getTime() <= 10 * 24 * 60 * 60 * 1000 &&
    (!latestPublicationAt || (
      !Number.isNaN(latestPublicationAt.getTime()) &&
      latestAuditCompletedAt.getTime() >= latestPublicationAt.getTime()
    ))
  );

  return {
    sections: publicSectionSummaries(await readSectionReviews(database, { publicOnly: true })),
    generated_at: generatedAt.toISOString(),
    definitions: {
      source_accuracy: 'Fika displays the departure times published in the cited operator timetable.',
      operational_punctuality: 'Whether a bus actually arrives at the published time. Fika does not currently measure or prove this.',
    },
    status_counts: statusCounts,
    daily_check_current: dailyCheckCurrent,
    weekly_audit_current: weeklyAuditCurrent,
    latest_check: latestCheck,
    latest_audit: latestAudit,
    sources,
    change_log: eventResult.rows.map((row) => ({
      id: Number(row.id),
      event_type: row.event_type,
      occurred_at: toIsoDateTime(row.occurred_at),
      operator: row.operator,
      source_key: row.source_key,
      route: row.route_name,
    })),
  };
}

module.exports = {
  getPublicReliabilityReport,
  serializeAudit,
  serializeCheckRun,
  serializeSource,
  toIsoDate,
  toIsoDateTime,
};
