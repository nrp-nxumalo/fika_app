const { createPublicationPool } = require('../lib/databasePool');
const { ensureTimetableReliabilitySchema } = require('../lib/timetableReliabilitySchema');
const { refreshRouteCache } = require('../lib/timetableCacheRefresh');
const { schedulesQuery } = require('../lib/apiPayloads');
const { API_CACHE_PAYLOAD_KINDS } = require('../lib/apiCache');
const { inTransaction, lockPublicationTransaction } = require('../lib/timetablePublisher');

async function main(database, logger = console) {
  const startedAt = Date.now();
  await ensureTimetableReliabilitySchema(database);
  const { rows: routes } = await database.query(schedulesQuery);
  await refreshRouteCache(database, 0, logger);
  for (const route of routes) await refreshRouteCache(database, Number(route.id), logger);
  await inTransaction(database, async client => {
    await lockPublicationTransaction(client);
    await client.query(`DELETE FROM api_response_cache c WHERE NOT (payload_kind=ANY($1::text[]))
      OR (route_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM routes r WHERE r.id=c.route_id));`,
    [Object.values(API_CACHE_PAYLOAD_KINDS)]);
  }, { logger, context: { operation: 'cache_prune' } });
  logger.log(JSON.stringify({ event: 'api_cache_precomputed', routeCount: routes.length,
    payloadCount: 1 + routes.length * 2, durationMs: Date.now() - startedAt }));
}
if (require.main === module) {
  const database = createPublicationPool();
  main(database).catch(error => {
    console.error('Failed to precompute API response cache', error.message);
    process.exitCode = process.argv.includes('--soft-fail') ? 0 : 1;
  }).finally(() => database.end());
}
module.exports = { main };
