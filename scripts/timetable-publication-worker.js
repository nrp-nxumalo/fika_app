const { createPublicationPool } = require('../lib/databasePool');
const { ensureTimetableReliabilitySchema } = require('../lib/timetableReliabilitySchema');
const { runNextPublication } = require('../lib/timetablePublicationJobs');
const { refreshNextCache } = require('../lib/timetableCacheRefresh');

async function main() {
  const database = createPublicationPool();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    await ensureTimetableReliabilitySchema(database);
    do {
      try {
        const published = await runNextPublication(database);
        const refreshed = await refreshNextCache(database);
        if (process.argv.includes('--once')) break;
        if (!published && !refreshed) await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        console.error(JSON.stringify({ event: 'publication_worker_unavailable', code: error.code || null }));
        if (process.argv.includes('--once')) throw error;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    } while (!stopping);
  } finally { await database.end(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
