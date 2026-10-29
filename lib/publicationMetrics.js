const { performance } = require('node:perf_hooks');
const transactionClients = new WeakSet();
const phases = new WeakMap();
function publicationPhase(client, name) {
  const current = phases.get(client);
  if (!current) return;
  const now = performance.now();
  if (current.name) current.metrics[current.name] = (current.metrics[current.name] || 0) + now - current.started;
  current.name = name;
  current.started = now;
}
const diagnosticLogger = { log: message => console.error(message) };

async function publicationTransaction(database, operation, { logger = diagnosticLogger, context = {} } = {}) {
  if (transactionClients.has(database)) return operation(database);
  const started = performance.now();
  const client = typeof database.connect === 'function' && typeof database.release !== 'function' ? await database.connect() : database;
  const metrics = { event: 'publication_transaction', ...context,
    connectionWaitMs: performance.now() - started, queryCount: 0, queryMs: 0, lockWaitMs: 0, writeMs: 0, commitMs: 0 };
  const scoped = { async query(sql, params) {
    const before = performance.now();
    try { return await client.query(sql, params); }
    finally {
      const elapsed = performance.now() - before;
      metrics.queryCount++;
      metrics.queryMs += elapsed;
      if (/pg_advisory_xact_lock/.test(sql)) metrics.lockWaitMs += elapsed;
      if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) metrics.writeMs += elapsed;
      if (/^COMMIT$/i.test(sql)) metrics.commitMs += elapsed;
    }
  } };
  transactionClients.add(scoped);
  phases.set(scoped, { metrics, name: null, started: performance.now() });
  try {
    await scoped.query('BEGIN');
    // Bound lock contention independently of publication work. A worker can retry.
    await scoped.query("SET LOCAL lock_timeout='3s'");
    await scoped.query("SET LOCAL jit=off");
    await scoped.query("SET LOCAL statement_timeout='60s'");
    const result = await operation(scoped);
    publicationPhase(scoped, null);
    await scoped.query('COMMIT');
    metrics.outcome = 'committed';
    return result;
  } catch (error) {
    publicationPhase(scoped, null);
    metrics.outcome = 'rolled_back';
    metrics.code = error.code || null;
    try { await scoped.query('ROLLBACK'); } catch { /* Keep the original error. */ }
    throw error;
  } finally {
    transactionClients.delete(scoped);
    phases.delete(scoped);
    if (client !== database) client.release();
    metrics.durationMs = performance.now() - started;
    metrics.applicationMs = Math.max(0, metrics.durationMs - metrics.connectionWaitMs - metrics.queryMs);
    for (const key of Object.keys(metrics)) if (key.endsWith('Ms')) metrics[key] = Math.round(metrics[key]);
    logger.log(JSON.stringify(metrics));
  }
}

module.exports = { publicationTransaction, publicationPhase };
