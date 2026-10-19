const { createDatabasePool } = require('../lib/databasePool');
const {
  API_CACHE_PAYLOAD_KINDS,
  API_RESPONSE_CACHE_INDEX_SQL,
  API_RESPONSE_CACHE_TABLE_SQL,
  createApiPayloadRecord,
  getApiCacheKey,
} = require('../lib/apiCache');
const {
  buildNormalizedTimetablePayload,
  scheduleTimesQuery,
  schedulesQuery,
} = require('../lib/apiPayloads');

const SOFT_FAIL = process.argv.includes('--soft-fail');
const pool = createDatabasePool({ application_name: 'fika-api-precompute' });

async function ensureApiResponseCacheTable(database = pool) {
  await database.query(API_RESPONSE_CACHE_TABLE_SQL);
  await database.query(API_RESPONSE_CACHE_INDEX_SQL);
}

async function upsertPayloadRecord(record, database = pool) {
  await database.query(`
    INSERT INTO api_response_cache (
      cache_key,
      payload_kind,
      route_id,
      etag,
      payload_text,
      payload_gzip,
      payload_br,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, now())
    ON CONFLICT (cache_key) DO UPDATE SET
      payload_kind = EXCLUDED.payload_kind,
      route_id = EXCLUDED.route_id,
      etag = EXCLUDED.etag,
      payload_text = EXCLUDED.payload_text,
      payload_gzip = EXCLUDED.payload_gzip,
      payload_br = EXCLUDED.payload_br,
      updated_at = now();
  `, [
    record.cache_key,
    record.payload_kind,
    record.route_id,
    record.etag,
    record.payload_text,
    record.payload_gzip,
    record.payload_br,
  ]);
}

async function getSchedulesPayload(database = pool) {
  const { rows } = await database.query(schedulesQuery);

  return rows;
}

async function getRouteTimetablePayload(routeId, database = pool) {
  const { rows } = await database.query(scheduleTimesQuery, [routeId]);

  return rows;
}

async function pruneStaleCacheEntries(activeCacheKeys, database = pool) {
  await database.query(`
    DELETE FROM api_response_cache
    WHERE payload_kind = ANY($1::text[])
      AND NOT (cache_key = ANY($2::text[]));
  `, [
    Object.values(API_CACHE_PAYLOAD_KINDS),
    activeCacheKeys,
  ]);
}

async function analyzeTables(database = pool) {
  const tables = [
    'routes',
    'directions',
    'trips',
    'stop_times',
    'stops',
    'api_response_cache',
  ];

  for (const table of tables) {
    await database.query(`ANALYZE ${table};`);
  }
}

async function main(database = pool, logger = console) {
  const startedAt = Date.now();
  const activeCacheKeys = [];
  const client = typeof database.connect === 'function' ? await database.connect() : database;
  const release = client !== database && typeof client.release === 'function'
    ? () => client.release()
    : () => {};

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', ['fika:timetable-publication']);
    await ensureApiResponseCacheTable(client);

    const schedules = await getSchedulesPayload(client);
    const schedulesRecord = createApiPayloadRecord({
      cacheKey: getApiCacheKey(API_CACHE_PAYLOAD_KINDS.schedulesV1),
      payloadKind: API_CACHE_PAYLOAD_KINDS.schedulesV1,
      payload: schedules,
    });

    await upsertPayloadRecord(schedulesRecord, client);
    activeCacheKeys.push(schedulesRecord.cache_key);

    for (const route of schedules) {
      const routeId = Number(route.id);
      const legacyPayload = await getRouteTimetablePayload(routeId, client);
      const legacyRecord = createApiPayloadRecord({
        cacheKey: getApiCacheKey(API_CACHE_PAYLOAD_KINDS.scheduleTimesV1, routeId),
        payloadKind: API_CACHE_PAYLOAD_KINDS.scheduleTimesV1,
        routeId,
        payload: legacyPayload,
      });
      const normalizedRecord = createApiPayloadRecord({
        cacheKey: getApiCacheKey(API_CACHE_PAYLOAD_KINDS.scheduleTimesV2, routeId),
        payloadKind: API_CACHE_PAYLOAD_KINDS.scheduleTimesV2,
        routeId,
        payload: buildNormalizedTimetablePayload(routeId, legacyPayload),
      });

      await upsertPayloadRecord(legacyRecord, client);
      await upsertPayloadRecord(normalizedRecord, client);
      activeCacheKeys.push(legacyRecord.cache_key, normalizedRecord.cache_key);
    }

    await pruneStaleCacheEntries(activeCacheKeys, client);
    await analyzeTables(client);
    await client.query('COMMIT');

    logger.log(JSON.stringify({
      event: 'api_cache_precomputed',
      routeCount: schedules.length,
      payloadCount: activeCacheKeys.length,
      durationMs: Date.now() - startedAt,
    }));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    release();
  }
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error('Failed to precompute API response cache', error);
      process.exitCode = SOFT_FAIL ? 0 : 1;
    })
    .finally(async () => {
      await pool.end();
    });
}

module.exports = {
  main,
};
