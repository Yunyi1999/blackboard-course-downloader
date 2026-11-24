// 文件夹句柄只能存在 IndexedDB 里（chrome.storage 存不了）
const DB = "bbdl";
const STORE = "handles";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
  }));
}

export const idbGet = (key) => tx("readonly", (s) => s.get(key));
export const idbSet = (key, val) => tx("readwrite", (s) => s.put(val, key));
export const idbDel = (key) => tx("readwrite", (s) => s.delete(key));
