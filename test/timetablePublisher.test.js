const test = require('node:test');
const assert = require('node:assert/strict');

const {
  approvePendingVersion,
  bulkApproveUnchangedVersions,
  currentCapeTownDate,
  serviceDayFlags,
  validateCanonicalExtraction,
  withdrawSource,
} = require('../lib/timetablePublisher');

function canonicalExtraction({
  operator = 'MyCiti',
  publicationScope,
  routeCode,
  directionCode,
  sourceKey,
  serviceDays,
  effectiveDate = '2026-08-10',
  time = '05:10',
} = {}) {
  const scope = publicationScope || (operator === 'MyCiti' ? 'route' : 'service_days');
  const normalizedDays = serviceDays || (operator === 'MyCiti'
    ? ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
    : ['public_holiday']);
  return {
    schema_version: 1,
    operator,
    source_key: sourceKey || (operator === 'MyCiti' ? 'route-214a' : '006603'),
    publication_scope: scope,
    effective_date: effectiveDate,
    routes: [{
      code: routeCode || (operator === 'MyCiti' ? '214A' : '0066'),
      name: operator === 'MyCiti' ? 'PARKLANDS - TABLE VIEW' : 'BLAAUWBERG RIDGE - HARARE',
      directions: [{
        code: directionCode === undefined ? (operator === 'MyCiti' ? '214a' : '01') : directionCode,
        name: operator === 'MyCiti' ? 'To Marine Circle' : 'BLAAUWBERG RIDGE - HARARE',
        effective_date: effectiveDate,
        services: [{
          label: normalizedDays.includes('public_holiday') ? 'PUBLIC HOLIDAYS' : 'MONDAYS TO FRIDAYS',
          service_days: normalizedDays,
          footnotes: [],
          trips: [{
            footnote_markers: [],
            service_days: normalizedDays,
            times: [
              {
                sequence: 0,
                stop_name: 'Stop A',
                time,
                raw_time: time,
                stop_time_type: 'scheduled',
              },
              {
                sequence: 1,
                stop_name: 'Stop B',
                time: null,
                raw_time: '--',
                stop_time_type: 'not_served',
              },
            ],
          }],
        }],
      }],
    }],
  };
}

function versionRow(extraction, overrides = {}) {
  return {
    id: 10,
    source_id: 1,
    previous_version_id: 9,
    pdf_sha256: 'a'.repeat(64),
    content_sha256: 'b'.repeat(64),
    source_effective_date: extraction.effective_date,
    parser_version: 'parser-v1',
    import_version: 'import-v1',
    source_url: 'https://operator.example/timetable.pdf',
    review_status: 'pending',
    extraction,
    comparison: {
      has_changes: false,
      changed_time_count: 0,
      added_time_count: 0,
      removed_time_count: 0,
    },
    ...overrides,
  };
}

function approvedContributor({ sourceId, versionId, extraction }) {
  return {
    source_id: sourceId,
    source_key: extraction.source_key,
    version_id: versionId,
    source_effective_date: extraction.effective_date,
    extraction,
  };
}

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

class RecordingDatabase {
  constructor({
    source,
    candidate,
    versions = [],
    approvedContributors = [],
    routeDirectionIds = [70, 71],
    composedDirectionId = 81,
    familyTripIds = {},
    familyTripRows = {},
    publishedContributionRows = [],
    provenanceDirections = [],
    failOn,
  } = {}) {
    this.source = source || {
      id: 1,
      operator: 'MyCiti',
      source_key: 'route-214a',
      status: 'changed_review_required',
      approved_version_id: 9,
      pending_version_id: 10,
    };
    this.candidate = candidate || versionRow(canonicalExtraction());
    this.versions = new Map([
      [String(this.candidate.id), this.candidate],
      ...versions.map((version) => [String(version.id), version]),
    ]);
    if (this.source.approved_version_id
      && !this.versions.has(String(this.source.approved_version_id))) {
      const previousExtraction = this.candidate.extraction;
      this.versions.set(String(this.source.approved_version_id), versionRow(previousExtraction, {
        id: this.source.approved_version_id,
        previous_version_id: null,
        review_status: 'approved',
      }));
    }
    this.approvedContributors = approvedContributors;
    this.routeDirectionIds = routeDirectionIds;
    this.composedDirectionId = composedDirectionId;
    this.familyTripIds = familyTripIds;
    this.familyTripRows = familyTripRows;
    this.publishedContributionRows = publishedContributionRows;
    this.provenanceDirections = provenanceDirections;
    this.failOn = failOn;
    this.calls = [];
    this.nextDirectionId = 100;
    this.nextTripId = 200;
    this.nextStopId = 300;
    this.insertedTrips = [];
  }

