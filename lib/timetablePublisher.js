const SERVICE_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'public_holiday',
];

const PUBLICATION_SCOPES = {
  GABS: 'service_days',
  MyCiti: 'route',
};

const SERVICE_FAMILY_DAYS = {
  weekday: SERVICE_DAYS.slice(0, 5),
  saturday: ['saturday'],
  sunday: ['sunday'],
  public_holiday: ['public_holiday'],
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUnchangedComparison(comparison) {
  if (!isPlainObject(comparison) || comparison.parse_error) return false;

  if (!Object.hasOwn(comparison, 'has_changes') || comparison.has_changes !== false) {
    return false;
  }

  return ['changed_time_count', 'added_time_count', 'removed_time_count'].every((key) => {
    const value = comparison[key];
    return Object.hasOwn(comparison, key) &&
      (typeof value === 'number' || typeof value === 'string') &&
      String(value).trim() !== '' &&
      Number(value) === 0;
  });
}

function fail(path, message) {
  throw new Error(`Invalid canonical extraction at ${path}: ${message}`);
}

function requireObject(value, path) {
  if (!isPlainObject(value)) fail(path, 'expected an object');
  return value;
}

function requireArray(value, path, { nonempty = false } = {}) {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  if (nonempty && value.length === 0) fail(path, 'must not be empty');
  return value;
}

function requireString(value, path, { nullable = false, nonempty = true } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') fail(path, nullable ? 'expected a string or null' : 'expected a string');
  if (nonempty && value.trim() === '') fail(path, 'must not be blank');
  return value;
}

function canonicalIsoDate(value, path, { nullable = true } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(path, nullable ? 'expected YYYY-MM-DD or null' : 'expected YYYY-MM-DD');
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(path, 'contains an invalid calendar date');
  }
  return value;
}

function currentCapeTownDate(now = new Date()) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('Current date is invalid.');
  }
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function databaseIsoDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error('Candidate effective date is invalid.');
    // node-postgres represents a PostgreSQL `date` as local midnight.  Going
    // through UTC can therefore turn 2026-07-25 into 2026-07-24 in Cape Town.
    // Preserve its calendar components because a SQL DATE has no timezone.
    const year = String(value.getFullYear()).padStart(4, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return canonicalIsoDate(`${year}-${month}-${day}`, 'candidate.source_effective_date');
  }
  return canonicalIsoDate(String(value).slice(0, 10), 'candidate.source_effective_date');
}

function maxEffectiveDate(values) {
  const dates = values.filter((value) => value !== null && value !== undefined && value !== '')
    .map(databaseIsoDate);
  return dates.length ? dates.sort().at(-1) : null;
}

function directionEffectiveDate(direction, extraction, sourceEffectiveDate) {
  return databaseIsoDate(
    direction.effective_date || extraction.effective_date || sourceEffectiveDate
  );
}

function uniqueStrings(values, path) {
  const seen = new Set();
  values.forEach((value, index) => {
    requireString(value, `${path}[${index}]`);
    if (seen.has(value)) fail(`${path}[${index}]`, `duplicate value ${JSON.stringify(value)}`);
    seen.add(value);
  });
  return seen;
}

function canonicalStopNameKey(value) {
  return value.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-ZA');
}

function validateOrderedServiceDays(days, path) {
  uniqueStrings(days, path);
  let previousIndex = -1;
  days.forEach((day, dayIndex) => {
    const serviceDayIndex = SERVICE_DAYS.indexOf(day);
    if (serviceDayIndex === -1) fail(`${path}[${dayIndex}]`, 'is not a supported service day');
    if (serviceDayIndex <= previousIndex) fail(path, 'must follow canonical service-day order');
    previousIndex = serviceDayIndex;
  });
}

