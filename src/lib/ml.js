// Main-thread wrapper around the embedder worker + an IndexedDB embedding cache.
// This is the real on-device ML layer: MiniLM sentence embeddings with cosine
// similarity, replacing the TF-IDF stand-in (which stays as an instant fallback
// while the model downloads or if WebGPU/WASM is unavailable).

let worker = null;
let ready = false;
let reqId = 0;
const pending = new Map();
let statusCb = () => {};

function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL('./embedder.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') statusCb({ status: 'loading', file: m.file, pct: m.pct });
    else if (m.type === 'ready') { ready = true; statusCb({ status: 'ready' }); }
    else if (m.type === 'error') {
      // a per-request failure rejects only that request; only an init-level error (no id) disables the model
      if (m.id != null && pending.has(m.id)) { pending.get(m.id).reject(new Error(m.error)); pending.delete(m.id); }
      else statusCb({ status: 'error', error: m.error });
    } else if (m.type === 'embedded') {
      if (pending.has(m.id)) { pending.get(m.id).resolve(m.vectors); pending.delete(m.id); }
    }
  };
  worker.onerror = (ev) => {
    const msg = (ev && ev.message) || 'worker crashed';
    ready = false;
    try { worker.terminate(); } catch (e) {}
    worker = null; // so the next initEmbedder() builds a fresh worker instead of reusing the dead one
    for (const [, p] of pending) p.reject(new Error(msg));
    pending.clear();
    statusCb({ status: 'error', error: msg });
  };
}

let currentModel = 'Xenova/all-MiniLM-L6-v2';
export function initEmbedder(cb, model) { statusCb = cb || (() => {}); if (model) currentModel = model; ensureWorker(); worker.postMessage({ type: 'init', model: currentModel }); }
export function isReady() { return ready; }
// tear the worker down so switching models loads a fresh one (the old extractor is cached in-worker)
export function resetEmbedder() { if (worker) { try { worker.terminate(); } catch (e) {} } worker = null; ready = false; for (const [, p] of pending) p.reject(new Error('reset')); pending.clear(); }

export function embed(texts) {
  ensureWorker();
  return new Promise((resolve, reject) => { const id = ++reqId; pending.set(id, { resolve, reject }); worker.postMessage({ type: 'embed', id, texts }); });
}

// embeddings are L2-normalized, so cosine == dot product
export function cosine(a, b) { if (!a || !b) return 0; let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }

// --- content-addressed cache (IndexedDB) so we never re-embed unchanged notes ---
// MODEL_TAG is mixed into every cache key, so changing the model/quantization can
// never serve vectors from a different embedding space.
export const MODEL_TAG = 'minilm-l6-q8-v1';
const DB = 'arf-embed', STORE = 'vecs';
let dbPromise = null;
function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => { dbPromise = null; rej(r.error); };
  });
  return dbPromise;
}
async function cacheGet(hash) {
  try { const db = await idb(); return await new Promise((res) => { const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(hash); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); }); }
  catch (e) { return null; }
}
async function cachePut(hash, vec) {
  try { const db = await idb(); db.transaction(STORE, 'readwrite').objectStore(STORE).put(vec, hash); } catch (e) {}
}
export async function contentHash(text) {
  try { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join(''); }
  catch (e) { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(16); }
}

// Embed a set of notes, using the cache for unchanged ones. textOf(note) -> string.
export async function embedNotes(notes, textOf) {
  const model = currentModel; // snapshot: a mid-run model switch must not mix cache spaces
  const result = {}, toEmbed = [], meta = [];
  for (const n of notes) {
    const text = (textOf(n) || '').slice(0, 4000); // MiniLM truncates ~256 tokens anyway
    const hash = await contentHash(model + ':q8 ' + text);
    const hit = await cacheGet(hash);
    if (hit) result[n.id] = hit;
    else { toEmbed.push(text); meta.push({ id: n.id, hash }); }
  }
  // embed in bounded chunks so a large first-run vault can't OOM the worker in one forward pass;
  // each chunk is cached as it lands, so partial progress survives a later failure
  const CHUNK = 32;
  for (let s = 0; s < toEmbed.length; s += CHUNK) {
    const vecs = await embed(toEmbed.slice(s, s + CHUNK));
    for (let i = 0; i < vecs.length; i++) { const mt = meta[s + i]; result[mt.id] = vecs[i]; cachePut(mt.hash, vecs[i]); }
  }
  return result;
}
