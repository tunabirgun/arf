// Main-thread wrapper around the embedder worker + an IndexedDB embedding cache.
// This is the real on-device ML layer: MiniLM sentence embeddings with cosine
// similarity, replacing the TF-IDF stand-in (which stays as an instant fallback
// while the model downloads or if WebGPU/WASM is unavailable).
import { TF_CACHE, HF_HOST, REPO_RE, matchesRepo, repoFilesPresent, runtimePresent, revisionOf } from './models.js';

let worker = null;
let ready = false;
let reqId = 0;
const pending = new Map();
let statusCb = () => {};
let sawTotal = false;   // once aggregated progress arrives, per-file events would make the bar jump between files
// a progress message -> percent across the model's files (progress_total), or null for a superseded per-file event
function progressPct(m, st) { if (m.total) { st.total = true; return m.pct; } return st.total ? null : m.pct; }

function ensureWorker() {
  if (worker) return;
  worker = new Worker(new URL('./embedder.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'progress') { const st = { total: sawTotal }, pct = progressPct(m, st); sawTotal = st.total; if (pct != null) statusCb({ status: 'loading', file: m.file, pct }); }
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

// --- model revisions: the Hub commit a model's files were pinned to at download (localStorage 'arf-model-rev') ---
const REV_KEY = 'arf-model-rev';
function revMap() { try { const j = JSON.parse(localStorage.getItem(REV_KEY) || '{}'); return j && typeof j === 'object' ? j : {}; } catch (e) { return {}; } }
export function modelRevision(id) { const r = revMap()[id]; return typeof r === 'string' && /^[0-9a-f]{40}$/.test(r) ? r : null; }
function setRevision(id, rev) { try { const m = revMap(); if (rev) m[id] = rev; else delete m[id]; localStorage.setItem(REV_KEY, JSON.stringify(m)); } catch (e) {} }
// the repo's current commit from the Hub API; throws with the message the UI shows
export async function fetchRevision(id, fetchImpl = fetch) {
  if (!REPO_RE.test(id || '')) throw new Error('Use the form owner/name');
  let res;
  try { res = await fetchImpl(HF_HOST + 'api/models/' + id); } catch (e) { throw new Error('Could not reach Hugging Face'); }
  if (res.status === 401 || res.status === 404) throw new Error('Not found, or not public yet (' + res.status + ')');
  if (!res.ok) throw new Error('Hugging Face returned ' + res.status);
  const rev = revisionOf(await res.json().catch(() => null));
  if (!rev) throw new Error('Hugging Face returned no revision for ' + id);
  return rev;
}

// spec: a repo id, or { model, pooling, prefix (prepended to every note text), dtype, revision }
const DEFAULT_SPEC = { model: 'Xenova/all-MiniLM-L6-v2', pooling: 'mean', prefix: '', dtype: 'q8', revision: null };
export function normSpec(s) { return typeof s === 'string' ? { ...DEFAULT_SPEC, model: s } : { ...DEFAULT_SPEC, ...(s || {}) }; }
// a spec without a revision takes the one recorded when the model was downloaded (none: files from 'main', as before)
const withRevision = (p) => (p.revision ? p : { ...p, revision: modelRevision(p.model) });
// The embedding space a vector belongs to. The default (mean pooling, no prefix, no recorded revision) keeps the form
// 'model:q8'; any other pooling, prefix or a pinned revision gets its own space. Every tag starts with 'model:'.
export function cacheTag(s) {
  const p = normSpec(s); let t = p.model + ':' + p.dtype;
  if (p.pooling !== 'mean') t += ':' + p.pooling;
  if (p.prefix) t += ':' + JSON.stringify(p.prefix);
  if (p.revision) t += '@' + p.revision;
  return t;
}

// Run generation: bumped by initEmbedder and resetEmbedder. A run of embedNotes that started under an older generation
// rejects with a StaleRunError (err.stale === true) instead of returning or caching vectors of the previous model.
let generation = 0;
export function embedGeneration() { return generation; }
export class StaleRunError extends Error { constructor() { super('stale embedding run: the model changed'); this.name = 'StaleRunError'; this.stale = true; } }

let spec = { ...DEFAULT_SPEC };
export function initEmbedder(cb, s) { generation++; statusCb = cb || (() => {}); if (s) spec = withRevision(normSpec(s)); sawTotal = false; ensureWorker(); worker.postMessage({ type: 'init', ...spec, revision: spec.revision || 'main' }); }
export function activeSpec() { return { ...spec }; }
export function isReady() { return ready; }
// tear the worker down so switching models loads a fresh one (the old extractor is cached in-worker)
export function resetEmbedder() { generation++; if (worker) { try { worker.terminate(); } catch (e) {} } worker = null; ready = false; sawTotal = false; for (const [, p] of pending) p.reject(new Error('reset')); pending.clear(); }

// --- model files: download without activating, check, remove ---
// A throwaway worker loads the model once (files + verified onnxruntime runtime land in Cache Storage) and is then
// terminated. It has its own message channel, so a download never touches the active model's status. The repo's
// current commit is read from the Hub first and the files are fetched at that commit, so the recorded revision
// always names the weights in the cache.
const downloads = new Map();
export function download(s, onProgress = () => {}) {
  const p = normSpec(s), id = p.model;
  if (downloads.has(id)) return downloads.get(id).promise;
  let w = null, fail, finished = false;
  const done = () => { finished = true; if (w) { try { w.terminate(); } catch (e) {} } downloads.delete(id); };
  const promise = new Promise((resolve, reject) => {
    fail = (err) => { if (finished) return; done(); reject(err); };
    fetchRevision(id).then((rev) => {
      if (finished) return;
      w = new Worker(new URL('./embedder.worker.js', import.meta.url), { type: 'module' });
      const st = { total: false };
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { const pct = progressPct(m, st); if (pct != null) onProgress({ pct, loaded: m.loaded, size: m.size }); }
        else if (m.type === 'fetched') { setRevision(id, rev); done(); resolve(true); }
        else if (m.type === 'error') fail(new Error(m.error));
      };
      w.onerror = (ev) => fail(new Error((ev && ev.message) || 'download worker crashed'));
      // wasm only: the fetch-only load just needs the files and the runtime, not a GPU session
      w.postMessage({ type: 'init', ...p, revision: rev, device: 'wasm', fetchOnly: true });
    }, fail);
  });
  downloads.set(id, { promise, cancel: () => fail(new Error('cancelled')) });
  return promise;
}
export function cancelDownload(id) { const d = downloads.get(id); if (d) d.cancel(); }
export function isDownloading(id) { return downloads.has(id); }

async function cacheUrls() {
  if (typeof caches === 'undefined') return [];
  const c = await caches.open(TF_CACHE);
  return (await c.keys()).map((r) => r.url);
}
// downloaded = the model's files at its recorded revision AND a verified onnxruntime runtime are in Cache Storage
const present = (urls, id) => repoFilesPresent(urls, id, modelRevision(id) || 'main') && runtimePresent(urls);
export async function isDownloaded(id) { try { return present(await cacheUrls(), id); } catch (e) { return false; } }
// ids (of those given) that are downloaded, from one Cache Storage listing
export async function downloadedSet(ids) { try { const u = await cacheUrls(); return new Set(ids.filter((id) => present(u, id))); } catch (e) { return new Set(); } }
// the runtime alone (shared by all models), for a separate status line
export async function runtimeCached() { try { return runtimePresent(await cacheUrls()); } catch (e) { return false; } }
// Delete one repo's files (every revision; never the shared onnxruntime entries), its recorded revision, and every
// vector embedded with it (IndexedDB and memory). Returns the number of cached files deleted.
export async function remove(id) {
  clearEmbedCaches();
  setRevision(id, null);
  await deleteVectors(id);
  if (typeof caches === 'undefined') return 0;
  const c = await caches.open(TF_CACHE); let n = 0;
  for (const req of await c.keys()) if (matchesRepo(req.url, id) && await c.delete(req)) n++;
  return n;
}

// embed texts with the current worker; with a generation, refuses to post once the model has changed
export function embed(texts, gen = null) {
  if (gen != null && gen !== generation) return Promise.reject(new StaleRunError());
  ensureWorker();
  return new Promise((resolve, reject) => { const id = ++reqId; pending.set(id, { resolve, reject }); worker.postMessage({ type: 'embed', id, texts }); });
}

// embeddings are L2-normalized, so cosine == dot product
export function cosine(a, b) { if (!a || !b) return 0; let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }

// --- embedding cache (IndexedDB) so we never re-embed unchanged notes ---
// Key: cacheTag + '\n' + content hash of the text, so switching models can never serve vectors from another embedding
// space, and all of one model's vectors form one key range (every tag starts with 'model:').
// Version 2 drops the version-1 store: its keys carried no tag and its vectors were computed with batched, padded
// forward passes and array-cut truncation, so they are not comparable with the current per-note HF-truncated ones.
const DB = 'arf-embed', DB_VERSION = 2, STORE = 'vecs';
let dbPromise = null;
function idb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(DB, DB_VERSION);
    r.onupgradeneeded = () => { const db = r.result; if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE); db.createObjectStore(STORE); };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => { db.close(); dbPromise = null; }; res(db); };
    r.onerror = () => { dbPromise = null; rej(r.error); };
  });
  return dbPromise;
}
// read many keys in ONE readonly transaction; a failed transaction just yields the hits gathered so far,
// and the rest fall through to re-embedding
async function cacheGetMany(keys) {
  const out = new Map(); if (!keys.length) return out;
  try {
    const db = await idb();
    return await new Promise((res) => {
      const tx = db.transaction(STORE, 'readonly'), os = tx.objectStore(STORE);
      for (const k of keys) { const q = os.get(k); q.onsuccess = () => { if (q.result) out.set(k, q.result); }; }
      tx.oncomplete = tx.onabort = tx.onerror = () => res(out);
    });
  } catch (e) { return out; }
}
async function cachePut(key, vec) {
  try { const db = await idb(); db.transaction(STORE, 'readwrite').objectStore(STORE).put(vec, key); } catch (e) {}
}
// every stored vector of one model, any dtype/pooling/prefix/revision
async function deleteVectors(id) {
  try {
    const db = await idb();
    await new Promise((res) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(IDBKeyRange.bound(id + ':', id + ':￿'));
      tx.oncomplete = tx.onabort = tx.onerror = () => res();
    });
  } catch (e) {}
}
export async function contentHash(text) {
  try { const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join(''); }
  catch (e) { let h = 0; for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0; return 'h' + (h >>> 0).toString(16); }
}

