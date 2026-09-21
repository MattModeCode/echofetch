// A real folder on disk, chosen through the operating system's own picker.
//
// chrome.downloads can only write inside the browser's download directory, so the
// saved location lives here instead: showDirectoryPicker() hands back a directory
// handle, IndexedDB keeps it across restarts, and the offscreen document writes the
// finished file straight into it. Chrome only opens that picker from a page in a tab,
// which is why choosing happens on the options page and never in the popup.

const DB_NAME = 'echofetch';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'downloadRoot';

export const canPickFolder = () => typeof globalThis.showDirectoryPicker === 'function';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the handle store.'));
  });
}

function transact(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request ? request.result : undefined);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error || new Error('The handle store rejected the write.'));
        };
      })
  );
}

/** The saved folder, or null when none was ever chosen. */
export async function readRoot() {
  try {
    return (await transact('readonly', (store) => store.get(KEY))) || null;
  } catch {
    return null;
  }
}

export const writeRoot = (handle) => transact('readwrite', (store) => store.put(handle, KEY));
export const clearRoot = () => transact('readwrite', (store) => store.delete(KEY));

/**
 * Whether the handle can still be written to. `request` needs a user gesture and a
 * visible tab, so only the options page passes it; everywhere else asks and accepts no.
 */
export async function hasWriteAccess(handle, { request = false } = {}) {
  if (!handle) return false;
  try {
    const options = { mode: 'readwrite' };
    if ((await handle.queryPermission(options)) === 'granted') return true;
    return request && (await handle.requestPermission(options)) === 'granted';
  } catch {
    return false;
  }
}

/** Opens the OS folder picker and remembers the choice. Returns null if dismissed. */
export async function chooseRoot() {
  let handle;
  try {
    handle = await globalThis.showDirectoryPicker({
      id: 'echofetch-downloads',
      mode: 'readwrite',
      startIn: 'downloads'
    });
  } catch (error) {
    // AbortError is the user closing the dialog, which is not a failure.
    if (error?.name === 'AbortError') return null;
    throw error;
  }
  if (!(await hasWriteAccess(handle, { request: true }))) return null;
  await writeRoot(handle);
  return handle;
}

/** 'Psych/Week 3/lecture.mp4' -> { folders: ['Psych', 'Week 3'], name: 'lecture.mp4' }. */
export function splitPath(path) {
  const parts = String(path ?? '')
    .split('/')
    .filter(Boolean);
  return { folders: parts.slice(0, -1), name: parts[parts.length - 1] || '' };
}

/** Writes one blob at a path relative to `root`, creating the folders on the way. */
export async function writeInto(root, path, blob) {
  const { folders, name } = splitPath(path);
  if (!name) throw new Error('No file name to write.');

  let directory = root;
  for (const folder of folders) {
    directory = await directory.getDirectoryHandle(folder, { create: true });
  }

  const file = await directory.getFileHandle(name, { create: true });
  const stream = await file.createWritable();
  await stream.write(blob);
  await stream.close();
  return path;
}