  async query(sql, params = []) {
    const text = compactSql(sql);
    this.calls.push({ text, params });

    if (this.failOn && this.failOn.test(text)) throw new Error('injected database failure');
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (/pg_advisory_xact_lock/.test(text)) return { rows: [{ pg_advisory_xact_lock: null }], rowCount: 1 };

    if (/FROM timetable_sources AS sources JOIN timetable_source_versions AS versions/.test(text)) {
      return { rows: this.approvedContributors, rowCount: this.approvedContributors.length };
    }
    if (/FROM timetable_sources .*FOR UPDATE/.test(text)) return { rows: [this.source], rowCount: 1 };
    if (/FROM timetable_source_versions .*FOR UPDATE/.test(text)) {
      const version = this.versions.get(String(params[0]));
      return { rows: version ? [version] : [], rowCount: version ? 1 : 0 };
    }

    if (/FROM routes .*FOR UPDATE/.test(text)) {
      return { rows: [{ id: 50, effective_date: '2026-08-01' }], rowCount: 1 };
    }
    if (/^UPDATE routes /.test(text)) return { rows: [{ id: 50, effective_date: '2026-08-10' }], rowCount: 1 };
    if (/^INSERT INTO routes /.test(text)) return { rows: [{ id: 50, effective_date: '2026-08-10' }], rowCount: 1 };

    if (/SELECT id FROM directions WHERE route_id = \$1 FOR UPDATE/.test(text)) {
      return { rows: this.routeDirectionIds.map((id) => ({ id })), rowCount: this.routeDirectionIds.length };
    }
    if (/FROM directions WHERE route_id = \$1 AND \(/.test(text)) {
      const directionIds = Array.isArray(this.composedDirectionId)
        ? this.composedDirectionId
        : (this.composedDirectionId == null ? [] : [this.composedDirectionId]);
      return {
        rows: directionIds.map((id) => ({ id })),
        rowCount: directionIds.length,
      };
    }
    if (/SELECT id, route_id FROM directions WHERE timetable_source_id/.test(text)) {
      return { rows: this.provenanceDirections, rowCount: this.provenanceDirections.length };
    }
    if (/^INSERT INTO directions /.test(text)) {
      this.nextDirectionId += 1;
      return { rows: [{ id: this.nextDirectionId }], rowCount: 1 };
    }
    if (/^UPDATE directions /.test(text)) {
      return { rows: [{ id: params[2] }], rowCount: 1 };
    }

    if (/FROM trips JOIN directions ON directions\.id = trips\.direction_id/.test(text)) {
      return {
        rows: this.publishedContributionRows,
        rowCount: this.publishedContributionRows.length,
      };
    }
    if (/SELECT id, timetable_service_family, monday, tuesday/.test(text)) {
      const family = params[1];
      const rows = this.familyTripRows[family]
        || (this.familyTripIds[family] || []).map((id) => ({
          id,
          timetable_service_family: family,
          monday: family === 'weekday',
          tuesday: family === 'weekday',
          wednesday: family === 'weekday',
          thursday: family === 'weekday',
          friday: family === 'weekday',
          saturday: family === 'saturday',
          sunday: family === 'sunday',
          public_holiday: family === 'public_holiday',
        }));
      return { rows, rowCount: rows.length };
    }

    if (/FROM stops .*FOR UPDATE/.test(text)) {
      if (params[1] === 'Stop A') return { rows: [{ id: 250 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    if (/^INSERT INTO stops /.test(text)) {
      this.nextStopId += 1;
      return { rows: [{ id: this.nextStopId }], rowCount: 1 };
    }
    if (/^INSERT INTO trips /.test(text)) {
      this.nextTripId += 1;
      this.insertedTrips.push(params);
      return { rows: [{ id: this.nextTripId }], rowCount: 1 };
    }

    if (/SELECT to_regclass/.test(text)) return { rows: [{ table_name: 'api_response_cache' }], rowCount: 1 };
    if (/^DELETE FROM api_response_cache/.test(text)) return { rows: [], rowCount: 3 };
    return { rows: [], rowCount: 1 };
  }
}

class BulkRecordingDatabase extends RecordingDatabase {
  constructor() {
    const firstExtraction = canonicalExtraction();
    const secondExtraction = canonicalExtraction({
      routeCode: '215',
      sourceKey: 'route-215',
    });
    const firstSource = {
      id: 1,
      operator: 'MyCiti',
      source_key: 'route-214a',
      status: 'changed_review_required',
      approved_version_id: 9,
      pending_version_id: 10,
    };
    super({
      source: firstSource,
      candidate: versionRow(firstExtraction),
      versions: [
        versionRow(firstExtraction, { id: 9, previous_version_id: null, review_status: 'approved' }),
        versionRow(secondExtraction, { id: 19, previous_version_id: null, review_status: 'approved' }),
        versionRow(secondExtraction, { id: 20, previous_version_id: 19 }),
      ],
    });
    this.sources = new Map([
      ['1', firstSource],
      ['2', {
        id: 2,
        operator: 'MyCiti',
        source_key: 'route-215',
        status: 'changed_review_required',
        approved_version_id: 19,
        pending_version_id: 20,
      }],
    ]);
  }

  async query(sql, params = []) {
    if (/FROM timetable_sources\s+WHERE id = \$1\s+FOR UPDATE/s.test(String(sql))) {
      this.source = this.sources.get(String(params[0]));
    }
    return super.query(sql, params);
  }
}

function approvalOptions(overrides = {}) {
  return {
    sourceId: 1,
    versionId: 10,
    reviewer: 'reviewer@example.com',
    note: 'Checked against the cited PDF.',
    verifiedOn: '2026-08-17',
    ...overrides,
  };
}

function publishedContributionRow(overrides = {}) {
  return {
    route_id: 50,
    route_code: '0066',
    route_name: 'BLAAUWBERG RIDGE - HARARE',
    route_effective_date: '2026-08-10',
    direction_id: 81,
    direction_code: '01',
    direction_name: 'BLAAUWBERG RIDGE - HARARE',
    timetable_effective_date: '2026-08-10',
    timetable_service_family: 'public_holiday',
    monday: false,
    tuesday: false,
    wednesday: false,
    thursday: false,
    friday: false,
    saturday: false,
    sunday: false,
    public_holiday: true,
    ...overrides,
  };
}

test('bulk unchanged approval publishes every candidate in one transaction', async () => {
  const database = new BulkRecordingDatabase();
  const results = await bulkApproveUnchangedVersions(database, {
    candidates: [
      { sourceId: 2, versionId: 20 },
      { sourceId: 1, versionId: 10 },
    ],
    reviewer: 'reviewer@example.com',
    note: 'unchanged',
    verifiedOn: '2026-08-17',
  });

  assert.equal(results.length, 2);
  assert.equal(database.calls.filter((call) => call.text === 'BEGIN').length, 1);
  assert.equal(database.calls.filter((call) => call.text === 'COMMIT').length, 1);
  assert.equal(database.calls.filter((call) => call.params.includes('source_approved')).length, 2);
});

test('bulk unchanged approval rolls back if any candidate has timetable changes', async () => {
  const database = new BulkRecordingDatabase();
  database.versions.get('20').comparison.changed_time_count = 1;

  await assert.rejects(
    bulkApproveUnchangedVersions(database, {
      candidates: [
        { sourceId: 1, versionId: 10 },
        { sourceId: 2, versionId: 20 },
      ],
      reviewer: 'reviewer@example.com',
      note: 'unchanged',
      verifiedOn: '2026-08-17',
    }),
    /no longer an unchanged candidate/
  );

  assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  assert.equal(database.calls.some((call) => call.text === 'COMMIT'), false);
});

test('canonical validation rejects empty publication data before any production write', async () => {
  const invalid = canonicalExtraction();
  invalid.routes = [];
  const database = new RecordingDatabase({
    candidate: {
      ...new RecordingDatabase().candidate,
      extraction: invalid,
    },
  });

  await assert.rejects(
    approvePendingVersion(database, approvalOptions()),
    /routes.*must not be empty/
  );
  assert.equal(database.calls[0].text, 'BEGIN');
  assert.match(database.calls[1].text, /pg_advisory_xact_lock/);
  assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  assert.equal(database.calls.some((call) => /^(INSERT|UPDATE|DELETE) (routes|directions|trips|stop_times)/.test(call.text)), false);
});

test('approval requires an attributable reviewer and nonblank note before BEGIN', async () => {
  const database = new RecordingDatabase();
  await assert.rejects(
    approvePendingVersion(database, approvalOptions({ note: '   ' })),
    /note must not be blank/
  );
  assert.equal(database.calls.length, 0);
});

test('approval rejects a future verification date before BEGIN', async () => {
  const database = new RecordingDatabase();
  await assert.rejects(
    approvePendingVersion(database, approvalOptions({ verifiedOn: '9999-12-31' })),
    /cannot be after the current Cape Town date/
  );
  assert.equal(database.calls.length, 0);
  assert.equal(currentCapeTownDate(new Date('2026-08-17T22:30:00.000Z')), '2026-08-18');
});

test('approval preserves a PostgreSQL DATE calendar value across the local timezone', async () => {
  const extraction = canonicalExtraction({ effectiveDate: '2026-07-25' });
  const database = new RecordingDatabase({
    candidate: versionRow(extraction, {
      // This is how node-postgres materializes a DATE in the process timezone.
      // In Cape Town its UTC representation is still the previous day.
      source_effective_date: new Date(2026, 6, 25),
    }),
  });

  await approvePendingVersion(database, approvalOptions());

  assert.equal(database.calls.at(-1).text, 'COMMIT');
  assert.equal(database.insertedTrips[0][11], '2026-07-25');
});

test('approval guards the exact pending version and pending review status', async (t) => {
  await t.test('a stale version id is rejected after locking the source', async () => {
    const database = new RecordingDatabase();
    await assert.rejects(
      approvePendingVersion(database, approvalOptions({ versionId: 11 })),
      /not the exact pending version/
    );
    assert.equal(database.calls.some((call) => /FROM timetable_source_versions/.test(call.text)), false);
    assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  });

  await t.test('a non-pending candidate is rejected after both rows are locked', async () => {
    const database = new RecordingDatabase({
      candidate: { ...new RecordingDatabase().candidate, review_status: 'approved' },
    });
    await assert.rejects(approvePendingVersion(database, approvalOptions()), /approved, not pending/);
    assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  });
});

test('approval verifies the candidate version chain and locks an actually approved predecessor', async (t) => {
  await t.test('a candidate staged against the wrong predecessor is rejected', async () => {
    const candidate = versionRow(canonicalExtraction(), { previous_version_id: 8 });
    const database = new RecordingDatabase({ candidate });
    await assert.rejects(
      approvePendingVersion(database, approvalOptions()),
      /was not staged against approved version 9/
    );
    assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  });

  await t.test('the approved pointer must reference an approved row', async () => {
    const extraction = canonicalExtraction();
    const database = new RecordingDatabase({
      candidate: versionRow(extraction),
      versions: [versionRow(extraction, {
        id: 9,
        previous_version_id: null,
        review_status: 'superseded',
      })],
    });
    await assert.rejects(
      approvePendingVersion(database, approvalOptions()),
      /version 9, which is superseded, not approved/
    );
    assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  });
});

test('MyCiTi route-scope approval replaces all directions and commits metadata atomically', async () => {
  const database = new RecordingDatabase({ routeDirectionIds: [70, 71] });
  const result = await approvePendingVersion(database, approvalOptions());

  assert.equal(database.calls[0].text, 'BEGIN');
  assert.equal(database.calls.at(-1).text, 'COMMIT');
  assert.equal(result.publicationScope, 'route');
  assert.deepEqual(result.routeIds, [50]);

  const deleteDirections = database.calls.find((call) => /^DELETE FROM directions /.test(call.text));
  assert.deepEqual(deleteDirections.params[0], [70, 71]);
  assert.ok(database.calls.some((call) => /^DELETE FROM stop_times /.test(call.text)));
  assert.ok(database.calls.some((call) => /^DELETE FROM trips /.test(call.text)));

  const insertDirection = database.calls.find((call) => /^INSERT INTO directions /.test(call.text));
  assert.deepEqual(insertDirection.params.slice(-2), [1, 10]);
  assert.deepEqual(database.insertedTrips[0].slice(9), [1, 10, '2026-08-10', null, 1, null]);
  assert.ok(database.calls.some((call) => /^UPDATE timetable_source_versions /.test(call.text)));
  assert.ok(database.calls.some((call) => /^UPDATE timetable_sources /.test(call.text)));
  assert.ok(database.calls.some((call) => call.params.includes('source_approved')));
  const approvalEvent = database.calls.find((call) => call.params.includes('source_approved'));
  assert.equal(JSON.parse(approvalEvent.params[4]).previous_version_id, 9);
  assert.ok(database.calls.some((call) => /^DELETE FROM api_response_cache/.test(call.text)
    && call.params[1] === 'schedules:v1'));
});

test('MyCiTi accepts bidirectional routes whose headings repeat the route code', () => {
  const extraction = canonicalExtraction({
    operator: 'MyCiti',
    routeCode: '242',
    directionCode: '242',
    sourceKey: '242',
    effectiveDate: null,
  });
  extraction.routes[0].directions.push({
    ...structuredClone(extraction.routes[0].directions[0]),
    name: 'To Atlantis',
  });

  assert.equal(validateCanonicalExtraction(extraction), extraction);
});

test('MyCiTi still rejects a genuinely duplicated direction name', () => {
  const extraction = canonicalExtraction({
    operator: 'MyCiti',
    routeCode: '242',
    directionCode: '242',
    sourceKey: '242',
    effectiveDate: null,
  });
  extraction.routes[0].directions.push(
    structuredClone(extraction.routes[0].directions[0])
  );

  assert.throws(
    () => validateCanonicalExtraction(extraction),
    /directions\[1\]: duplicates another direction/
  );
});

test('canonical validation rejects duplicate stops within a trip after name normalization', () => {
  const extraction = canonicalExtraction();
  extraction.routes[0].directions[0].services[0].trips[0].times.push({
    sequence: 2,
    stop_name: '  stop   a  ',
    time: null,
    raw_time: '--',
    stop_time_type: 'not_served',
  });

  assert.throws(
    () => validateCanonicalExtraction(extraction),
    /times\[2\]\.stop_name.*duplicates.*times\[0\]\.stop_name after case\/whitespace normalization/
  );
});

test('canonical validation requires one ordered stop vector within each service', () => {
  const extraction = canonicalExtraction();
  const service = extraction.routes[0].directions[0].services[0];
  const secondTrip = structuredClone(service.trips[0]);
  [secondTrip.times[0].stop_name, secondTrip.times[1].stop_name]
    = [secondTrip.times[1].stop_name, secondTrip.times[0].stop_name];
  service.trips.push(secondTrip);

  assert.throws(
    () => validateCanonicalExtraction(extraction),
    /trips\[1\]\.times.*same ordered stop vector as.*trips\[0\]\.times/
  );
});

test('canonical validation allows different stop vectors in different services', () => {
  const extraction = canonicalExtraction();
  const direction = extraction.routes[0].directions[0];
  direction.services.push({
    label: 'SATURDAYS',
    service_days: ['saturday'],
    footnotes: [],
    trips: [{
      footnote_markers: [],
      service_days: ['saturday'],
      times: [{
        sequence: 0,
        stop_name: 'Weekend Stop',
        time: '06:00',
        raw_time: '06:00',
        stop_time_type: 'scheduled',
      }],
    }],
  });

  assert.equal(validateCanonicalExtraction(extraction), extraction);
});

test('GABS approval replaces only candidate service families and preserves regular plus public-holiday coexistence', async () => {
  const publicHoliday = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006603',
    serviceDays: ['public_holiday'],
    effectiveDate: '2026-08-10',
    time: '09:05',
  });
  const priorPublicHoliday = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006603',
    serviceDays: ['public_holiday'],
    effectiveDate: '2026-07-01',
    time: '09:00',
  });
  const regular = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006602',
    serviceDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
    effectiveDate: '2026-07-27',
    time: '05:30',
  });
  const database = new RecordingDatabase({
    source: {
      id: 1,
      operator: 'GABS',
      source_key: '006603',
      status: 'changed_review_required',
      approved_version_id: 9,
      pending_version_id: 10,
    },
    candidate: versionRow(publicHoliday),
    versions: [versionRow(priorPublicHoliday, {
      id: 9,
      previous_version_id: null,
      review_status: 'approved',
    })],
    approvedContributors: [approvedContributor({
      sourceId: 2,
      versionId: 20,
      extraction: regular,
    })],
    composedDirectionId: 81,
    familyTripIds: { weekday: [300], public_holiday: [301] },
  });

