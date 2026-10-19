const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createDatabasePool, createTimetableStatusPool } = require('../lib/databasePool');

const options = () => ({ env: {}, database: process.env.FIKA_STATUS_TEST_DATABASE,
  host: process.env.FIKA_STATUS_TEST_HOST || '/tmp', user: process.env.USER,
  logger: { error() {} } });

test('PostgreSQL idle disconnects recover without restarting the application', {
  skip: !process.env.FIKA_STATUS_TEST_DATABASE, timeout: 10_000,
}, async () => {
  const pool = createDatabasePool({ ...options(), max: 1 });
  const control = createDatabasePool({ ...options(), max: 1 });
  try {
    const { rows: [{ pid }] } = await pool.query('SELECT pg_backend_pid() AS pid');
    const disconnected = once(pool, 'error');
    // Only terminate this test's own idle connection, never another session.
    await control.query('SELECT pg_terminate_backend($1)', [pid]);
    await disconnected;
    const result = await pool.query('SELECT pg_backend_pid() AS pid');
    assert.notEqual(result.rows[0].pid, pid);
  } finally { await Promise.all([pool.end(), control.end()]); }
});

test('status SQL is cancelled in PostgreSQL while ordinary timetable queries remain available', {
  skip: !process.env.FIKA_STATUS_TEST_DATABASE, timeout: 15_000,
}, async () => {
  const main = createDatabasePool({ ...options(), max: 1 });
  const status = createTimetableStatusPool(options());
  try {
    let settled = false;
    const slow = status.query('SELECT pg_sleep(10)').then(
      () => { settled = true; return null; },
      error => { settled = true; return error; },
    );
    assert.equal((await main.query('SELECT 42 AS answer')).rows[0].answer, 42);
    assert.equal(settled, false);
    const error = await slow;
    assert.equal(error?.code, '57014'); // Server cancellation, not just a JS timeout.
    assert.match(error.message, /statement timeout/);
    assert.equal((await status.query('SELECT 1 AS ok')).rows[0].ok, 1);
  } finally { await Promise.all([main.end(), status.end()]); }
});
