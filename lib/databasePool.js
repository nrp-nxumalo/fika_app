const { Pool } = require('pg');

function createDatabasePool({ env = process.env, logger = console, ...overrides } = {}) {
  const production = env.NODE_ENV === 'production';
  const pool = new Pool({
    ...(env.DATABASE_URL ? {
      connectionString: env.DATABASE_URL,
      ssl: production ? { rejectUnauthorized: false } : undefined,
    } : {
      user: 'njabulonxumalo', host: 'localhost', database: 'fika', port: 5432,
    }),
    max: Number(env.PG_POOL_MAX) || (production ? 5 : 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    application_name: 'fika-web',
    ...overrides,
  });

  // pg has already discarded this idle client. Handling the pool event lets
  // subsequent requests reconnect instead of terminating the entire server.
  pool.on('error', (error) => {
    // The pg error carries a client object with connection details. Log only
    // diagnostics, never the client or the complete error object.
    logger.error(JSON.stringify({
      event: 'database_pool_error',
      pool: pool.options.application_name,
      message: error.message,
      code: error.code || null,
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    }));
  });
  return pool;
}

function createTimetableStatusPool(options = {}) {
  return createDatabasePool({
    ...options,
    // Optional notices cannot consume the connections serving timetables or
    // hold a database worker indefinitely. pool.query discards failed clients.
    max: 1,
    application_name: 'fika-timetable-status',
    statement_timeout: 5_000,
    query_timeout: 7_000,
    // Nested JSON expansions have inflated planner estimates. Compiling them
    // is counterproductive for this small, latency-sensitive status response.
    options: '-c jit=off',
  });
}

module.exports = { createDatabasePool, createTimetableStatusPool };