  const result = await approvePendingVersion(database, approvalOptions());
  assert.equal(result.publicationScope, 'service_days');

  const familyLocks = database.calls.filter((call) => /SELECT id, timetable_service_family, monday, tuesday/.test(call.text));
  assert.deepEqual(familyLocks.map((call) => call.params), [[81, 'public_holiday']]);
  const tripDeletion = database.calls.find((call) => /^DELETE FROM trips WHERE id = ANY/.test(call.text));
  assert.deepEqual(tripDeletion.params[0], [301]);
  assert.equal(database.calls.some((call) => /^DELETE FROM directions WHERE id = ANY/.test(call.text)), false);

  assert.equal(database.insertedTrips.length, 1);
  assert.deepEqual(database.insertedTrips[0].slice(6), [false, false, true, 1, 10, '2026-08-10', 'public_holiday', 1, null]);
  const insertedStopTimes = database.calls.find((call) => /^INSERT INTO stop_times /.test(call.text));
  assert.equal(JSON.parse(insertedStopTimes.params[0])[0].departure, '09:05');
});

test('newest child direction effective date deterministically wins an overlapping GABS family', async () => {
  const candidateExtraction = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006603',
    effectiveDate: '2026-08-10',
    time: '09:05',
  });
  const newerExtraction = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006604',
    effectiveDate: '2026-08-12',
    time: '09:15',
  });
  const database = new RecordingDatabase({
    source: {
      id: 1,
      operator: 'GABS',
      source_key: '006603',
      status: 'changed_review_required',
      approved_version_id: null,
      pending_version_id: 10,
    },
    candidate: versionRow(candidateExtraction, { previous_version_id: null }),
    approvedContributors: [approvedContributor({
      sourceId: 2,
      versionId: 20,
      extraction: newerExtraction,
    })],
    familyTripIds: { public_holiday: [301] },
  });

  await approvePendingVersion(database, approvalOptions());
  assert.deepEqual(database.insertedTrips[0].slice(9), [2, 20, '2026-08-12', 'public_holiday', 1, null]);
  const insertedStopTimes = database.calls.find((call) => /^INSERT INTO stop_times /.test(call.text));
  assert.equal(JSON.parse(insertedStopTimes.params[0])[0].departure, '09:15');
});

