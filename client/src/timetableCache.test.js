import 'fake-indexeddb/auto';
import {
  findSavedTimetableByLocator,
  getCachedTimetable,
  getSavedTimetables,
  saveTimetableToCache,
  setTimetableSaved,
  getCachedTimetableStatus,
  saveTimetableStatusToCache,
  getCachedSchedules,
  saveSchedulesToCache,
} from './timetableCache';

const payload = {
  version: 2,
  directions: [{ name: 'Cape Town', trips: [{ trip_id: 1 }], rows: [{ name: 'Stop', stop_times: [] }] }],
};

const route = {
  id: 501,
  agency: 'GABS',
  code: '0004',
  name: 'ATLANTIS - CAPE TOWN',
  direction_1: 'Atlantis - Cape Town',
  direction_2: 'Cape Town - Atlantis',
  effective_date: '2026-08-01',
};

global.structuredClone = global.structuredClone || ((value) => JSON.parse(JSON.stringify(value)));

test('lists only saved records, backfills legacy metadata, resolves locators, and preserves unpinned cache data', async () => {
  const now = jest.spyOn(Date, 'now');
  now.mockReturnValueOnce(1000).mockReturnValueOnce(1000);
  expect(await saveTimetableToCache(route.id, payload, true, route.effective_date)).toBe(true);

  now.mockReturnValue(2000);
  expect(await saveTimetableToCache({ ...route, id: 502, code: '0005' }, payload, false)).toBe(true);

  const saved = await getSavedTimetables([route]);
  expect(saved).toHaveLength(1);
  expect(saved[0].routeSnapshot).toMatchObject({ id: 501, agency: 'GABS', code: '0004' });

  const backfilled = await getCachedTimetable(route.id);
  expect(backfilled.routeSnapshot.code).toBe('0004');
  expect((await findSavedTimetableByLocator({ agency: 'GABS', code: '0004' })).routeId).toBe(501);

  expect(await setTimetableSaved(route, false)).toBe(true);
  expect(await getSavedTimetables([route])).toEqual([]);
  const unpinned = await getCachedTimetable(route.id);
  expect(unpinned.saved).toBe(false);
  expect(unpinned.data).toEqual(payload);

  now.mockRestore();
});

test('update notices are stored independently from schedules and saved timetable freshness', async () => {
  await saveSchedulesToCache([route]);
  await saveTimetableToCache(route, payload, true);
  const before = await getCachedTimetable(route.id);
  const status = { checked_at: '2026-10-14T03:00:00Z', routes: [{ agency: 'GABS', code: '0004', directions: [] }] };
  await saveTimetableStatusToCache(status);
  expect(await getCachedTimetableStatus()).toEqual(status);
  expect((await getCachedSchedules()).data).toEqual([route]);
  expect(await getCachedTimetable(route.id)).toEqual(before);
});
