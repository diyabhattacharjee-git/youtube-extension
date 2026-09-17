/**
 * IndexedDB persistence for mindmaps (they can be several MB with transcripts and
 * images — too large for chrome.storage). Stores:
 *   maps      — full mindmap documents (keyPath id)
 *   progress  — per-map learning progress: explored nodes, flashcard boxes, mastered nodes
 */

const DB_NAME = 'tubemind';
const DB_VERSION = 1;
let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('maps')) {
        const store = db.createObjectStore('maps', { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt');
      }
      if (!db.objectStoreNames.contains('progress')) db.createObjectStore('progress', { keyPath: 'mapId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const result = fn(store);
    transaction.oncomplete = () => resolve(result instanceof IDBRequest ? result.result : result);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function saveMap(map) {
  const doc = { ...map, updatedAt: Date.now() };
  await tx('maps', 'readwrite', (s) => s.put(doc));
  return doc;
}

export const getMap = (id) => tx('maps', 'readonly', (s) => s.get(id));

export const deleteMap = (id) => tx('maps', 'readwrite', (s) => s.delete(id));

export async function listMaps() {
  const all = await tx('maps', 'readonly', (s) => s.getAll());
  return (all || [])
    .map((m) => ({
      id: m.id,
      title: m.meta?.title || m.root?.text || 'Untitled',
      channel: m.meta?.channel || '',
      videoId: m.meta?.videoId || null,
      mode: m.meta?.mode,
      kind: m.meta?.kind || 'video',
      roomId: m.meta?.roomId || null,
      updatedAt: m.updatedAt || m.meta?.createdAt || 0,
      nodeCount: countNodes(m.root),
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function countNodes(node) {
  return node ? 1 + (node.children || []).reduce((n, c) => n + countNodes(c), 0) : 0;
}

export async function getProgress(mapId) {
  const p = await tx('progress', 'readonly', (s) => s.get(mapId));
  return p || { mapId, explored: [], mastered: [], cards: {}, quizCorrect: 0, quizTotal: 0 };
}

export const saveProgress = (progress) => tx('progress', 'readwrite', (s) => s.put(progress));