test('GABS composition consolidates duplicate logical directions without matching a different nonnull code by name', async () => {
  const extraction = canonicalExtraction({ operator: 'GABS', sourceKey: '006603' });
  const database = new RecordingDatabase({
    source: {
      id: 1,
      operator: 'GABS',
      source_key: '006603',
      status: 'changed_review_required',
      approved_version_id: null,
      pending_version_id: 10,
    },
    candidate: versionRow(extraction, { previous_version_id: null }),
    composedDirectionId: [81, 82],
    familyTripIds: { public_holiday: [301] },
  });

  await approvePendingVersion(database, approvalOptions());
  const directionLock = database.calls.find((call) => /FROM directions WHERE route_id = \$1 AND \(/.test(call.text));
  assert.match(directionLock.text, /code IS NULL AND direction = \$3/);
  assert.doesNotMatch(directionLock.text, /OR direction = \$3/);
  const consolidation = database.calls.find((call) => /^UPDATE trips SET direction_id = \$1/.test(call.text));
  assert.deepEqual(consolidation.params, [81, [82]]);
  const duplicateDeletion = database.calls.find((call) => /^DELETE FROM directions WHERE id = ANY/.test(call.text));
  assert.deepEqual(duplicateDeletion.params[0], [82]);
});

test('GABS composition trims only the target flags from an untagged legacy multi-family trip', async () => {
  const extraction = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006602',
    serviceDays: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  });
  const database = new RecordingDatabase({
    source: {
      id: 1,
      operator: 'GABS',
      source_key: '006602',
      status: 'changed_review_required',
      approved_version_id: null,
      pending_version_id: 10,
    },
    candidate: versionRow(extraction, { previous_version_id: null }),
    familyTripRows: {
      weekday: [{
        id: 500,
        timetable_service_family: null,
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: true,
        sunday: false,
        public_holiday: false,
      }],
    },
  });

  await approvePendingVersion(database, approvalOptions());
  const trim = database.calls.find((call) => /^UPDATE trips SET monday = FALSE/.test(call.text));
  assert.deepEqual(trim.params, [[500]]);
  assert.match(trim.text, /friday = FALSE/);
  assert.doesNotMatch(trim.text, /saturday = FALSE/);
  assert.equal(database.calls.some((call) => /^DELETE FROM trips WHERE id = ANY/.test(call.text)
    && call.params[0].includes(500)), false);
  assert.deepEqual(database.insertedTrips[0].slice(1, 9), [true, true, true, true, true, false, false, false]);
});

