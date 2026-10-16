const DB_NAME = 'fika-timetable-cache-v2';
const DB_VERSION = 1;
const SCHEDULES_KEY = 'all-schedules';
const STATUS_KEY = 'timetable-status';
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_TIMETABLE_LIMIT = 5;

const STORES = {
  schedules: 'schedules',
  timetables: 'timetables',
};

const canUseIndexedDB = () => typeof window !== 'undefined' && 'indexedDB' in window;

export const isTimetableStorageAvailable = () => canUseIndexedDB();

export const createRouteSnapshot = (route) => {
  if (!route || !route.id) {
    return null;
  }

  return {
    id: Number(route.id),
    agency: route.agency || '',
    code: route.code || '',
    name: route.name || '',
    direction_1: route.direction_1 || '',
    direction_2: route.direction_2 || '',
    effective_date: route.effective_date || null,
  };
};

const getRouteId = (routeOrId) => Number(
  typeof routeOrId === 'object' ? routeOrId?.id : routeOrId
);

const openDatabase = () => {
  if (!canUseIndexedDB()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORES.schedules)) {
        db.createObjectStore(STORES.schedules, { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains(STORES.timetables)) {
        db.createObjectStore(STORES.timetables, { keyPath: 'routeId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

const withStore = async (storeName, mode, callback) => {
  const db = await openDatabase();

  if (!db) {
    return null;
  }

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = callback(store);

    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
  });
};

const requestToPromise = (request) => {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const getCachedSchedules = async () => {
  try {
    const record = await withStore(STORES.schedules, 'readonly', (store) =>
      requestToPromise(store.get(SCHEDULES_KEY))
    );

    return record || null;
  } catch (error) {
    console.error('Error reading cached schedules:', error);
    return null;
  }
};

export const saveSchedulesToCache = async (schedules) => {
  try {
    await withStore(STORES.schedules, 'readwrite', (store) =>
      store.put({
        id: SCHEDULES_KEY,
        data: schedules,
        cachedAt: Date.now(),
      })
    );
  } catch (error) {
    console.error('Error saving schedules to cache:', error);
  }
};

// Status evidence has its own timestamp and never changes the age of saved times.
export const getCachedTimetableStatus = async () => {
  try {
    const record = await withStore(STORES.schedules, 'readonly', (store) =>
      requestToPromise(store.get(STATUS_KEY))
    );
    return record?.data || null;
  } catch {
    return null;
  }
};

export const saveTimetableStatusToCache = async (data) => {
  try {
    await withStore(STORES.schedules, 'readwrite', (store) =>
      store.put({ id: STATUS_KEY, data })
    );
  } catch {
    // Notices are optional; storage failures must not prevent timetable use.
  }
};

export const getCachedTimetable = async (routeId) => {
  if (!routeId) {
    return null;
  }

  try {
    const record = await withStore(STORES.timetables, 'readonly', (store) =>
      requestToPromise(store.get(Number(routeId)))
    );

    return record || null;
  } catch (error) {
    console.error('Error reading cached timetable:', error);
    return null;
  }
};

export const isTimetableCacheCurrent = (record, effectiveDate) => {
  if (!record?.cachedAt) {
    return false;
  }

  if (effectiveDate) {
    return record.effectiveDate === effectiveDate;
  }

  return Date.now() - record.cachedAt <= DAY_MS;
};

export const saveTimetableToCache = async (routeOrId, data, saved, effectiveDate = null) => {
  const routeId = getRouteId(routeOrId);

  if (!routeId || !canUseIndexedDB()) {
    return false;
  }

  try {
    const existing = await getCachedTimetable(routeId);
    const now = Date.now();
    const routeSnapshot = createRouteSnapshot(
      typeof routeOrId === 'object' ? routeOrId : null
    ) || existing?.routeSnapshot || null;
    const savedValue = saved ?? existing?.saved ?? false;
    const nextEffectiveDate = typeof routeOrId === 'object'
      ? routeOrId.effective_date || null
      : effectiveDate || null;

    await withStore(STORES.timetables, 'readwrite', (store) =>
      store.put({
        routeId: Number(routeId),
        data,
        saved: savedValue,
        savedAt: savedValue ? existing?.savedAt || now : null,
        routeSnapshot,
        effectiveDate: nextEffectiveDate,
        cachedAt: now,
        lastViewedAt: now,
      })
    );

    await trimRecentTimetables();
    return true;
  } catch (error) {
    console.error('Error saving timetable to cache:', error);
    return false;
  }
};

export const setTimetableSaved = async (routeOrId, saved) => {
  const routeId = getRouteId(routeOrId);

  if (!routeId || !canUseIndexedDB()) {
    return false;
  }

  try {
    const existing = await getCachedTimetable(routeId);

    if (!existing) {
      return false;
    }

    const now = Date.now();
    const routeSnapshot = createRouteSnapshot(
      typeof routeOrId === 'object' ? routeOrId : null
    ) || existing.routeSnapshot || null;

    await withStore(STORES.timetables, 'readwrite', (store) =>
      store.put({
        ...existing,
        saved,
        savedAt: saved ? (existing.saved ? existing.savedAt || now : now) : null,
        routeSnapshot,
        lastViewedAt: now,
      })
    );

    return true;
  } catch (error) {
    console.error('Error updating saved timetable:', error);
    return false;
  }
};

const getAllTimetables = async () => {
  const records = await withStore(STORES.timetables, 'readonly', (store) =>
    requestToPromise(store.getAll())
  );

  return records || [];
};

export const getSavedTimetables = async (schedules = []) => {
  try {
    const originalRecords = await getAllTimetables();
    const scheduleById = new Map((schedules || []).map((route) => [Number(route.id), route]));
    const savedRecords = originalRecords
      .filter((record) => record.saved)
      .map((record) => ({
        ...record,
        routeSnapshot: record.routeSnapshot || createRouteSnapshot(scheduleById.get(Number(record.routeId))),
      }))
      .sort((first, second) =>
        (second.lastViewedAt || second.savedAt || 0) - (first.lastViewedAt || first.savedAt || 0)
      );
    // Backfill legacy records only when their original record had no route snapshot.
    const originalById = new Map(originalRecords.map((record) => [Number(record.routeId), record]));
    const backfills = savedRecords.filter((record) =>
      record.routeSnapshot && !originalById.get(Number(record.routeId))?.routeSnapshot
    );

    if (backfills.length) {
      await withStore(STORES.timetables, 'readwrite', (store) => {
        backfills.forEach((record) => store.put(record));
      });
    }
    return savedRecords;
  } catch (error) {
    console.error('Error listing saved timetables:', error);
    return [];
  }
};

export const findSavedTimetableByLocator = async (locator) => {
  if (!locator) {
    return null;
  }

  const savedRecords = await getSavedTimetables();

  return savedRecords.find((record) => {
    const snapshot = record.routeSnapshot;

    if (locator.id) {
      return Number(record.routeId) === Number(locator.id);
    }

    return snapshot &&
      snapshot.agency === locator.agency &&
      String(snapshot.code || '').toLowerCase() === String(locator.code || '').toLowerCase();
  }) || null;
};

export const touchTimetable = async (routeId) => {
  try {
    const existing = await getCachedTimetable(routeId);

    if (!existing) {
      return;
    }

    await withStore(STORES.timetables, 'readwrite', (store) =>
      store.put({
        ...existing,
        lastViewedAt: Date.now(),
      })
    );
  } catch (error) {
    console.error('Error touching cached timetable:', error);
  }
};

export const trimRecentTimetables = async () => {
  try {
    const records = await getAllTimetables();
    const unsaved = (records || [])
      .filter((record) => !record.saved)
      .sort((first, second) => (second.lastViewedAt || 0) - (first.lastViewedAt || 0));
    const recordsToDelete = unsaved.slice(RECENT_TIMETABLE_LIMIT);

    if (!recordsToDelete.length) {
      return;
    }

    await withStore(STORES.timetables, 'readwrite', (store) => {
      recordsToDelete.forEach((record) => {
        store.delete(record.routeId);
      });
    });
  } catch (error) {
    console.error('Error trimming cached timetables:', error);
  }
};
