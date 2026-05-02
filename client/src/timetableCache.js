const DB_NAME = 'fika-timetable-cache';
const DB_VERSION = 1;
const SCHEDULES_KEY = 'all-schedules';
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_TIMETABLE_LIMIT = 5;

const STORES = {
  schedules: 'schedules',
  timetables: 'timetables',
};

const canUseIndexedDB = () => typeof window !== 'undefined' && 'indexedDB' in window;

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

export const isCacheStale = (cachedAt) => !cachedAt || Date.now() - cachedAt > DAY_MS;

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

export const saveTimetableToCache = async (routeId, data, saved) => {
  if (!routeId) {
    return;
  }

  try {
    const existing = await getCachedTimetable(routeId);
    const now = Date.now();

    await withStore(STORES.timetables, 'readwrite', (store) =>
      store.put({
        routeId: Number(routeId),
        data,
        saved: saved ?? existing?.saved ?? false,
        cachedAt: now,
        lastViewedAt: now,
      })
    );

    await trimRecentTimetables();
  } catch (error) {
    console.error('Error saving timetable to cache:', error);
  }
};

export const setTimetableSaved = async (routeId, saved) => {
  if (!routeId) {
    return false;
  }

  try {
    const existing = await getCachedTimetable(routeId);

    if (!existing) {
      return false;
    }

    await withStore(STORES.timetables, 'readwrite', (store) =>
      store.put({
        ...existing,
        saved,
        lastViewedAt: Date.now(),
      })
    );

    return true;
  } catch (error) {
    console.error('Error updating saved timetable:', error);
    return false;
  }
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
    const records = await withStore(STORES.timetables, 'readonly', (store) =>
      requestToPromise(store.getAll())
    );
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