test('approval rejects future child effective dates without touching production', async () => {
  const extraction = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006603',
    effectiveDate: '2026-08-18',
  });
  const database = new RecordingDatabase({
    source: {
      id: 1,
      operator: 'GABS',
      source_key: '006603',
      status: 'changed_review_required',
      approved_version_id: null,
      pending_version_id: 10,
    },
    candidate: versionRow(extraction),
  });

  await assert.rejects(
    approvePendingVersion(database, approvalOptions({ verifiedOn: '2026-08-17' })),
    /effective date 2026-08-18 is after verification date 2026-08-17/
  );
  assert.equal(database.calls.some((call) => /^(INSERT|UPDATE|DELETE) (routes|directions|trips|stop_times)/.test(call.text)), false);
  assert.equal(database.calls.at(-1).text, 'ROLLBACK');
});

test('approval rejects inconsistent canonical and stored effective-date metadata', async (t) => {
  await t.test('top-level canonical date must be the maximum child date', async () => {
    const extraction = canonicalExtraction({ operator: 'GABS', sourceKey: '006603' });
    extraction.effective_date = '2099-01-01';
    const database = new RecordingDatabase({
      source: {
        id: 1,
        operator: 'GABS',
        source_key: '006603',
        status: 'changed_review_required',
        approved_version_id: null,
        pending_version_id: 10,
      },
      candidate: versionRow(extraction),
    });

    await assert.rejects(
      approvePendingVersion(database, approvalOptions()),
      /must equal the newest child direction effective date "2026-08-10"/
    );
    assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  });

  await t.test('stored source date must match the canonical date', async () => {
    const extraction = canonicalExtraction({ operator: 'GABS', sourceKey: '006603' });
    const database = new RecordingDatabase({
      source: {
        id: 1,
        operator: 'GABS',
        source_key: '006603',
        status: 'changed_review_required',
        approved_version_id: null,
        pending_version_id: 10,
      },
      candidate: versionRow(extraction, { source_effective_date: '2099-01-01' }),
    });

    await assert.rejects(
      approvePendingVersion(database, approvalOptions()),
      /does not match canonical effective date/
    );
    assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  });
});

