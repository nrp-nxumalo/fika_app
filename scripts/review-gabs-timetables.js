const { Pool } = require('pg');
const { ensureTimetableReliabilitySchema } = require('../lib/timetableReliabilitySchema');
const { rebuildReviewSummaries, runAutomaticReviews } = require('../lib/gabsTimetableWorkflow');

async function main() {
  const args = process.argv.slice(2);
  const runArg = args.find(arg => arg.startsWith('--run-id='));
  const publish = args.includes('--publish');
  const recordOnly = args.includes('--record-only');
  const dryRun = !publish && !recordOnly;
  if (publish && (recordOnly || args.includes('--dry-run'))) throw new Error('Choose one review mode.');
  if (publish && process.env.GABS_AUTO_APPROVE !== '1') throw new Error('Set GABS_AUTO_APPROVE=1 to enable automatic publishing.');
  if (!args.includes('--rebuild') && !runArg) throw new Error('Use --rebuild or --run-id=<check ID> [--dry-run|--publish].');
  const database = new Pool(process.env.FIKA_GABS_DATABASE_CONFIG
    ? JSON.parse(process.env.FIKA_GABS_DATABASE_CONFIG) : { connectionString: process.env.DATABASE_URL });
  try {
    let rebuilt = 0;
    if (!dryRun || args.includes('--rebuild')) {
      await ensureTimetableReliabilitySchema(database);
      rebuilt = await rebuildReviewSummaries(database);
    }
    const result = runArg ? await runAutomaticReviews(database, { runId: runArg.slice(9), dryRun, recordOnly }) : { rebuilt };
    console.log(JSON.stringify(result));
    if (result.failed) process.exitCode = 1;
  } finally { await database.end(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
