/**
 * Keeps programs, tapes, disks and cartridges in IndexedDB (too big for
 * localStorage), so a reload finds everything where it was. One object
 * store, keys by kind:
 *
 *   "shelf:<name>"  every file ever loaded, to pick again later
 *   "tape"          the cassette in the Datasette, with what SAVE recorded
 *   "disk:<n>"      the disk in drive n (8, 9), with what was written to it
 *   "cart"          the cartridge in the expansion port
 *   "quick"         the quick-save slot
 */

const DB = 'ready-prompt';
const STORE = 'files';
const SHELF = 'shelf:';

export interface StoredFile {
  name: string;
  data: Uint8Array;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await open();
    return await new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined; // private mode or blocked storage: nothing is remembered
  }
}

const put = (key: IDBValidKey, value: StoredFile | null) =>
  run<unknown>('readwrite', s => (value ? s.put(value, key) : s.delete(key)) as IDBRequest<unknown>);
const get = (key: IDBValidKey) => run<StoredFile>('readonly', s => s.get(key));

export const saveTape = (f: StoredFile | null) => put('tape', f);
export const loadTape = () => get('tape');
export const saveDisk = (drive: number, f: StoredFile | null) => put(`disk:${drive}`, f);
export const loadDisk = (drive: number) => get(`disk:${drive}`);
export const saveCart = (f: StoredFile | null) => put('cart', f);
export const loadCart = () => get('cart');
export const saveQuick = (f: StoredFile) => put('quick', f);
export const loadQuick = () => get('quick');

export const shelve = (file: StoredFile) => put(SHELF + file.name, file);
export const unshelve = (name: string) => put(SHELF + name, null);
export const loadShelf = async (): Promise<StoredFile[]> => {
  const all = await run<StoredFile[]>('readonly', s => s.getAll(IDBKeyRange.bound(SHELF, SHELF + '￿')));
  return (all ?? []).sort((a, b) => a.name.localeCompare(b.name));
};