function validateCanonicalExtraction(value, expected = {}) {
  let extraction = value;
  if (typeof extraction === 'string') {
    try {
      extraction = JSON.parse(extraction);
    } catch (error) {
      throw new Error(`Invalid canonical extraction JSON: ${error.message}`);
    }
  }

  requireObject(extraction, '$');
  if (extraction.schema_version !== 1) fail('$.schema_version', 'expected integer 1');
  requireString(extraction.operator, '$.operator');
  requireString(extraction.source_key, '$.source_key');

  if (!Object.hasOwn(extraction, 'effective_date')) fail('$.effective_date', 'is required');
  canonicalIsoDate(extraction.effective_date, '$.effective_date');

  const requiredScope = PUBLICATION_SCOPES[extraction.operator];
  if (!requiredScope) fail('$.operator', `unsupported operator ${JSON.stringify(extraction.operator)}`);
  if (extraction.publication_scope !== requiredScope) {
    fail('$.publication_scope', `${extraction.operator} requires ${JSON.stringify(requiredScope)} scope`);
  }
  if (expected.operator && extraction.operator !== expected.operator) {
    fail('$.operator', `does not match source operator ${JSON.stringify(expected.operator)}`);
  }
  if (expected.sourceKey && extraction.source_key !== expected.sourceKey) {
    fail('$.source_key', `does not match source key ${JSON.stringify(expected.sourceKey)}`);
  }

  const routeKeys = new Set();
  const childEffectiveDates = [];
  requireArray(extraction.routes, '$.routes', { nonempty: true }).forEach((route, routeIndex) => {
    const routePath = `$.routes[${routeIndex}]`;
    requireObject(route, routePath);
    requireString(route.code, `${routePath}.code`);
    requireString(route.name, `${routePath}.name`);
    const routeKey = route.code.toLocaleLowerCase('en-ZA');
    if (routeKeys.has(routeKey)) fail(`${routePath}.code`, 'duplicates another route code case-insensitively');
    routeKeys.add(routeKey);

    const directionKeys = new Set();
    requireArray(route.directions, `${routePath}.directions`, { nonempty: true })
      .forEach((direction, directionIndex) => {
        const directionPath = `${routePath}.directions[${directionIndex}]`;
        requireObject(direction, directionPath);
        if (!Object.hasOwn(direction, 'code')) fail(`${directionPath}.code`, 'is required');
        requireString(direction.code, `${directionPath}.code`, { nullable: true });
        requireString(direction.name, `${directionPath}.name`);
        if (!Object.hasOwn(direction, 'effective_date')) fail(`${directionPath}.effective_date`, 'is required');
        const directionDate = canonicalIsoDate(direction.effective_date, `${directionPath}.effective_date`);
        if (directionDate) childEffectiveDates.push(directionDate);

        // GABS direction codes are stable direction-specific identifiers.
        // MyCiTi repeats the route code in each direction heading, so a normal
        // two-way route legitimately has the same code twice and must instead
        // be distinguished by its direction name.
        const directionKey = extraction.operator === 'MyCiti' || direction.code === null
          ? `name:${direction.name.toLocaleLowerCase('en-ZA')}`
          : `code:${direction.code.toLocaleLowerCase('en-ZA')}`;
        if (directionKeys.has(directionKey)) fail(directionPath, 'duplicates another direction');
        directionKeys.add(directionKey);

        requireArray(direction.services, `${directionPath}.services`, { nonempty: true })
          .forEach((service, serviceIndex) => {
            const servicePath = `${directionPath}.services[${serviceIndex}]`;
            requireObject(service, servicePath);
            requireString(service.label, `${servicePath}.label`);
            const days = requireArray(service.service_days, `${servicePath}.service_days`, { nonempty: true });
            validateOrderedServiceDays(days, `${servicePath}.service_days`);

            const footnoteMarkers = new Set();
            let previousFootnoteMarker = null;
            requireArray(service.footnotes, `${servicePath}.footnotes`).forEach((footnote, footnoteIndex) => {
              const footnotePath = `${servicePath}.footnotes[${footnoteIndex}]`;
              requireObject(footnote, footnotePath);
              requireString(footnote.marker, `${footnotePath}.marker`);
              requireString(footnote.text, `${footnotePath}.text`, { nonempty: false });
              if (footnoteMarkers.has(footnote.marker)) fail(`${footnotePath}.marker`, 'is duplicated');
              if (previousFootnoteMarker !== null && previousFootnoteMarker.localeCompare(footnote.marker) >= 0) {
                fail(`${servicePath}.footnotes`, 'must be sorted by marker');
              }
              footnoteMarkers.add(footnote.marker);
              previousFootnoteMarker = footnote.marker;
            });

            let expectedStopVector = null;
            requireArray(service.trips, `${servicePath}.trips`, { nonempty: true })
              .forEach((trip, tripIndex) => {
                const tripPath = `${servicePath}.trips[${tripIndex}]`;
                requireObject(trip, tripPath);
                const markers = requireArray(trip.footnote_markers, `${tripPath}.footnote_markers`);
                uniqueStrings(markers, `${tripPath}.footnote_markers`);
                markers.forEach((marker, markerIndex) => {
                  if (!footnoteMarkers.has(marker)) {
                    fail(`${tripPath}.footnote_markers[${markerIndex}]`, 'has no definition in service footnotes');
                  }
                });
                if (Object.hasOwn(trip, 'service_days')) {
                  const tripDays = requireArray(trip.service_days, `${tripPath}.service_days`, { nonempty: true });
                  validateOrderedServiceDays(tripDays, `${tripPath}.service_days`);
                  tripDays.forEach((day, dayIndex) => {
                    if (!days.includes(day)) {
                      fail(`${tripPath}.service_days[${dayIndex}]`, 'is outside the enclosing service days');
                    }
                  });
                } else if (markers.length > 0) {
                  fail(`${tripPath}.service_days`, 'is required for a footnote-restricted trip');
                }

                let scheduledCount = 0;
                const stopNames = [];
                const stopNameIndexes = new Map();
                requireArray(trip.times, `${tripPath}.times`, { nonempty: true })
                  .forEach((stopTime, timeIndex) => {
                    const timePath = `${tripPath}.times[${timeIndex}]`;
                    requireObject(stopTime, timePath);
                    if (!Number.isInteger(stopTime.sequence) || stopTime.sequence !== timeIndex) {
                      fail(`${timePath}.sequence`, `expected zero-based sequence ${timeIndex}`);
                    }
                    requireString(stopTime.stop_name, `${timePath}.stop_name`);
                    const stopNameKey = canonicalStopNameKey(stopTime.stop_name);
                    if (stopNameIndexes.has(stopNameKey)) {
                      fail(
                        `${timePath}.stop_name`,
                        `duplicates ${tripPath}.times[${stopNameIndexes.get(stopNameKey)}].stop_name after case/whitespace normalization`
                      );
                    }
                    stopNameIndexes.set(stopNameKey, timeIndex);
                    stopNames.push(stopTime.stop_name);
                    if (stopTime.time !== null && (typeof stopTime.time !== 'string'
                      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(stopTime.time))) {
                      fail(`${timePath}.time`, 'expected HH:MM or null');
                    }
                    requireString(stopTime.raw_time, `${timePath}.raw_time`, { nonempty: false });
                    if (!['scheduled', 'not_served', 'via'].includes(stopTime.stop_time_type)) {
                      fail(`${timePath}.stop_time_type`, 'expected scheduled, not_served, or via');
                    }
                    if (stopTime.stop_time_type === 'scheduled' && stopTime.time === null) {
                      fail(timePath, 'a scheduled stop must have a time');
                    }
                    if (stopTime.stop_time_type !== 'scheduled' && stopTime.time !== null) {
                      fail(timePath, 'only scheduled stops may have a time');
                    }
                    if (stopTime.time !== null) scheduledCount += 1;
                  });
                if (scheduledCount === 0) fail(tripPath, 'must contain at least one scheduled time');
                if (expectedStopVector === null) {
                  expectedStopVector = stopNames;
                } else if (stopNames.length !== expectedStopVector.length
                  || stopNames.some((stopName, index) => stopName !== expectedStopVector[index])) {
                  fail(
                    `${tripPath}.times`,
                    `must have the same ordered stop vector as ${servicePath}.trips[0].times`
                  );
                }
              });
          });
      });
  });

  const expectedEffectiveDate = childEffectiveDates.length
    ? [...childEffectiveDates].sort().at(-1)
    : null;
  if (extraction.effective_date !== expectedEffectiveDate) {
    fail(
      '$.effective_date',
      `must equal the newest child direction effective date ${JSON.stringify(expectedEffectiveDate)}`
    );
  }

  return extraction;
}

