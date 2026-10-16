const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNormalizedTimetablePayload } = require('../lib/apiPayloads');

test('timetable payload preserves direction codes and their leading zeros', () => {
  const rows = ['01', '03'].map((code, index) => ({
    directions_id: index + 1, direction_code: code, direction_name: `Branch ${index + 1} - Bellville`,
    name: 'Atlantis', sequence: 0, stop_times: [{ trip_id: index + 1, arrival: '07:00:00', monday: true }],
  }));
  const payload = buildNormalizedTimetablePayload(105, rows);
  assert.deepEqual(payload.directions.map(({ id, code }) => ({ id, code })), [
    { id: 1, code: '01' }, { id: 2, code: '03' },
  ]);
  assert.equal(payload.directions[1].rows[0].stop_times[0].trip_id, 2);
});
