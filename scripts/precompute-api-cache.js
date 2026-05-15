const { Pool } = require('pg');
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

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SOFT_FAIL = process.argv.includes('--soft-fail');
const PG_POOL_MAX = Number(process.env.PG_POOL_MAX) || (IS_PRODUCTION ? 5 : 10);

const localPoolConfig = {
  user: 'njabulonxumalo',
  host: 'localhost',
  database: 'fika',
  port: 5432,
};

const pool = new Pool(process.env.DATABASE_URL ? {
  connectionString: process.env.DATABASE_URL,
  ssl: IS_PRODUCTION ? { rejectUnauthorized: false } : undefined,
  max: PG_POOL_MAX,
  idleTimeoutMillis: 30 * 1000,
  connectionTimeoutMillis: 5 * 1000,
} : {
  ...localPoolConfig,
  max: PG_POOL_MAX,
  idleTimeoutMillis: 30 * 1000,
  connectionTimeoutMillis: 5 * 1000,
});

async function ensureApiResponseCacheTable() {
  await pool.query(API_RESPONSE_CACHE_TABLE_SQL);
  await pool.query(API_RESPONSE_CACHE_INDEX_SQL);
}

async function upsertPayloadRecord(record) {
  await pool.query(`
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

async function getSchedulesPayload() {
  const { rows } = await pool.query(schedulesQuery);

  return rows;
}

async function getRouteTimetablePayload(routeId) {
  const { rows } = await pool.query(scheduleTimesQuery, [routeId]);

  return rows;
}

async function pruneStaleCacheEntries(activeCacheKeys) {
  await pool.query(`
    DELETE FROM api_response_cache
    WHERE payload_kind = ANY($1::text[])
      AND NOT (cache_key = ANY($2::text[]));
  `, [
    Object.values(API_CACHE_PAYLOAD_KINDS),
    activeCacheKeys,
  ]);
}

async function analyzeTables() {
  const tables = [
    'routes',
    'directions',
    'trips',
    'stop_times',
    'stops',
    'api_response_cache',
  ];

  for (const table of tables) {
    await pool.query(`ANALYZE ${table};`);
  }
}

async function main() {
  const startedAt = Date.now();
  const activeCacheKeys = [];

  await ensureApiResponseCacheTable();

  const schedules = await getSchedulesPayload();
  const schedulesRecord = createApiPayloadRecord({
    cacheKey: getApiCacheKey(API_CACHE_PAYLOAD_KINDS.schedulesV1),
    payloadKind: API_CACHE_PAYLOAD_KINDS.schedulesV1,
    payload: schedules,
  });

  await upsertPayloadRecord(schedulesRecord);
  activeCacheKeys.push(schedulesRecord.cache_key);

  for (const route of schedules) {
    const routeId = Number(route.id);
    const legacyPayload = await getRouteTimetablePayload(routeId);
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

    await upsertPayloadRecord(legacyRecord);
    await upsertPayloadRecord(normalizedRecord);
    activeCacheKeys.push(legacyRecord.cache_key, normalizedRecord.cache_key);
  }

  await pruneStaleCacheEntries(activeCacheKeys);
  await analyzeTables();

  console.log(JSON.stringify({
    event: 'api_cache_precomputed',
    routeCount: schedules.length,
    payloadCount: activeCacheKeys.length,
    durationMs: Date.now() - startedAt,
  }));
}

main()
  .catch((error) => {
    console.error('Failed to precompute API response cache', error);
    process.exitCode = SOFT_FAIL ? 0 : 1;
  })
  .finally(async () => {
    await pool.end();
  });