// in-memory layers over IndexedDB: note id -> {text, key} (skips re-hashing unchanged text) and key -> vector
// (skips the IDB read). Both are content-addressed, so a stale entry can never be served.
const hashMemo = new Map(), vecMemo = new Map();
export function clearEmbedCaches() { hashMemo.clear(); vecMemo.clear(); }
// the exact text last embedded for a note (after the 4000-char cap), e.g. for adaptiveThresholds' near-empty filter
export function embeddedText(id) { const m = hashMemo.get(id); return m ? m.text : null; }

// Embed a set of notes, using the cache for unchanged ones. textOf(note) -> string. Resolves to { id: vector }.
// Rejects with StaleRunError when initEmbedder/resetEmbedder ran meanwhile (nothing from that run is cached).
export async function embedNotes(notes, textOf, onProgress = null) {   // onProgress(done, total) for notes that need embedding
  const gen = generation, tag = cacheTag(spec); // snapshot: a mid-run model switch must not mix cache spaces
  const live = () => { if (gen !== generation) throw new StaleRunError(); };
  const texts = notes.map((n) => (textOf(n) || '').slice(0, 4000)); // the tokenizer keeps the first 256-512 tokens anyway
  const keys = await Promise.all(notes.map((n, i) => {
    const m = hashMemo.get(n.id);
    if (m && m.tag === tag && m.text === texts[i]) return m.key;
    return contentHash(texts[i]).then((h) => { const key = tag + '\n' + h; hashMemo.set(n.id, { tag, text: texts[i], key }); return key; });
  }));
  live();
  const result = {}, toEmbed = [], meta = [], miss = [];
  notes.forEach((n, i) => { if (vecMemo.has(keys[i])) result[n.id] = vecMemo.get(keys[i]); else miss.push(i); });
  const stored = await cacheGetMany([...new Set(miss.map((i) => keys[i]))]);
  live();
  for (const i of miss) {
    const hit = stored.get(keys[i]);
    if (hit) { result[notes[i].id] = hit; vecMemo.set(keys[i], hit); }
    else { toEmbed.push(texts[i]); meta.push({ id: notes[i].id, key: keys[i] }); }
  }
  // embed in bounded chunks so a large first-run vault can't OOM the worker; each chunk is cached as it lands,
  // so partial progress survives a later failure
  const CHUNK = 32;
  if (onProgress && toEmbed.length) onProgress(0, toEmbed.length);
  for (let s = 0; s < toEmbed.length; s += CHUNK) {
    const vecs = await embed(toEmbed.slice(s, s + CHUNK), gen);
    live();
    for (let i = 0; i < vecs.length; i++) { const mt = meta[s + i]; result[mt.id] = vecs[i]; vecMemo.set(mt.key, vecs[i]); cachePut(mt.key, vecs[i]); }
    if (onProgress) onProgress(s + vecs.length, toEmbed.length);
  }
  // drop memo entries for notes/content no longer in the vault so edits and deletes don't accumulate
  const ids = new Set(notes.map((n) => n.id)), liveKeys = new Set(keys);
  for (const id of hashMemo.keys()) if (!ids.has(id)) hashMemo.delete(id);
  for (const k of vecMemo.keys()) if (!liveKeys.has(k)) vecMemo.delete(k);
  return result;
}