function serviceDayFlags(serviceDays) {
  const selected = new Set(serviceDays);
  return Object.fromEntries(SERVICE_DAYS.map((day) => [day, selected.has(day)]));
}

function footnoteServiceDays(service, trip) {
  if (Array.isArray(trip.service_days) && trip.service_days.length > 0) return trip.service_days;
  if (trip.footnote_markers.length === 0) return service.service_days;
  throw new Error(
    `Cannot safely publish footnote-restricted trip ${trip.footnote_markers.join(', ')} without normalized trip service days.`
  );
}

function partitionServiceDays(serviceDays) {
  const selected = new Set(serviceDays);
  return Object.entries(SERVICE_FAMILY_DAYS).flatMap(([family, familyDays]) => {
    const days = familyDays.filter((day) => selected.has(day));
    return days.length ? [{ family, days }] : [];
  });
}

function directionIdentity(direction) {
  return direction.code === null
    ? `name:${direction.name}`
    : `code:${direction.code.toLocaleLowerCase('en-ZA')}`;
}

function contributionKey(route, direction, family) {
  return JSON.stringify([
    route.code.toLocaleLowerCase('en-ZA'),
    directionIdentity(direction),
    family,
  ]);
}

function compareIdentifiers(first, second) {
  try {
    const firstNumber = BigInt(String(first));
    const secondNumber = BigInt(String(second));
    return firstNumber < secondNumber ? -1 : firstNumber > secondNumber ? 1 : 0;
  } catch {
    return String(first).localeCompare(String(second));
  }
}

function compareContributions(first, second) {
  const dateComparison = String(first.effectiveDate || '').localeCompare(String(second.effectiveDate || ''));
  if (dateComparison !== 0) return dateComparison;
  const versionComparison = compareIdentifiers(first.versionId, second.versionId);
  if (versionComparison !== 0) return versionComparison;
  const sourceComparison = String(first.sourceKey).localeCompare(String(second.sourceKey));
  if (sourceComparison !== 0) return sourceComparison;
  return compareIdentifiers(first.sourceId, second.sourceId);
}

function contributionsFromVersion(version) {
  const extraction = validateCanonicalExtraction(version.extraction, {
    operator: 'GABS',
    sourceKey: version.sourceKey,
  });
  const contributions = new Map();

  for (const route of extraction.routes) {
    for (const direction of route.directions) {
      const effectiveDate = directionEffectiveDate(direction, extraction, version.sourceEffectiveDate);
      let tripOrdinal = 0;
      for (const service of direction.services) {
        for (const trip of service.trips) {
          tripOrdinal += 1;
          for (const partition of partitionServiceDays(footnoteServiceDays(service, trip))) {
            const key = contributionKey(route, direction, partition.family);
            if (!contributions.has(key)) {
              contributions.set(key, {
                key,
                family: partition.family,
                route,
                direction,
                effectiveDate,
                sourceId: version.sourceId,
                sourceKey: version.sourceKey,
                versionId: version.versionId,
                trips: [],
              });
            }
            contributions.get(key).trips.push({
              times: trip.times,
              serviceDays: partition.days,
              tripOrdinal,
            });
          }
        }
      }
    }
  }
  return contributions;
}

function selectContributionWinners(versions, { notAfter = null } = {}) {
  const winners = new Map();
  for (const version of versions) {
    for (const [key, contribution] of contributionsFromVersion(version)) {
      if (notAfter && contribution.effectiveDate && contribution.effectiveDate > notAfter) continue;
      const current = winners.get(key);
      if (!current || compareContributions(current, contribution) < 0) {
        winners.set(key, contribution);
      }
    }
  }
  return winners;
}

function assertNoFutureEffectiveDates(extraction, sourceEffectiveDate, verifiedOn) {
  for (const route of extraction.routes) {
    for (const direction of route.directions) {
      const effectiveDate = directionEffectiveDate(direction, extraction, sourceEffectiveDate);
      if (effectiveDate && effectiveDate > verifiedOn) {
        throw new Error(
          `Cannot publish ${route.code} ${direction.name}: effective date ${effectiveDate} is after verification date ${verifiedOn}.`
        );
      }
    }
  }
}

function assertIdentifier(value, label) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value)) || String(value) === '0') {
    throw new Error(`${label} must be a positive numeric identifier.`);
  }
}

