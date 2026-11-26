// The local note cache, in IndexedDB. The vault itself is the folder of Markdown files (vaultadapter.js);
// this copy keeps the last known notes for an instant launch and survives a hard quit that beat the file
// flush. It replaces the whole-vault localStorage value (vault.js), which overflowed the ~5 MB quota at
// about 1500 notes: writes here are per note. Because IndexedDB commits asynchronously, the notes changed
// since the last committed write are also kept in a small synchronous localStorage journal, replayed at
// the next launch if the quit came first.
import { loadLegacyNotes, removeLegacyNotes, corruptBackupKey } from './vault.js';

const DB = 'arf-cache', VERSION = 1, NOTES = 'notes', META = 'meta', ORDER = 'order';
export const JOURNAL_KEY = 'arf-cache-journal';

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
// a failed put (quota, clone error) aborts the transaction, so abort is the failure signal
const done = (tx) => new Promise((res) => { tx.oncomplete = () => res(true); tx.onabort = () => res(false); });

// a structured-cloneable copy: own keys only, arrays copied, so a Svelte $state proxy can be stored
export function plainNote(n) {
  const o = {};
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (v === undefined || typeof v === 'function' || k === '_stamped') continue;   // _stamped is per-load disk state
    o[k] = Array.isArray(v) ? v.slice() : (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
  }
  return o;
}

