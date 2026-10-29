const test = require('node:test');
const assert = require('node:assert/strict');

const { main } = require('../scripts/precompute-api-cache');

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

class RecordingClient {
  constructor(events, { failOn } = {}) {
    this.events = events;
    this.failOn = failOn;
  }

  async query(sql, params = []) {
    const text = compactSql(sql);
    this.events.push({ type: 'query', text, params });

    if (this.failOn?.test(text)) {
      throw new Error('injected cache write failure');
    }

    if (text.includes('fika_schema_versions')) return { rows: [{ version: 1 }] };
    if (text.startsWith('SELECT id FROM routes')) return { rows: [{ id: 42 }] };
    if (text.startsWith('SELECT routes.id')) {
      return {
        rows: [{
          id: 42,
          name: 'Test route',
          code: 'T42',
          agency: 'Test operator',
          effective_date: '2026-08-17',
          direction_1: 'Outbound',
          direction_2: 'Inbound',
        }],
        rowCount: 1,
      };
    }

    if (text.startsWith('WITH route_stop_times AS')) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  }

  release() {
    this.events.push({ type: 'release' });
  }
}

class RecordingPool {
  constructor(options = {}) {
    this.events = [];
    this.client = new RecordingClient(this.events, options);
  }

  async connect() {
    this.events.push({ type: 'connect' });
    return this.client;
  }

  async query(sql, params) { return this.client.query(sql, params); }
}

const silentLogger = { log() {} };

function queryIndex(events, predicate) {
  return events.findIndex((event) => event.type === 'query' && predicate(event));
}

test('cache precomputation locks each route independently and commits payloads before proceeding', async () => {
  const database = new RecordingPool();

  await main(database, silentLogger);

  const { events } = database;
  const beginIndex = queryIndex(events, ({ text }) => text === 'BEGIN');
  const lockIndex = queryIndex(events, ({ text, params }) => (
    /pg_advisory_xact_lock\(hashtext\(\$1\)\)/.test(text)
      && params[0] === 'fika:timetable-publication'
  ));
  const timetableReadIndexes = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'query'
      && (event.text.startsWith('SELECT routes.id')
        || event.text.startsWith('WITH route_stop_times AS')))
    .map(({ index }) => index);
  const cacheWriteIndexes = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'query'
      && /^INSERT INTO api_response_cache/.test(event.text))
    .map(({ index }) => index);
  const commitIndex = events.findLastIndex(event => event.type === 'query' && event.text === 'COMMIT');
  const releaseIndex = events.findLastIndex(event => event.type === 'release');
  assert.equal(events.filter(event => event.type === 'query' && event.text === 'COMMIT').length, 3);

  assert.ok(events.some(event => event.type === 'connect'));
  assert.ok(beginIndex > -1);
  assert.ok(lockIndex > beginIndex);
  assert.equal(timetableReadIndexes.length, 3);
  assert.equal(cacheWriteIndexes.length, 3);
  assert.ok(timetableReadIndexes.slice(1).every((index) => lockIndex < index));
  assert.ok(cacheWriteIndexes.every((index) => lockIndex < index));
  assert.ok(commitIndex > Math.max(...timetableReadIndexes, ...cacheWriteIndexes));
  assert.ok(releaseIndex > commitIndex);
  assert.equal(events.some((event) => event.type === 'query' && event.text === 'ROLLBACK'), false);
});

test('cache precomputation rolls back and releases its client when a cache write fails', async () => {
  const database = new RecordingPool({ failOn: /^INSERT INTO api_response_cache/ });

  await assert.rejects(main(database, silentLogger), /injected cache write failure/);

  const { events } = database;
  const failedWriteIndex = queryIndex(events, ({ text }) => /^INSERT INTO api_response_cache/.test(text));
  const rollbackIndex = queryIndex(events, ({ text }) => text === 'ROLLBACK');
  const releaseIndex = events.findIndex((event) => event.type === 'release');

  assert.ok(failedWriteIndex > -1);
  assert.ok(rollbackIndex > failedWriteIndex);
  assert.ok(releaseIndex > rollbackIndex);
  assert.equal(events.some((event) => event.type === 'query' && event.text === 'COMMIT'), false);
});