function assertNonblank(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must not be blank.`);
  return value.trim();
}

function sameIdentifier(first, second) {
  return first !== null && first !== undefined && second !== null && second !== undefined
    && String(first) === String(second);
}

async function transactionClient(database) {
  if (!database) throw new Error('A database connection or pool is required.');
  if (typeof database.connect === 'function') {
    const client = await database.connect();
    if (!client || typeof client.query !== 'function') throw new Error('Database pool returned an invalid client.');
    return { client, release: () => client.release?.() };
  }
  if (typeof database.query !== 'function') throw new Error('Database must expose query(sql, params).');
  return { client: database, release: () => {} };
}

async function inTransaction(database, operation) {
  const { client, release } = await transactionClient(database);
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (began) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the publication error; a broken connection can also reject rollback.
      }
    }
    throw error;
  } finally {
    release();
  }
}

async function lockPublicationTransaction(client) {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1));',
    ['fika:timetable-publication']
  );
}

async function lockSource(client, sourceId) {
  const { rows } = await client.query(`
    SELECT id, operator, source_key, status, approved_version_id, pending_version_id, section_mode
    FROM timetable_sources
    WHERE id = $1
    FOR UPDATE;
  `, [sourceId]);
  if (!rows[0]) throw new Error(`Timetable source ${sourceId} was not found.`);
  return rows[0];
}

async function lockVersion(client, sourceId, versionId) {
  const { rows } = await client.query(`
    SELECT id, source_id, previous_version_id, pdf_sha256, content_sha256,
      source_effective_date, parser_version, import_version, source_url,
      review_status, extraction, comparison
    FROM timetable_source_versions
    WHERE id = $1 AND source_id = $2
    FOR UPDATE;
  `, [versionId, sourceId]);
  if (!rows[0]) throw new Error(`Timetable source version ${versionId} was not found for source ${sourceId}.`);
  return rows[0];
}

async function lockApprovedContributors(client, excludedSourceId) {
  const { rows } = await client.query(`
    SELECT
      sources.id AS source_id,
      sources.source_key,
      versions.id AS version_id,
      versions.source_effective_date,
      versions.extraction
    FROM timetable_sources AS sources
    JOIN timetable_source_versions AS versions
      ON versions.id = sources.approved_version_id
    WHERE sources.operator = $1
      AND sources.status != $2
      AND sources.id != $3
      AND versions.review_status = $4
    ORDER BY sources.id, versions.id
    FOR UPDATE OF sources, versions;
  `, ['GABS', 'withdrawn', excludedSourceId, 'approved']);
  return rows.map((row) => ({
    sourceId: row.source_id,
    sourceKey: row.source_key,
    versionId: row.version_id,
    sourceEffectiveDate: row.source_effective_date,
    extraction: row.extraction,
  }));
}

function versionContributionRecord(source, version) {
  return {
    sourceId: source.id,
    sourceKey: source.source_key,
    versionId: version.id,
    sourceEffectiveDate: version.source_effective_date,
    extraction: version.extraction,
  };
}

async function lockPublishedContributionsForSource(client, source, versionId) {
  const { rows } = await client.query(`
    SELECT
      routes.id AS route_id,
      routes.code AS route_code,
      routes.name AS route_name,
      routes.effective_date AS route_effective_date,
      directions.id AS direction_id,
      directions.code AS direction_code,
      directions.direction AS direction_name,
      trips.timetable_effective_date,
      trips.timetable_service_family,
      trips.monday, trips.tuesday, trips.wednesday, trips.thursday, trips.friday,
      trips.saturday, trips.sunday, trips.public_holiday
    FROM trips
    JOIN directions ON directions.id = trips.direction_id
    JOIN routes ON routes.id = directions.route_id
    WHERE trips.timetable_source_id = $1
       OR (
         trips.timetable_source_id IS NULL
         AND directions.timetable_source_id = $1
       )
    ORDER BY routes.id, directions.id, trips.id
    FOR UPDATE OF routes, directions, trips;
  `, [source.id]);

  const contributions = new Map();
  for (const row of rows) {
    const route = { code: String(row.route_code), name: String(row.route_name) };
    const direction = {
      code: row.direction_code === null || row.direction_code === undefined
        ? null
        : String(row.direction_code),
      name: String(row.direction_name),
    };
    const taggedFamily = SERVICE_FAMILY_DAYS[row.timetable_service_family]
      ? [row.timetable_service_family]
      : [];
    const inferredFamilies = partitionServiceDays(
      SERVICE_DAYS.filter((day) => Boolean(row[day]))
    ).map((partition) => partition.family);
    const families = taggedFamily.length ? taggedFamily : inferredFamilies;
    for (const family of families) {
      const key = contributionKey(route, direction, family);
      if (!contributions.has(key)) {
        contributions.set(key, {
          key,
          family,
          route,
          direction,
          effectiveDate: databaseIsoDate(
            row.timetable_effective_date || row.route_effective_date
          ),
          sourceId: source.id,
          sourceKey: source.source_key,
          versionId,
          trips: [],
        });
      }
    }
  }
  return contributions;
}

async function reuseOrCreateRoute(client, operator, route, effectiveDate, { preserveName = false } = {}) {
  const existingResult = await client.query(`
    SELECT id, name, effective_date
    FROM routes
    WHERE agency = $1 AND lower(code) = lower($2)
    ORDER BY id
    LIMIT 1
    FOR UPDATE;
  `, [operator, route.code]);

  if (existingResult.rows[0]) {
    const { rows } = await client.query(`
      UPDATE routes
      SET name = CASE
            WHEN effective_date IS NULL THEN $1
            WHEN $3::date IS NOT NULL AND $3::date >= effective_date THEN $1
            ELSE name
          END,
          code = $2,
          effective_date = CASE
            WHEN $3::date IS NULL THEN effective_date
            WHEN effective_date IS NULL THEN $3::date
            ELSE GREATEST(effective_date, $3::date)
          END
      WHERE id = $4
      RETURNING id, effective_date;
    `, [preserveName ? existingResult.rows[0].name : route.name, route.code, effectiveDate, existingResult.rows[0].id]);
    return rows[0];
  }

  const { rows } = await client.query(`
    INSERT INTO routes (name, code, agency, effective_date)
    VALUES ($1, $2, $3, $4::date)
    RETURNING id, effective_date;
  `, [route.name, route.code, operator, effectiveDate]);
  return rows[0];
}

async function directionIdsForPublication(client, routeId, publicationScope, directions) {
  if (publicationScope === 'route') {
    const { rows } = await client.query(`
      SELECT id
      FROM directions
      WHERE route_id = $1
      FOR UPDATE;
    `, [routeId]);
    return rows.map((row) => row.id);
  }

  const codes = directions.filter((direction) => direction.code !== null)
    .map((direction) => direction.code.toLocaleLowerCase('en-ZA'));
  const names = directions.map((direction) => direction.name);
  const { rows } = await client.query(`
    SELECT id
    FROM directions
    WHERE route_id = $1
      AND (
        lower(COALESCE(code, '')) = ANY($2::text[])
        OR direction = ANY($3::text[])
      )
    FOR UPDATE;
  `, [routeId, codes, names]);
  return rows.map((row) => row.id);
}

async function deleteDirections(client, directionIds) {
  await client.query(`
    DELETE FROM stop_times
    WHERE trip_id IN (
      SELECT id FROM trips WHERE direction_id = ANY($1::bigint[])
    );
  `, [directionIds]);
  await client.query(`
    DELETE FROM trips
    WHERE direction_id = ANY($1::bigint[]);
  `, [directionIds]);
  await client.query(`
    DELETE FROM directions
    WHERE id = ANY($1::bigint[]);
  `, [directionIds]);
}

async function createDirection(client, routeId, direction, sourceId, versionId) {
  const { rows } = await client.query(`
    INSERT INTO directions (
      direction, route_id, code, timetable_source_id, timetable_source_version_id
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id;
  `, [direction.name, routeId, direction.code, sourceId, versionId]);
  return rows[0].id;
}

async function findComposedDirection(client, routeId, direction) {
  const { rows } = await client.query(`
    SELECT id
    FROM directions
    WHERE route_id = $1
      AND (
        ($2::text IS NOT NULL AND lower(COALESCE(code, '')) = lower($2))
        OR ($2::text IS NOT NULL AND code IS NULL AND direction = $3)
        OR ($2::text IS NULL AND code IS NULL AND direction = $3)
      )
    ORDER BY id
    FOR UPDATE;
  `, [routeId, direction.code, direction.name]);
  if (!rows[0]) return null;

  const primary = rows[0];
  const duplicateIds = rows.slice(1).map((row) => row.id);
  if (duplicateIds.length > 0) {
    await client.query(`
      UPDATE trips
      SET direction_id = $1
      WHERE direction_id = ANY($2::bigint[]);
    `, [primary.id, duplicateIds]);
    await client.query(`
      DELETE FROM directions
      WHERE id = ANY($1::bigint[]);
    `, [duplicateIds]);
  }
  return primary;
}

async function reuseOrCreateComposedDirection(client, routeId, direction, existingDirection = undefined) {
  const existing = existingDirection === undefined
    ? await findComposedDirection(client, routeId, direction)
    : existingDirection;
  if (existing) {
    const { rows } = await client.query(`
      UPDATE directions
      SET direction = $1,
          code = $2,
          timetable_source_id = NULL,
          timetable_source_version_id = NULL
      WHERE id = $3
      RETURNING id;
    `, [direction.name, direction.code, existing.id]);
    return rows[0].id;
  }

  return createDirection(client, routeId, direction, null, null);
}

async function tripsForServiceFamily(client, directionId, family) {
  if (!SERVICE_FAMILY_DAYS[family]) throw new Error(`Unsupported service family ${JSON.stringify(family)}.`);
  const { rows } = await client.query(`
    SELECT id, timetable_service_family,
      monday, tuesday, wednesday, thursday, friday,
      saturday, sunday, public_holiday
    FROM trips
    WHERE direction_id = $1
      AND (
        timetable_service_family = $2
        OR (
          timetable_service_family IS NULL
          AND CASE $2::text
            WHEN 'weekday' THEN
              COALESCE(monday, FALSE) OR COALESCE(tuesday, FALSE)
              OR COALESCE(wednesday, FALSE) OR COALESCE(thursday, FALSE)
              OR COALESCE(friday, FALSE)
            WHEN 'saturday' THEN COALESCE(saturday, FALSE)
            WHEN 'sunday' THEN COALESCE(sunday, FALSE)
            WHEN 'public_holiday' THEN COALESCE(public_holiday, FALSE)
            ELSE FALSE
          END
        )
      )
    FOR UPDATE;
  `, [directionId, family]);
  return rows;
}

async function deleteTrips(client, tripIds) {
  await client.query(`
    DELETE FROM stop_times
    WHERE trip_id = ANY($1::bigint[]);
  `, [tripIds]);
  await client.query(`
    DELETE FROM trips
    WHERE id = ANY($1::bigint[]);
  `, [tripIds]);
}

async function removeServiceFamilyTrips(client, directionId, family) {
  const rows = await tripsForServiceFamily(client, directionId, family);
  const targetDays = new Set(SERVICE_FAMILY_DAYS[family]);
  const deleteIds = [];
  const trimIds = [];

  for (const row of rows) {
    if (row.timetable_service_family !== null && row.timetable_service_family !== undefined) {
      deleteIds.push(row.id);
      continue;
    }
    const hasAnotherFamily = SERVICE_DAYS.some((day) => !targetDays.has(day) && Boolean(row[day]));
    (hasAnotherFamily ? trimIds : deleteIds).push(row.id);
  }

  if (trimIds.length > 0) {
    const assignments = SERVICE_FAMILY_DAYS[family].map((day) => `${day} = FALSE`).join(', ');
    await client.query(`
      UPDATE trips
      SET ${assignments}
      WHERE id = ANY($1::bigint[])
        AND timetable_service_family IS NULL;
    `, [trimIds]);
  }
  if (deleteIds.length > 0) await deleteTrips(client, deleteIds);
  return { deleteIds, trimIds };
}

async function deleteDirectionIfEmpty(client, directionId) {
  await client.query(`
    DELETE FROM directions
    WHERE id = $1
      AND NOT EXISTS (
        SELECT 1 FROM trips WHERE direction_id = $1
      );
  `, [directionId]);
}

async function reuseOrCreateStop(client, operator, stopName, stopIds) {
  const cacheKey = `${operator}\u0000${stopName}`;
  if (stopIds.has(cacheKey)) return stopIds.get(cacheKey);

  const existingResult = await client.query(`
    SELECT id
    FROM stops
    WHERE agency = $1 AND name = $2
    ORDER BY id
    LIMIT 1
    FOR UPDATE;
  `, [operator, stopName]);
  let stopId = existingResult.rows[0]?.id;
  if (stopId === undefined) {
    const { rows } = await client.query(`
      INSERT INTO stops (name, agency)
      VALUES ($1, $2)
      RETURNING id;
    `, [stopName, operator]);
    stopId = rows[0].id;
  }
  stopIds.set(cacheKey, stopId);
  return stopId;
}

async function createTrip(client, directionId, days, provenance = {}) {
  const flags = serviceDayFlags(days);
  const { rows } = await client.query(`
    INSERT INTO trips (
      direction_id, monday, tuesday, wednesday, thursday, friday,
      saturday, sunday, public_holiday, timetable_source_id,
      timetable_source_version_id, timetable_effective_date,
      timetable_service_family, timetable_trip_ordinal, timetable_section_version_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::date, $13, $14, $15)
    RETURNING id;
  `, [
    directionId,
    flags.monday,
    flags.tuesday,
    flags.wednesday,
    flags.thursday,
    flags.friday,
    flags.saturday,
    flags.sunday,
    flags.public_holiday,
    provenance.sourceId || null,
    provenance.versionId || null,
    provenance.effectiveDate || null,
    provenance.family || null,
    provenance.tripOrdinal || null,
    provenance.sectionVersionId || null,
  ]);
  return rows[0].id;
}

async function createStopTimes(client, tripId, times, operator, stopIds) {
  const rows = [];
  for (const stopTime of times) {
    rows.push({
      sequence: stopTime.sequence,
      departure: stopTime.time,
      arrival: stopTime.time,
      stop_id: await reuseOrCreateStop(client, operator, stopTime.stop_name, stopIds),
      stop_time_type: stopTime.stop_time_type,
    });
  }

  await client.query(`
    INSERT INTO stop_times (
      sequence, departure, arrival, stop_id, trip_id, stop_time_type
    )
    SELECT
      item.sequence,
      item.departure,
      item.arrival,
      item.stop_id,
      $2,
      item.stop_time_type
    FROM jsonb_to_recordset($1::jsonb) AS item (
      sequence integer,
      departure time,
      arrival time,
      stop_id integer,
      stop_time_type text
    );
  `, [JSON.stringify(rows), tripId]);
}

async function publishRouteScopedExtraction(client, extraction, { sourceId, versionId, candidateEffectiveDate }) {
  const stopIds = new Map();
  const affectedRouteIds = [];

  for (const route of extraction.routes) {
    const effectiveDate = maxEffectiveDate([
      candidateEffectiveDate,
      extraction.effective_date,
      ...route.directions.map((direction) => direction.effective_date),
    ]);
    const routeRecord = await reuseOrCreateRoute(client, extraction.operator, route, effectiveDate);
    affectedRouteIds.push(routeRecord.id);

    const directionIds = await directionIdsForPublication(
      client,
      routeRecord.id,
      extraction.publication_scope,
      route.directions
    );
    await deleteDirections(client, directionIds);

    for (const direction of route.directions) {
      const directionId = await createDirection(client, routeRecord.id, direction, sourceId, versionId);
      let tripOrdinal = 0;
      for (const service of direction.services) {
        for (const trip of service.trips) {
          tripOrdinal += 1;
          const tripDays = footnoteServiceDays(service, trip);
          const tripId = await createTrip(client, directionId, tripDays, {
            sourceId,
            versionId,
            effectiveDate: directionEffectiveDate(direction, extraction, candidateEffectiveDate),
            tripOrdinal,
          });
          await createStopTimes(client, tripId, trip.times, extraction.operator, stopIds);
        }
      }
    }
  }

  return [...new Set(affectedRouteIds)];
}

async function recomposeGabsServiceFamilies(client, affectedContributions, winners, { preserveRouteNames = false } = {}) {
  const stopIds = new Map();
  const routeBases = new Map();

  for (const [key, affected] of affectedContributions) {
    const basis = winners.get(key) || affected;
    const routeKey = basis.route.code.toLocaleLowerCase('en-ZA');
    const current = routeBases.get(routeKey);
    if (!current || compareContributions(current, basis) < 0) routeBases.set(routeKey, basis);
  }

  const routeRecords = new Map();
  for (const [routeKey, basis] of [...routeBases.entries()].sort(([first], [second]) => first.localeCompare(second))) {
    routeRecords.set(routeKey, await reuseOrCreateRoute(
      client,
      'GABS',
      basis.route,
      basis.effectiveDate,
      { preserveName: preserveRouteNames }
    ));
  }

  for (const [key, affected] of [...affectedContributions.entries()].sort(([first], [second]) => first.localeCompare(second))) {
    const winner = winners.get(key) || null;
    const basis = winner || affected;
    const routeRecord = routeRecords.get(basis.route.code.toLocaleLowerCase('en-ZA'));
    const existingDirection = await findComposedDirection(client, routeRecord.id, basis.direction);
    if (existingDirection) {
      await removeServiceFamilyTrips(client, existingDirection.id, basis.family);
    }

    if (!winner) {
      if (existingDirection) await deleteDirectionIfEmpty(client, existingDirection.id);
      continue;
    }

    const directionId = await reuseOrCreateComposedDirection(
      client,
      routeRecord.id,
      winner.direction,
      existingDirection
    );
    for (const trip of winner.trips) {
      const tripId = await createTrip(client, directionId, trip.serviceDays, {
        sourceId: winner.sourceId,
        versionId: winner.versionId,
        effectiveDate: winner.effectiveDate,
        family: winner.family,
        tripOrdinal: trip.tripOrdinal,
        sectionVersionId: winner.sectionVersionId,
      });
      await createStopTimes(client, tripId, trip.times, 'GABS', stopIds);
    }
  }

  return [...routeRecords.values()].map((route) => route.id);
}

async function publishCanonicalExtraction(client, extraction, options) {
  if (extraction.publication_scope === 'route') {
    return publishRouteScopedExtraction(client, extraction, options);
  }
  if (extraction.publication_scope !== 'service_days') {
    throw new Error(`Unsupported publication scope ${JSON.stringify(extraction.publication_scope)}.`);
  }

  const candidateRecord = {
    sourceId: options.sourceId,
    sourceKey: extraction.source_key,
    versionId: options.versionId,
    sourceEffectiveDate: options.candidateEffectiveDate,
    extraction,
  };
  const candidateContributions = contributionsFromVersion(candidateRecord);
  const affectedContributions = new Map(candidateContributions);
  if (options.previousVersion) {
    for (const [key, contribution] of contributionsFromVersion(options.previousVersion)) {
      if (!affectedContributions.has(key)) affectedContributions.set(key, contribution);
    }
  }

  const winners = selectContributionWinners([
    ...(options.approvedVersions || []),
    candidateRecord,
  ], { notAfter: options.notAfter || null });
  return recomposeGabsServiceFamilies(client, affectedContributions, winners);
}

async function clearAffectedApiCache(client, routeIds) {
  const tableResult = await client.query('SELECT to_regclass($1) AS table_name;', ['api_response_cache']);
  if (!tableResult.rows[0]?.table_name) return 0;

  const result = await client.query(`
    DELETE FROM api_response_cache
    WHERE route_id = ANY($1::integer[])
       OR cache_key = $2;
  `, [routeIds, 'schedules:v1']);
  return result.rowCount || 0;
}

async function invalidateOpenAuditRuns(client) {
  const result = await client.query(`
    UPDATE timetable_audit_runs
    SET status = $1
    WHERE status = ANY($2::text[]);
  `, ['cancelled', ['planned', 'in_progress']]);
  return result.rowCount || 0;
}

function sourceSummary(extraction) {
  const directions = extraction.routes.flatMap((route) => route.directions);
  return {
    routeName: extraction.routes.map((route) => route.name).join(' / '),
    directionNames: directions.map((direction) => direction.name),
    serviceDayCoverage: [...new Set(directions.flatMap((direction) => (
      direction.services.flatMap((service) => service.service_days)
    )))],
  };
}

async function approvePendingVersion(database, {
  sourceId,
  versionId,
  reviewer,
  note = '',
  verifiedOn,
}, { withinTransaction = false, requireUnchanged = false } = {}) {
  assertIdentifier(sourceId, 'sourceId');
  assertIdentifier(versionId, 'versionId');
  const actor = assertNonblank(reviewer, 'reviewer');
  const approvalNote = assertNonblank(note, 'note');
  const verificationDate = canonicalIsoDate(verifiedOn, 'verifiedOn', { nullable: false });
  const today = currentCapeTownDate();
  if (verificationDate > today) {
    throw new Error(`verifiedOn ${verificationDate} cannot be after the current Cape Town date ${today}.`);
  }

  const publish = async (client) => {
    await lockPublicationTransaction(client);
    await invalidateOpenAuditRuns(client);
    const source = await lockSource(client, sourceId);
    if (source.section_mode) throw new Error("Review and publish individual timetable sections for this document.");
    if (!sameIdentifier(source.pending_version_id, versionId)) {
      throw new Error(`Version ${versionId} is not the exact pending version for source ${sourceId}.`);
    }

    const candidate = await lockVersion(client, sourceId, versionId);
    if (candidate.review_status !== 'pending') {
      throw new Error(`Version ${versionId} is ${candidate.review_status}, not pending.`);
    }
    if (requireUnchanged && !isUnchangedComparison(candidate.comparison)) {
      throw new Error(`Version ${versionId} is no longer an unchanged candidate.`);
    }

    let lockedPrevious = null;
    if (source.approved_version_id) {
      if (sameIdentifier(source.approved_version_id, versionId)) {
        throw new Error(`Pending version ${versionId} cannot also be the approved version for source ${sourceId}.`);
      }
      if (!sameIdentifier(candidate.previous_version_id, source.approved_version_id)) {
        throw new Error(
          `Version ${versionId} was not staged against approved version ${source.approved_version_id}.`
        );
      }
      lockedPrevious = await lockVersion(client, sourceId, source.approved_version_id);
      if (lockedPrevious.review_status !== 'approved') {
        throw new Error(
          `Source ${sourceId} points to version ${source.approved_version_id}, which is ${lockedPrevious.review_status}, not approved.`
        );
      }
    }

    const extraction = validateCanonicalExtraction(candidate.extraction, {
      operator: source.operator,
      sourceKey: source.source_key,
    });
    const storedEffectiveDate = databaseIsoDate(candidate.source_effective_date);
    if (storedEffectiveDate !== extraction.effective_date) {
      throw new Error(
        `Candidate source effective date ${JSON.stringify(storedEffectiveDate)} does not match canonical effective date ${JSON.stringify(extraction.effective_date)}.`
      );
    }
    assertNoFutureEffectiveDates(extraction, candidate.source_effective_date, verificationDate);

    let previousVersion = null;
    let approvedVersions = [];
    if (extraction.publication_scope === 'service_days') {
      if (lockedPrevious) previousVersion = versionContributionRecord(source, lockedPrevious);
      approvedVersions = await lockApprovedContributors(client, sourceId);
    }
    const routeIds = await publishCanonicalExtraction(client, extraction, {
      sourceId,
      versionId,
      candidateEffectiveDate: candidate.source_effective_date,
      previousVersion,
      approvedVersions,
      notAfter: verificationDate,
    });
    await clearAffectedApiCache(client, routeIds);

    if (source.approved_version_id && !sameIdentifier(source.approved_version_id, versionId)) {
      await client.query(`
        UPDATE timetable_source_versions
        SET review_status = $1
        WHERE id = $2 AND source_id = $3 AND review_status = $4;
      `, ['superseded', source.approved_version_id, sourceId, 'approved']);
    }

    await client.query(`
      UPDATE timetable_source_versions
      SET review_status = $1,
          approved_by = $2,
          approved_at = now(),
          review_note = $3,
          published_at = now()
      WHERE id = $4 AND source_id = $5;
    `, ['approved', actor, approvalNote, versionId, sourceId]);

    const summary = sourceSummary(extraction);
    const sourceEffectiveDate = maxEffectiveDate([
      candidate.source_effective_date,
      extraction.effective_date,
      ...extraction.routes.flatMap((route) => route.directions.map((direction) => direction.effective_date)),
    ]);
    await client.query(`
      UPDATE timetable_sources
      SET status = $1,
          approved_version_id = $2,
          pending_version_id = NULL,
          last_manually_verified_on = $3::date,
          current_pdf_sha256 = $4,
          current_content_sha256 = $5,
          source_effective_date = $6::date,
          parser_version = $7,
          import_version = $8,
          route_name = $9,
          direction_names = $10::text[],
          service_day_coverage = $11::text[],
          consecutive_missing_checks = 0,
          withdrawn_at = NULL,
          updated_at = now()
      WHERE id = $12;
    `, [
      'verified',
      versionId,
      verificationDate,
      candidate.pdf_sha256,
      candidate.content_sha256,
      sourceEffectiveDate,
      candidate.parser_version,
      candidate.import_version,
      summary.routeName,
      summary.directionNames,
      summary.serviceDayCoverage,
      sourceId,
    ]);

    await client.query(`
      INSERT INTO timetable_source_events (
        source_id, source_version_id, event_type, actor, details
      )
      VALUES ($1, $2, $3, $4, $5::jsonb);
    `, [
      sourceId,
      versionId,
      'source_approved',
      actor,
      JSON.stringify({
        note: approvalNote,
        verified_on: verificationDate,
        previous_version_id: source.approved_version_id || null,
        publication_scope: extraction.publication_scope,
        affected_route_ids: routeIds,
      }),
    ]);

    return {
      sourceId,
      versionId,
      previousVersionId: source.approved_version_id || null,
      publicationScope: extraction.publication_scope,
      routeIds,
    };
  };

  return withinTransaction ? publish(database) : inTransaction(database, publish);
}

async function bulkApproveUnchangedVersions(database, {
  candidates,
  reviewer,
  note = 'unchanged',
  verifiedOn,
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('At least one unchanged candidate is required.');
  }

  const normalizedCandidates = candidates.map((candidate) => {
    assertIdentifier(candidate?.sourceId, 'sourceId');
    assertIdentifier(candidate?.versionId, 'versionId');
    return {
      sourceId: Number(candidate.sourceId),
      versionId: Number(candidate.versionId),
    };
  }).sort((first, second) => first.sourceId - second.sourceId);
  const sourceIds = new Set(normalizedCandidates.map((candidate) => candidate.sourceId));
  if (sourceIds.size !== normalizedCandidates.length) {
    throw new Error('Each source can appear only once in a bulk approval.');
  }

  return inTransaction(database, async (client) => {
    const results = [];
    for (const candidate of normalizedCandidates) {
      results.push(await approvePendingVersion(client, {
        ...candidate,
        reviewer,
        note,
        verifiedOn,
      }, {
        withinTransaction: true,
        requireUnchanged: true,
      }));
    }
    return results;
  });
}

async function withdrawSource(database, { sourceId, reviewer, note }) {
  assertIdentifier(sourceId, 'sourceId');
  const actor = assertNonblank(reviewer, 'reviewer');
  const withdrawalNote = assertNonblank(note, 'note');

  return inTransaction(database, async (client) => {
    await lockPublicationTransaction(client);
    await invalidateOpenAuditRuns(client);
    const source = await lockSource(client, sourceId);
    if (source.section_mode) throw new Error("Review and publish individual timetable sections for this document.");
    if (source.status === 'withdrawn') throw new Error(`Timetable source ${sourceId} is already withdrawn.`);

    let directionIds = [];
    let routeIds = [];
    if (source.operator === 'GABS' && source.approved_version_id) {
      await lockVersion(client, sourceId, source.approved_version_id);
      const affectedContributions = await lockPublishedContributionsForSource(
        client,
        source,
        source.approved_version_id
      );
      const approvedVersions = await lockApprovedContributors(client, sourceId);
      const invalidFallbackVersionIds = [];
      const validApprovedVersions = approvedVersions.filter((version) => {
        try {
          contributionsFromVersion(version);
          return true;
        } catch {
          invalidFallbackVersionIds.push(version.versionId);
          return false;
        }
      });
      const winners = selectContributionWinners(validApprovedVersions, {
        notAfter: currentCapeTownDate(),
      });
      routeIds = await recomposeGabsServiceFamilies(client, affectedContributions, winners);
      if (invalidFallbackVersionIds.length > 0) {
        await client.query(`
          INSERT INTO timetable_source_events (
            source_id, source_version_id, event_type, actor, details
          )
          VALUES ($1, $2, $3, $4, $5::jsonb);
        `, [
          sourceId,
          source.approved_version_id,
          'withdrawal_fallback_quarantined',
          actor,
          JSON.stringify({ invalid_fallback_version_ids: invalidFallbackVersionIds }),
        ]);
      }
    } else {
      const directionResult = await client.query(`
        SELECT id, route_id
        FROM directions
        WHERE timetable_source_id = $1
        FOR UPDATE;
      `, [sourceId]);
      directionIds = directionResult.rows.map((row) => row.id);
      routeIds = [...new Set(directionResult.rows.map((row) => row.route_id))];
      await deleteDirections(client, directionIds);
    }
    await clearAffectedApiCache(client, routeIds);

    if (source.pending_version_id) {
      await client.query(`
        UPDATE timetable_source_versions
        SET review_status = $1,
            approved_by = $2,
            approved_at = now(),
            review_note = $3
        WHERE id = $4 AND source_id = $5 AND review_status = $6;
      `, ['rejected', actor, withdrawalNote, source.pending_version_id, sourceId, 'pending']);
    }

    await client.query(`
      UPDATE timetable_sources
      SET status = $1,
          approved_version_id = NULL,
          pending_version_id = NULL,
          withdrawn_at = now(),
          updated_at = now()
      WHERE id = $2;
    `, ['withdrawn', sourceId]);
    await client.query(`
      INSERT INTO timetable_source_events (
        source_id, source_version_id, event_type, actor, details
      )
      VALUES ($1, $2, $3, $4, $5::jsonb);
    `, [
      sourceId,
      source.approved_version_id || null,
      'source_withdrawn',
      actor,
      JSON.stringify({ note: withdrawalNote, affected_route_ids: routeIds }),
    ]);

    return {
      sourceId,
      withdrawnVersionId: source.approved_version_id || null,
      routeIds,
      directionIds,
    };
  });
}

module.exports = {
  contributionsFromVersion,
  recomposeGabsServiceFamilies,
  lockPublicationTransaction,
  PUBLICATION_SCOPES,
  SERVICE_DAYS,
  approvePendingVersion,
  bulkApproveUnchangedVersions,
  clearAffectedApiCache,
  currentCapeTownDate,
  deleteDirections,
  footnoteServiceDays,
  inTransaction,
  invalidateOpenAuditRuns,
  isUnchangedComparison,
  lockPublishedContributionsForSource,
  maxEffectiveDate,
  publishCanonicalExtraction,
  reuseOrCreateRoute,
  serviceDayFlags,
  validateCanonicalExtraction,
  withdrawSource,
};