function readJournal(storage) {
  try { const j = JSON.parse(storage.getItem(JOURNAL_KEY) || '{}'); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { return {}; }
}

export class NoteCache {
  constructor(db, storage) {
    this.db = db; this.storage = storage;
    this.jr = readJournal(storage);   // id -> { seq, note } (note null = deleted) not yet committed to IndexedDB
    this.seq = Math.max(0, ...Object.values(this.jr).map((e) => +e.seq || 0));
  }
  close() { try { this.db.close(); } catch (e) {} }
  _saveJournal() {
    try { if (Object.keys(this.jr).length) this.storage.setItem(JOURNAL_KEY, JSON.stringify(this.jr)); else this.storage.removeItem(JOURNAL_KEY); return true; } catch (e) { return false; }
  }
  // drop journal entries for ids whose newer-or-equal state has now committed
  _settle(ids, upTo) {
    let ch = false;
    for (const id of ids) { const e = this.jr[id]; if (e && e.seq <= upTo) { delete this.jr[id]; ch = true; } }
    if (ch) this._saveJournal();
  }
  // synchronous record of [id, note|null] pairs, made before the async write that commits them. Returns
  // whether it was stored; a batch that does not fit (quota) is rolled back, so it cannot make every later
  // per-edit journal write fail too until the commit settles it.
  journal(entries) {
    if (!entries.length) return true;
    const prev = new Map();
    try {
      for (const [id, note] of entries) { if (!prev.has(id)) prev.set(id, this.jr[id]); this.jr[id] = { seq: ++this.seq, note: note ? plainNote(note) : null }; }
      if (this._saveJournal()) return true;
    } catch (e) { /* an uncloneable note: roll back like a failed write */ }
    for (const [id, e] of prev) { if (e) this.jr[id] = e; else delete this.jr[id]; }
    return false;
  }
  count() { return req(this.db.transaction(NOTES, 'readonly').objectStore(NOTES).count()); }
  // per-note puts and deletes (and the note order, when given) in one transaction; resolves to success
  write(puts, dels, order) {
    const upTo = this.seq;
    let tx;
    try {
      tx = this.db.transaction([NOTES, META], 'readwrite');
      const s = tx.objectStore(NOTES);
      for (const n of puts) s.put(plainNote(n));
      for (const id of dels) s.delete(id);
      if (order) tx.objectStore(META).put(order.slice(), ORDER);
    } catch (e) { try { tx && tx.abort(); } catch (e2) {} return Promise.resolve(false); }
    return done(tx).then((ok) => { if (ok) this._settle([...puts.map((n) => n.id), ...dels], upTo); return ok; });
  }
  // replace the whole store with `notes` in one transaction (adopting a vault, importing, switching);
  // meta: optional [key, value] records written to the meta store in the same transaction
  replaceAll(notes, order, meta = []) {
    const upTo = this.seq;
    let tx;
    try {
      tx = this.db.transaction([NOTES, META], 'readwrite');
      const s = tx.objectStore(NOTES);
      s.clear();
      for (const n of notes) s.put(plainNote(n));
      tx.objectStore(META).put((order || notes.map((n) => n.id)).slice(), ORDER);
      for (const [k, v] of meta) tx.objectStore(META).put(v, k);
    } catch (e) { try { tx && tx.abort(); } catch (e2) {} return Promise.resolve(false); }
    return done(tx).then((ok) => { if (ok) this._settle(Object.keys(this.jr), upTo); return ok; });
  }
  // every cached note in the app's order, with an uncommitted journal replayed (and then committed).
  // Ids missing from the stored order (notes created right before a quit) come first, newest first,
  // as the app puts a new note at the top.
  async readAll() {
    const tx = this.db.transaction([NOTES, META], 'readonly');
    const [list, order] = await Promise.all([req(tx.objectStore(NOTES).getAll()), req(tx.objectStore(META).get(ORDER))]);
    const byId = new Map(list.map((n) => [n.id, n]));
    const puts = [], dels = [], upTo = this.seq, pending = Object.keys(this.jr);
    for (const id of pending) {
      const e = this.jr[id];
      if (!e || !e.note) { byId.delete(id); dels.push(id); continue; }
      const ex = byId.get(id);
      if (!ex || (e.note.updated || '') >= (ex.updated || '')) { byId.set(id, e.note); puts.push(e.note); }
    }
    const pos = new Map((Array.isArray(order) ? order : []).map((id, i) => [id, i]));
    const notes = [...byId.values()].sort((a, b) => {
      const pa = pos.get(a.id), pb = pos.get(b.id);
      if (pa === undefined || pb === undefined) return pa === pb ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (pa === undefined ? -1 : 1);
      return pa - pb;
    });
    if (pending.length && (await this.write(puts, dels, notes.map((n) => n.id)))) this._settle(pending, upTo);
    return notes;
  }
}

// Ids of the notes in `next` that `prev` lacks or holds with other content, for journaling a wholesale
// adopt (import, seed, sync merge). By content, not by object: a sync merge hands back fresh disk copies of
// unchanged notes, and journaling those would push the whole vault into localStorage.
export function changedIds(prev, next) {
  const was = new Map(prev.map((n) => [n.id, n]));
  const same = (a, b) => a.updated === b.updated && a.created === b.created && a.title === b.title && a.body === b.body &&
    (a.folder || '') === (b.folder || '') && (a.tags || []).join('\u0000') === (b.tags || []).join('\u0000');
  return next.filter((n) => { const p = was.get(n.id); return !p || !same(p, n); }).map((n) => n.id);
}

// null when IndexedDB is missing or refuses to open
export function openNoteCache({ idb = globalThis.indexedDB, storage = globalThis.localStorage } = {}) {
  if (!idb) return Promise.resolve(null);
  return new Promise((res) => {
    let r;
    try { r = idb.open(DB, VERSION); } catch (e) { res(null); return; }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(NOTES)) db.createObjectStore(NOTES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    r.onsuccess = () => { const db = r.result; db.onversionchange = () => db.close(); res(new NoteCache(db, storage)); };
    r.onerror = () => res(null);
  });
}

// Load the cached notes at launch: { notes, cache, readFailed }. cache is null when this session must
// use the legacy localStorage path instead (IndexedDB unavailable, or a failed read or migration, which
// leaves the store untouched so the next launch retries). readFailed means notes may exist but could not
// be read, so the caller must not seed sample notes over them.
// A legacy localStorage value is migrated once: written as the store in one transaction, counted back,
// and only then removed. A corrupt value is removed once its backup is confirmed.
// The legacy key is only written by a session that ran without the store (IndexedDB unavailable, or a
// failed read or migration), so it is newer than whatever the store holds: after the journal replays
// (readAll), the legacy list replaces the store rather than merging with it, which would resurrect notes
// deleted in that session. Store notes the legacy list lacks are kept in a meta record (`recovered.replaced`)
// in case that session started without them. Duplicate ids in the legacy list keep the newest by
// `updated`; the others are backed up under a localStorage key (`recovered.duplicates`) first, and if that
// backup fails this session keeps the legacy path.
const DUPES_PREFIX = 'arf-vault-v0-dupes-';
function newestById(list) {
  const best = new Map(), extra = [];
  for (const n of list) {
    const ex = best.get(n.id);
    if (!ex) best.set(n.id, n);
    else if ((n.updated || '') > (ex.updated || '')) { extra.push(ex); best.set(n.id, n); }
    else extra.push(n);
  }
  return { notes: [...best.values()], extra };
}
export async function bootNotes(opts = {}) {
  const cache = await openNoteCache(opts);
  if (!cache) return { notes: loadLegacyNotes().notes, cache: null, readFailed: false };
  let cur;
  try { cur = await cache.readAll(); } catch (e) { cache.close(); return { notes: loadLegacyNotes().notes, cache: null, readFailed: true }; }
  const leg = loadLegacyNotes();
  if (!leg.present) return { notes: cur, cache, readFailed: false };
  if (leg.corrupt) { if (corruptBackupKey()) removeLegacyNotes(); return { notes: cur, cache, readFailed: false }; }
  // an entry the store can't key (no string id) can't migrate; keep the whole legacy path rather than drop it
  if (!leg.notes.every((n) => n && typeof n === 'object' && typeof n.id === 'string' && n.id)) { cache.close(); return { notes: leg.notes, cache: null, readFailed: false }; }
  const { notes, extra } = newestById(leg.notes), recovered = {}, at = Date.now();
  if (extra.length) {
    recovered.duplicates = DUPES_PREFIX + at;
    try { (opts.storage || globalThis.localStorage).setItem(recovered.duplicates, JSON.stringify(extra)); }
    catch (e) { console.warn('Arf: could not back up duplicate legacy notes; keeping the legacy store', e); cache.close(); return { notes: leg.notes, cache: null, readFailed: false }; }
    console.warn('Arf: ' + extra.length + ' older duplicate legacy note(s) backed up under ' + recovered.duplicates);
  }
  const ids = new Set(notes.map((n) => n.id)), dropped = cur.filter((n) => !ids.has(n.id)), meta = [];
  if (dropped.length) { recovered.replaced = 'legacy-replaced-' + at; meta.push([recovered.replaced, { at: new Date(at).toISOString(), notes: dropped.map(plainNote) }]); }
  let ok = await cache.replaceAll(notes, notes.map((n) => n.id), meta);
  if (ok) { try { ok = (await cache.count()) === notes.length; } catch (e) { ok = false; } }
  if (!ok) { cache.close(); return { notes, cache: null, readFailed: false }; }
  removeLegacyNotes();
  if (dropped.length) console.warn('Arf: ' + dropped.length + ' cached note(s) missing from the legacy list kept in the cache meta record ' + recovered.replaced);
  return { notes, cache, readFailed: false, recovered };
}