test('a production write failure rolls back and never commits', async () => {
  const database = new RecordingDatabase({ failOn: /^INSERT INTO stop_times / });
  await assert.rejects(approvePendingVersion(database, approvalOptions()), /injected database failure/);

  assert.equal(database.calls.at(-1).text, 'ROLLBACK');
  assert.equal(database.calls.some((call) => call.text === 'COMMIT'), false);
  assert.equal(database.calls.some((call) => /^UPDATE timetable_sources /.test(call.text)), false);
});

test('trip-specific normalized service days drive production flags', () => {
  const flags = serviceDayFlags(['monday', 'tuesday', 'wednesday', 'thursday']);
  assert.equal(flags.monday, true);
  assert.equal(flags.thursday, true);
  assert.equal(flags.friday, false);
  assert.equal(flags.public_holiday, false);
});

test('withdrawal unpublishes only directions carrying that source provenance', async () => {
  const database = new RecordingDatabase({
    provenanceDirections: [
      { id: 91, route_id: 50 },
      { id: 92, route_id: 50 },
    ],
  });
  const result = await withdrawSource(database, {
    sourceId: 1,
    reviewer: 'reviewer@example.com',
    note: 'The operator withdrew this timetable.',
  });

  assert.deepEqual(result.directionIds, [91, 92]);
  const deletion = database.calls.find((call) => /^DELETE FROM directions /.test(call.text));
  assert.deepEqual(deletion.params[0], [91, 92]);
  assert.ok(database.calls.some((call) => call.params.includes('withdrawn')));
  assert.ok(database.calls.some((call) => call.params.includes('source_withdrawn')));
  const sourceWithdrawal = database.calls.find((call) => /^UPDATE timetable_sources /.test(call.text));
  assert.match(sourceWithdrawal.text, /approved_version_id = NULL/);
  const event = database.calls.find((call) => call.params.includes('source_withdrawn'));
  assert.equal(event.params[1], 9);
  assert.equal(result.withdrawnVersionId, 9);
  assert.equal(database.calls.at(-1).text, 'COMMIT');
});

