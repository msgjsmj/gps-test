// On-device persistence. Visits (with photo blobs) live in IndexedDB; small
// per-device settings in localStorage. Both can be unavailable (private mode,
// blocked storage), so every call degrades to "not saved" instead of throwing.

const DB_NAME = 'gps-test';
const STORE = 'visits';

let dbPromise;
function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// Runs one request in its own transaction; resolves with the request's result once committed.
async function run(mode, makeRequest) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = makeRequest(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function loadVisits() {
  const visits = await run('readonly', (s) => s.getAll());
  return visits.sort((a, b) => a.at.localeCompare(b.at));
}

export const saveVisit = (visit) => run('readwrite', (s) => s.put(visit));
export const clearVisits = () => run('readwrite', (s) => s.clear());

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
