const test = require('node:test');
const assert = require('node:assert/strict');
const { getPublicReliabilityReport, toIsoDate } = require('../lib/timetableReliabilityReport');

test('SQL DATE serialization preserves its calendar date in Cape Town', () => {
  assert.equal(toIsoDate(new Date(2026, 6, 25)), '2026-07-25');
});

test('public reliability report exposes provenance and keeps accuracy claims scoped', async () => {
  const reportOptions = { now: new Date('2026-08-17T12:00:00Z') };
  let latestPublicationAt = '2026-08-15T12:00:00Z';
  let sourceStatus = 'verified';
  let checkStatus = 'succeeded';
  const database = {
    async query(sql) {
      if (sql.includes('CREATE TABLE IF NOT EXISTS timetable_sources')) {
        return { rows: [] };
      }
      if (sql.includes('FROM timetable_sources') && sql.includes('ORDER BY sources.operator')) {
        return { rows: [{
          id: '7',
          operator: 'GABS',
          source_key: '000401',
          route_name: 'ATLANTIS - CAPE TOWN',
          direction_names: ['ATLANTIS - CAPE TOWN'],
          service_day_coverage: ['monday', 'saturday', 'public_holiday'],
          official_source_url: 'https://operator.example/000401.pdf',
          source_effective_date: '2026-08-10',
          last_downloaded_at: '2026-08-17T01:20:00Z',
          last_manually_verified_on: '2026-08-16',
          current_pdf_sha256: 'a'.repeat(64),
          approved_pdf_sha256: 'a'.repeat(64),
          current_content_sha256: 'b'.repeat(64),
          parser_version: 'gabs-2',
          import_version: 'canonical-1',
          status: sourceStatus,
        }] };
      }
      if (sql.includes('FROM timetable_source_check_runs')) {
        return { rows: [{
          id: '9',
          started_at: '2026-08-17T01:17:00Z',
          finished_at: '2026-08-17T01:22:00Z',
          status: checkStatus,
          sources_discovered: 1,
          sources_downloaded: 1,
          sources_unchanged: 1,
          sources_changed: 0,
          sources_failed: 0,
        }] };
      }
      if (sql.includes('FROM timetable_audit_runs')) {
        return { rows: [{
          id: '3',
          audit_week: '2026-08-10',
          sampled_count: 200,
          matched_count: 198,
          mismatched_count: 2,
          citation_text: null,
          completed_at: '2026-08-16T09:00:00Z',
          latest_publication_at: latestPublicationAt,
        }] };
      }
      if (sql.includes('FROM timetable_source_events')) {
        return { rows: [] };
      }
      if (sql.includes('FROM timetable_sections sections')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const report = await getPublicReliabilityReport(database, reportOptions);

  assert.equal(report.status_counts.verified, 1);
  assert.equal(typeof report.daily_check_current, 'boolean');
  assert.equal(typeof report.weekly_audit_current, 'boolean');
  assert.equal(report.sources[0].pdf_sha256, 'a'.repeat(64));
  assert.equal(report.sources[0].approved_pdf_sha256, 'a'.repeat(64));
  assert.equal(report.latest_audit.statement, '198 of 200 sampled departures matched the cited operator PDF.');
  assert.equal(report.weekly_audit_current, true);
  assert.match(report.definitions.source_accuracy, /published/);
  assert.match(report.definitions.operational_punctuality, /does not currently measure or prove/);

  latestPublicationAt = '2026-08-16T10:00:00Z';
  const supersededEvidence = await getPublicReliabilityReport(database, reportOptions);
  assert.equal(supersededEvidence.weekly_audit_current, false);

  latestPublicationAt = '2026-08-15T12:00:00Z';
  sourceStatus = 'changed_review_required';
  const pendingReviewEvidence = await getPublicReliabilityReport(database, reportOptions);
  assert.equal(pendingReviewEvidence.weekly_audit_current, false);

  checkStatus = 'partial_failure';
  const auditOnlyFailure = await getPublicReliabilityReport(database, reportOptions);
  assert.equal(auditOnlyFailure.daily_check_current, true);
});