test('GABS withdrawal removes that source family and restores the next-newest approved contribution', async () => {
  const withdrawnExtraction = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006603',
    effectiveDate: '2026-08-10',
    time: '09:05',
  });
  const fallbackExtraction = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006604',
    effectiveDate: '2026-08-01',
    time: '08:55',
  });
  const database = new RecordingDatabase({
    source: {
      id: 1,
      operator: 'GABS',
      source_key: '006603',
      status: 'verified',
      approved_version_id: 10,
      pending_version_id: null,
    },
    candidate: versionRow(withdrawnExtraction, { review_status: 'approved' }),
    approvedContributors: [approvedContributor({
      sourceId: 2,
      versionId: 20,
      extraction: fallbackExtraction,
    })],
    publishedContributionRows: [publishedContributionRow()],
    familyTripIds: { public_holiday: [401] },
  });

  const result = await withdrawSource(database, {
    sourceId: 1,
    reviewer: 'reviewer@example.com',
    note: 'The operator withdrew this timetable.',
  });

  assert.deepEqual(result.directionIds, []);
  const tripDeletion = database.calls.find((call) => /^DELETE FROM trips WHERE id = ANY/.test(call.text));
  assert.deepEqual(tripDeletion.params[0], [401]);
  assert.deepEqual(database.insertedTrips[0].slice(9), [2, 20, '2026-08-01', 'public_holiday', 1, null]);
  const insertedStopTimes = database.calls.find((call) => /^INSERT INTO stop_times /.test(call.text));
  assert.equal(JSON.parse(insertedStopTimes.params[0])[0].departure, '08:55');
  assert.equal(database.calls.some((call) => /^DELETE FROM directions WHERE id = ANY/.test(call.text)), false);
  assert.equal(database.calls.at(-1).text, 'COMMIT');
});

