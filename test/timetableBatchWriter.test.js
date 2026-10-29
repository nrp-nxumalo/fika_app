const test = require('node:test');
const assert = require('node:assert/strict');
const { createTripsWithStopTimes } = require('../lib/timetableBatchWriter');

function recordingDatabase() {
  const trips = [], times = [], calls = [];
  return { trips, times, calls, async query(sql, params) {
    calls.push(sql);
    if (/SELECT id, name FROM stops/.test(sql)) return { rows: [{ id: 10, name: 'A' },{ id: 11, name: 'B' }] };
    if (/INSERT INTO trips/.test(sql)) {
      const records = JSON.parse(params[0]);
      trips.push(...records);
      return { rows: records.map(record => ({ id: 1000+record.ordinal, timetable_trip_ordinal: record.ordinal })).reverse() };
    }
    if (/INSERT INTO stop_times/.test(sql)) { times.push(...JSON.parse(params[0])); return { rows: [] }; }
    throw Error('Unexpected batch query');
  } };
}

test('large timetables use bounded batches and map stop times using ordinals, regardless of RETURNING order', async () => {
  const db = recordingDatabase();
  const trips = Array.from({ length: 401 }, (_,i) => ({ tripOrdinal: i+1, serviceDays: ['saturday'],
    times: [{ stop_name: 'A', sequence: 0, time: `${String(i%24).padStart(2,'0')}:05`, stop_time_type: 'scheduled' },
      { stop_name: 'B', sequence: 1, time: null, stop_time_type: i%2 ? 'via' : 'not_served' }] }));
  await createTripsWithStopTimes(db, 1, trips, 'GABS', new Map(), { sourceId: 2, versionId: 3, family: 'saturday' });
  assert.equal(db.calls.length, 7); // One stop lookup, three trip and three time batches.
  assert.equal(db.trips.length, 401);
  assert.equal(db.times.length, 802);
  for (let i=0;i<401;i++) {
    assert.equal(db.times[i*2].trip_id,1001+i);
    assert.equal(db.times[i*2].departure,trips[i].times[0].time);
    assert.equal(db.times[i*2+1].departure,null);
    assert.equal(db.times[i*2+1].stop_time_type,trips[i].times[1].stop_time_type);
    assert.equal(db.trips[i].saturday,true);
    assert.equal(db.trips[i].monday,false);
  }
});

test('incomplete trip ID mappings fail publication instead of attaching times to the wrong trip', async () => {
  const db=recordingDatabase();
  const query=db.query.bind(db);
  db.query=(sql,params)=>/INSERT INTO trips/.test(sql) ? { rows: [] } : query(sql,params);
  await assert.rejects(createTripsWithStopTimes(db,1,[{ tripOrdinal: 1, serviceDays: ['monday'],
    times:[{ stop_name:'A',sequence:0,time:'06:00',stop_time_type:'scheduled' }] }],'GABS',new Map(),{}),/trip ordinals/);
  assert.equal(db.times.length,0);
});
