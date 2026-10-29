const { createPublicationPool } = require('../lib/databasePool');
const { TIMETABLE_RELIABILITY_SCHEMA_SQL } = require('../lib/timetableReliabilitySchema');
const { ensureRouteUrlAliasSchema } = require('../lib/routeUrlAliases');

async function migrate(database) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    // Fail deployment instead of joining a long lock queue on the live site.
    await client.query("SET LOCAL lock_timeout='3s'");
    await client.query(TIMETABLE_RELIABILITY_SCHEMA_SQL);
    await ensureRouteUrlAliasSchema(client);
    // Repair historical cache misses without a full blocking startup rebuild.
    await client.query(`INSERT INTO timetable_cache_refreshes(route_id)
      SELECT 0 UNION SELECT id FROM routes r WHERE NOT EXISTS (
        SELECT 1 FROM api_response_cache c WHERE c.cache_key='schedule-times:v1:direction-codes:'||r.id)
        OR NOT EXISTS (SELECT 1 FROM api_response_cache c WHERE c.cache_key='schedule-times:v2:direction-codes:'||r.id)
      ON CONFLICT(route_id) DO NOTHING;`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
if (require.main === module) {
  const database = createPublicationPool();
  migrate(database).then(() => console.log('Timetable schema is ready.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => database.end());
}
module.exports = { migrate };
