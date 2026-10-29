const { promisify } = require('node:util');
const zlib = require('node:zlib');
const { API_CACHE_PAYLOAD_KINDS: KINDS, createEtag, getApiCacheKey } = require('./apiCache');
const { schedulesQuery, scheduleTimesQuery, buildNormalizedTimetablePayload } = require('./apiPayloads');
const { inTransaction, lockPublicationTransaction } = require('./timetablePublisher');
const gzip = promisify(zlib.gzip);
const brotli = promisify(zlib.brotliCompress);

async function storePayload(client, kind, routeId, payload) {
  const text = JSON.stringify(payload);
  const [gz, br] = await Promise.all([gzip(text, { level: 6 }), brotli(text, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 },
  })]);
  await client.query(`INSERT INTO api_response_cache
    (cache_key,payload_kind,route_id,etag,payload_text,payload_gzip,payload_br,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,now()) ON CONFLICT(cache_key) DO UPDATE SET
    payload_kind=EXCLUDED.payload_kind,route_id=EXCLUDED.route_id,etag=EXCLUDED.etag,
    payload_text=EXCLUDED.payload_text,payload_gzip=EXCLUDED.payload_gzip,
    payload_br=EXCLUDED.payload_br,updated_at=now();`,
  [getApiCacheKey(kind, routeId), kind, routeId, createEtag(text), text, gz, br]);
}

async function refreshRouteCache(database, routeId, logger = console) {
  // Take the SAME lock as all publication paths before reading. Cache writes
  // and removal of the outbox item commit together; a newer invalidation cannot
  // be lost or overwritten by an older rebuild. Scope the lock to one route.
  return inTransaction(database, async client => {
    await lockPublicationTransaction(client);
    if (routeId === 0) {
      await storePayload(client, KINDS.schedulesV1, null, (await client.query(schedulesQuery)).rows);
    } else {
      const payload = (await client.query(scheduleTimesQuery, [routeId])).rows;
      const exists = await client.query('SELECT id FROM routes WHERE id=$1;', [routeId]);
      if (exists.rows.length) {
        await storePayload(client, KINDS.scheduleTimesV1, routeId, payload);
        await storePayload(client, KINDS.scheduleTimesV2, routeId, buildNormalizedTimetablePayload(routeId, payload));
      } else {
        await client.query('DELETE FROM api_response_cache WHERE route_id=$1;', [routeId]);
      }
    }
    await client.query('DELETE FROM timetable_cache_refreshes WHERE route_id=$1;', [routeId]);
  }, { logger, context: { operation: 'cache_refresh', routeId } });
}

async function refreshNextCache(database, logger = console) {
  const { rows } = await database.query(`SELECT route_id FROM timetable_cache_refreshes
    WHERE available_at<=now() ORDER BY requested_at,route_id LIMIT 1;`);
  if (!rows.length) return false;
  const routeId = rows[0].route_id;
  try { await refreshRouteCache(database, routeId, logger); }
  catch (error) {
    // Keep the durable invalidation, and avoid a failing route starving others.
    await database.query(`UPDATE timetable_cache_refreshes SET attempts=attempts+1,
      available_at=now()+interval '30 seconds' WHERE route_id=$1;`, [routeId]);
    logger.error(JSON.stringify({ event: 'timetable_cache_refresh_failed', routeId, code: error.code || null }));
  }
  return true;
}
module.exports = { storePayload, refreshRouteCache, refreshNextCache };
