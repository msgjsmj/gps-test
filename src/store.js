// On-device persistence. Visit metadata and photo blobs live in separate
// IndexedDB stores: WebKit fails to re-store a Blob that was read back from
// IndexedDB (bug 235687), so a photo is written exactly once at capture and
// re-labelling a visit rewrites metadata only. Small per-device settings live
// in localStorage. Storage can be unavailable (private mode, blocked, iOS
// dropping the connection in the background), so callers treat every write as
// "may fail, retry later".

const DB_NAME = 'gps-test';
const DB_VERSION = 2;

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 2) {
        // v1 kept photos inside visits; it never shipped, so start clean.
        if (db.objectStoreNames.contains('visits')) db.deleteObjectStore('visits');
        db.createObjectStore('visits', { keyPath: 'id' });
        db.createObjectStore('photos');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => (dbPromise = undefined); // iOS drops connections in the background
      db.onversionchange = () => {
        db.close();
        dbPromise = undefined;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  }).catch((e) => {
    dbPromise = undefined;
    throw e;
  });
  return dbPromise;
}

// One request in its own transaction, resolved after commit. A failure drops the
// cached connection (it may be dead) and retries once on a fresh one.
async function run(store, mode, makeRequest, retry = true) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = makeRequest(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    });
  } catch (e) {
    dbPromise = undefined;
    if (retry) return run(store, mode, makeRequest, false);
    throw e;
  }
}

export async function loadVisits() {
  const visits = await run('visits', 'readonly', (s) => s.getAll());
  return visits.sort((a, b) => a.at.localeCompare(b.at));
}

export const saveVisit = (visit) => run('visits', 'readwrite', (s) => s.put(visit));
export const savePhoto = (id, blob) => run('photos', 'readwrite', (s) => s.put(blob, id));
export const loadPhoto = (id) => run('photos', 'readonly', (s) => s.get(id));
export const clearAll = () => Promise.all([run('visits', 'readwrite', (s) => s.clear()), run('photos', 'readwrite', (s) => s.clear())]);

// Ask the browser not to evict our data under storage pressure (best effort).
export const requestPersistence = () => navigator.storage?.persist?.().catch(() => false) ?? Promise.resolve(false);

export function loadSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(`gps-test:${key}`);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function saveSetting(key, value) {
  try {
    localStorage.setItem(`gps-test:${key}`, JSON.stringify(value));
  } catch {
    // storage blocked: the setting lasts for this page only
  }
}
