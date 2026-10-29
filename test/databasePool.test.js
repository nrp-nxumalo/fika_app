const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDatabasePool, createTimetableStatusPool } = require('../lib/databasePool');

// Exercise pg-pool's actual idle-error removal/replacement path without a
// network connection. The fake implements only the pg.Client protocol needed.
class TestClient extends EventEmitter {
  constructor() { super(); this._queryable = true; this._ending = false; }
  connect(callback) { queueMicrotask(() => callback(null)); }
  end(callback) { this._ending = true; callback?.(); }
  query(_text, _values, callback) { callback(null, { rows: [{ ok: true }] }); }
  ref() {}
  unref() {}
}

test('an idle connection failure is logged safely and pg replaces it for the next request', async () => {
  const logs = [];
  const pool = createDatabasePool({ env: {}, max: 1, Client: TestClient,
    logger: { error: value => logs.push(value) } });
  try {
    const client = await pool.connect();
    client.connectionParameters = { password: 'must-not-appear', host: 'private-host' };
    client.release();
    client.emit('error', new Error('Connection terminated unexpectedly'));
    assert.equal(pool.totalCount, 0);
    assert.equal(client._ending, true);
    assert.equal(logs.length, 1);
    assert.equal(JSON.parse(logs[0]).event, 'database_pool_error');
    assert.equal(JSON.parse(logs[0]).totalCount, 0);
    assert.doesNotMatch(logs[0], /must-not-appear|private-host|connectionParameters/);
    assert.deepEqual((await pool.query('SELECT 1')).rows, [{ ok: true }]);
    assert.equal(pool.totalCount, 1);
  } finally { await pool.end(); }
});

test('a busy status connection does not consume the timetable pool', async () => {
  const main = createDatabasePool({ env: { NODE_ENV: 'production' }, Client: TestClient });
  const status = createTimetableStatusPool({ env: { PG_POOL_MAX: '20' }, Client: TestClient });
  let held;
  try {
    held = await status.connect();
    assert.equal(status.options.max, 1);
    assert.equal(main.options.max, 5);
    assert.equal(status.options.statement_timeout, 5000);
    assert.ok(status.options.query_timeout > status.options.statement_timeout);
    assert.equal(status.options.keepAlive, true);
    assert.deepEqual((await main.query('SELECT 1')).rows, [{ ok: true }]);
  } finally {
    held?.release();
    await Promise.all([main.end(), status.end()]);
  }
});

test('publishing and review work cannot occupy public timetable connections', async () => {
  const { createTimetableAdminPool, createPublicationPool } = require('../lib/databasePool');
  const main=createDatabasePool({env:{NODE_ENV:'production'},Client:TestClient,max:1});
  const admin=createTimetableAdminPool({env:{},Client:TestClient});
  const worker=createPublicationPool({env:{},Client:TestClient});
  const held=[];
  try {
    held.push(await admin.connect(),await admin.connect(),await worker.connect());
    assert.equal(admin.options.max,2);assert.equal(worker.options.max,1);
    assert.deepEqual((await main.query('SELECT 1')).rows,[{ok:true}]);
    assert.equal(main.waitingCount,0);
  }finally{held.forEach(client=>client.release());await Promise.all([main.end(),admin.end(),worker.end()]);}
});