test('GABS withdrawal uses production provenance when its approved extraction is corrupt', async () => {
  const corruptExtraction = canonicalExtraction({ operator: 'GABS', sourceKey: '006603' });
  corruptExtraction.routes = [];
  const fallbackExtraction = canonicalExtraction({
    operator: 'GABS',
    sourceKey: '006604',
    effectiveDate: '2026-08-01',
    time: '08:55',
  });
  const database = new RecordingDatabase({
    source: {
      id: 1,
      operator: 'GABS',
      source_key: '006603',
      status: 'verified',
      approved_version_id: 10,
      pending_version_id: null,
    },
    candidate: versionRow(corruptExtraction, { review_status: 'approved' }),
    approvedContributors: [approvedContributor({
      sourceId: 2,
      versionId: 20,
      extraction: fallbackExtraction,
    })],
    publishedContributionRows: [publishedContributionRow()],
    familyTripIds: { public_holiday: [401] },
  });

  const result = await withdrawSource(database, {
    sourceId: 1,
    reviewer: 'reviewer@example.com',
    note: 'Emergency withdrawal of a malformed historical version.',
  });

  assert.deepEqual(result.routeIds, [50]);
  assert.deepEqual(database.insertedTrips[0].slice(9), [2, 20, '2026-08-01', 'public_holiday', 1, null]);
  assert.match(
    database.calls.find((call) => /^UPDATE timetable_sources /.test(call.text)).text,
    /approved_version_id = NULL/
  );
  assert.equal(database.calls.at(-1).text, 'COMMIT');
});

test('approval and withdrawal invalidate unfinished audit runs while preserving completed runs', async () => {
  const approvedDatabase = new RecordingDatabase();
  await approvePendingVersion(approvedDatabase, approvalOptions());
  const approvalInvalidation = approvedDatabase.calls.find((call) => /^UPDATE timetable_audit_runs /.test(call.text));
  assert.deepEqual(approvalInvalidation.params, ['cancelled', ['planned', 'in_progress']]);
  assert.match(approvalInvalidation.text, /WHERE status = ANY\(\$2::text\[\]\)/);
  const approvalSourceLock = approvedDatabase.calls.find((call) => /FROM timetable_sources WHERE id = \$1 FOR UPDATE/.test(call.text));
  assert.equal(approvedDatabase.calls.indexOf(approvalInvalidation) < approvedDatabase.calls.indexOf(approvalSourceLock), true);

  const withdrawnDatabase = new RecordingDatabase();
  await withdrawSource(withdrawnDatabase, {
    sourceId: 1,
    reviewer: 'reviewer@example.com',
    note: 'The operator withdrew this timetable.',
  });
  const withdrawalInvalidation = withdrawnDatabase.calls.find((call) => /^UPDATE timetable_audit_runs /.test(call.text));
  assert.deepEqual(withdrawalInvalidation.params, ['cancelled', ['planned', 'in_progress']]);
  assert.equal(withdrawnDatabase.calls.indexOf(withdrawalInvalidation) < withdrawnDatabase.calls.length - 1, true);
});

test('withdrawal requires an attributable reviewer and nonblank note before BEGIN', async () => {
  const database = new RecordingDatabase();
  await assert.rejects(
    withdrawSource(database, { sourceId: 1, reviewer: 'reviewer', note: '   ' }),
    /note must not be blank/
  );
  assert.equal(database.calls.length, 0);
});

test('validator requires normalized trip days when footnotes restrict a trip', () => {
  const extraction = canonicalExtraction({ operator: 'GABS' });
  const service = extraction.routes[0].directions[0].services[0];
  service.service_days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
  service.footnotes = [{ marker: 'a', text: 'Mondays to Thursdays' }];
  service.trips[0].footnote_markers = ['a'];
  delete service.trips[0].service_days;
  assert.throws(() => validateCanonicalExtraction(extraction), /service_days.*required/);

  service.trips[0].service_days = ['monday', 'tuesday', 'wednesday', 'thursday'];
  assert.equal(validateCanonicalExtraction(extraction), extraction);
});
