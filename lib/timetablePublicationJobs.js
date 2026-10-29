const { createHash } = require('node:crypto');
const { stableJson, approveSection, withdrawSection } = require('./timetableSectionPublisher');
const { changeTimetable } = require('./gabsTimetableWorkflow');
const { inTransaction, approvePendingVersion, bulkApproveUnchangedVersions,
  withdrawSource, currentCapeTownDate } = require('./timetablePublisher');
const ACTIONS = new Set(['timetable','section_approve','section_withdraw','source_approve','source_withdraw','bulk_approve']);
const WORKER_LOCK = 'fika:manual-publication-worker';
const RETRY_CODES = new Set(['55P03','57014','40001','40P01']);

async function enqueuePublication(database, action, payload, returnUrl) {
  if (!ACTIONS.has(action)) throw new Error('Unknown publication action.');
  if (!payload.reviewer?.trim() || !payload.note?.trim()) throw new Error('Reviewer and review note are required.');
  const requestKey = createHash('sha256').update(stableJson({ action, payload })).digest('hex');
  const { rows } = await database.query(`INSERT INTO timetable_publication_jobs(request_key,action,payload,return_url)
    VALUES ($1,$2,$3::jsonb,$4) ON CONFLICT(request_key) DO UPDATE SET
      status=CASE WHEN timetable_publication_jobs.status='failed' THEN 'queued' ELSE timetable_publication_jobs.status END,
      attempts=CASE WHEN timetable_publication_jobs.status='failed' THEN 0 ELSE timetable_publication_jobs.attempts END,
      available_at=CASE WHEN timetable_publication_jobs.status='failed' THEN now() ELSE timetable_publication_jobs.available_at END
    RETURNING id,status;`, [requestKey, action, JSON.stringify(payload), returnUrl]);
  return rows[0];
}

async function executePublication(database, job) {
  const options = { ...job.payload, verifiedOn: currentCapeTownDate() };
  switch (job.action) {
    case 'timetable': return changeTimetable(database, options);
    case 'section_approve': return approveSection(database, options);
    case 'section_withdraw': return withdrawSection(database, options);
    case 'source_approve': return approvePendingVersion(database, options);
    case 'source_withdraw': return withdrawSource(database, options);
    case 'bulk_approve': return bulkApproveUnchangedVersions(database, options);
    default: throw new Error('Unknown publication action.');
  }
}

async function runNextPublication(database, { logger = console, execute = executePublication } = {}) {
  const client = await database.connect();
  let locked = false;
  let discard;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS locked;', [WORKER_LOCK])).rows[0].locked;
    if (!locked) return false;
    // Only the session owning WORKER_LOCK may claim or recover running jobs.
    // If its process dies, PostgreSQL rolls back publication and releases the
    // session lock. The next worker can safely resume the persisted job.
    const { rows } = await client.query(`UPDATE timetable_publication_jobs SET status='running',
      attempts=attempts+1,started_at=now(),finished_at=NULL,error=NULL
      WHERE id=(SELECT id FROM timetable_publication_jobs WHERE
        status='running' OR (status='queued' AND available_at<=now())
        ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END,id LIMIT 1)
      RETURNING *;`);
    if (!rows.length) return false;
    const job = rows[0];
    logger.log(JSON.stringify({ event: 'publication_job_started', jobId: job.id, action: job.action,
      attempt: job.attempts, queueWaitMs: Date.now() - new Date(job.created_at).getTime() }));
    try {
      if (job.attempts > 3) throw new Error('Publishing was repeatedly interrupted. Reload the review page and try again.');
      await inTransaction(client, async transaction => {
        const result = await execute(transaction, job);
        await transaction.query(`UPDATE timetable_publication_jobs SET status='succeeded',
          finished_at=now(),result=$2::jsonb,error=NULL WHERE id=$1;`, [job.id, JSON.stringify(result)]);
      }, { logger, context: { jobId: job.id, operation: job.action } });
      logger.log(JSON.stringify({ event: 'publication_job_finished', jobId: job.id, status: 'succeeded' }));
    } catch (error) {
      const retry = RETRY_CODES.has(error.code) && job.attempts < 3;
      const message = error.code
        ? 'Publishing could not complete. Reload the review page and try again.'
        : String(error.message).slice(0, 1000);
      await client.query(`UPDATE timetable_publication_jobs SET status=$2,error=$3,
        finished_at=CASE WHEN $2='failed' THEN now() END,available_at=now()+interval '10 seconds'
        WHERE id=$1 AND status<>'succeeded';`, [job.id, retry ? 'queued' : 'failed', message]);
      logger.error(JSON.stringify({ event: 'publication_job_finished', jobId: job.id,
        status: retry ? 'queued' : 'failed', code: error.code || null }));
    }
    return true;
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext($1));', [WORKER_LOCK]); }
      catch (error) { discard = error; }
    }
    client.release(discard);
  }
}
module.exports = { enqueuePublication, executePublication, runNextPublication };
