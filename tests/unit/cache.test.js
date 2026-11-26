// @vitest-environment jsdom
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openNoteCache, bootNotes, NoteCache, plainNote, JOURNAL_KEY, changedIds } from '../../src/lib/cache.js';
import { saveNotes, hasLegacyNotes, corruptBackupKey } from '../../src/lib/vault.js';

const LEGACY = 'arf-vault-v0';
let idb;
beforeEach(() => { localStorage.clear(); idb = new IDBFactory(); });   // a fresh, empty IndexedDB per test

const note = (id, updated = '2026-01-01T00:00:00.000Z', extra = {}) => ({ id, title: 'T ' + id, folder: '', tags: ['a'], created: updated, updated, body: 'body ' + id, ...extra });
const open = () => openNoteCache({ idb, storage: localStorage });
const ids = (list) => list.map((n) => n.id);

describe('plainNote', () => {
  it('copies own keys and arrays and drops undefined and functions', () => {
    const src = { id: 'a', tags: ['x'], _path: undefined, fn() {} };
    const p = plainNote(src);
    expect(p).toEqual({ id: 'a', tags: ['x'] });
    expect(p.tags).not.toBe(src.tags);
  });
  it('drops the per-load _stamped marker', () => {
    expect(plainNote({ id: 'a', _stamped: true, _flushed: 'u' })).toEqual({ id: 'a', _flushed: 'u' });
  });
  it('lets a proxied note (as Svelte $state hands out) be stored', async () => {
    const c = await open();
    const prox = new Proxy({ ...note('P1'), tags: new Proxy(['t'], {}) }, {});
    expect(await c.write([prox], [], null)).toBe(true);
    expect(await c.readAll()).toEqual([{ ...note('P1'), tags: ['t'] }]);
  });
});

describe('NoteCache writes', () => {
  it('keeps the app order, not the key order', async () => {
    const c = await open();
    const list = [note('C'), note('A'), note('B')];
    expect(await c.write(list, [], ids(list))).toBe(true);
    expect(ids(await c.readAll())).toEqual(['C', 'A', 'B']);
  });
  it('puts and deletes single notes', async () => {
    const c = await open();
    await c.write([note('A'), note('B')], [], ['A', 'B']);
    await c.write([note('A', '2026-02-01T00:00:00.000Z', { body: 'changed' })], ['B'], ['A']);
    const all = await c.readAll();
    expect(ids(all)).toEqual(['A']);
    expect(all[0].body).toBe('changed');
    expect(await c.count()).toBe(1);
  });
  it('replaceAll swaps the whole store in one go', async () => {
    const c = await open();
    await c.write([note('A'), note('B')], [], ['A', 'B']);
    expect(await c.replaceAll([note('X'), note('Y')], ['Y', 'X'])).toBe(true);
    expect(ids(await c.readAll())).toEqual(['Y', 'X']);
  });
  it('reports a failed write and leaves the store as it was', async () => {
    const c = await open();
    await c.write([note('A')], [], ['A']);
    expect(await c.write([note('A', '2026-03-01T00:00:00.000Z'), { ...note('B'), bad: Symbol('no clone') }], [], null)).toBe(false);
    const all = await c.readAll();
    expect(ids(all)).toEqual(['A']);
    expect(all[0].updated).toBe('2026-01-01T00:00:00.000Z');   // the transaction is atomic
  });
});

describe('journal', () => {
  it('is cleared once the write that covers it commits', async () => {
    const c = await open();
    c.journal([['A', note('A')]]);
    expect(JSON.parse(localStorage.getItem(JOURNAL_KEY)).A.note.id).toBe('A');
    expect(await c.write([note('A')], [], ['A'])).toBe(true);
    expect(localStorage.getItem(JOURNAL_KEY)).toBeNull();
  });
  it('survives a failed write', async () => {
    const c = await open();
    c.journal([['A', note('A')]]);
    expect(await c.write([{ ...note('A'), bad: Symbol('x') }], [], null)).toBe(false);
    expect(localStorage.getItem(JOURNAL_KEY)).not.toBeNull();
  });
  it('replays an uncommitted edit, creation and deletion at the next launch, then commits them', async () => {
    const c = await open();
    await c.write([note('A'), note('B'), note('C')], [], ['A', 'B', 'C']);
    // a quit before the IndexedDB commit: only the synchronous journal was written
    c.journal([['B', note('B', '2026-05-01T00:00:00.000Z', { body: 'edited' })], ['N', note('N')], ['C', null]]);
    c.close();
    const c2 = await open();
    const all = await c2.readAll();
    expect(ids(all)).toEqual(['N', 'A', 'B']);   // the new note first, deleted C gone
    expect(all.find((n) => n.id === 'B').body).toBe('edited');
    expect(localStorage.getItem(JOURNAL_KEY)).toBeNull();
    c2.close();
    expect(ids(await (await open()).readAll())).toEqual(['N', 'A', 'B']);   // and it is now in IndexedDB itself
  });
  it('ignores a journal entry older than the stored note', async () => {
    const c = await open();
    c.journal([['A', note('A', '2026-01-01T00:00:00.000Z', { body: 'old' })]]);
    await c.replaceAll([note('A', '2026-06-01T00:00:00.000Z', { body: 'new' })]);   // a commit that predates the settle
    localStorage.setItem(JOURNAL_KEY, JSON.stringify({ A: { seq: 1, note: note('A', '2026-01-01T00:00:00.000Z', { body: 'old' }) } }));
    c.close();
    const all = await (await open()).readAll();
    expect(all[0].body).toBe('new');
    expect(localStorage.getItem(JOURNAL_KEY)).toBeNull();
  });
  it('rolls back a journal batch whose write fails, so later small batches still persist', async () => {
    const store = new Map(), failBig = { on: true };
    const storage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null), removeItem: (k) => store.delete(k),
      setItem: (k, v) => { if (failBig.on && v.length > 2000) throw new Error('quota'); store.set(k, v); },
    };
    const c = await openNoteCache({ idb, storage });
    const big = Array.from({ length: 30 }, (_, i) => ['I' + i, note('I' + i, undefined, { body: 'x'.repeat(200) })]);
    expect(c.journal(big)).toBe(false);
    expect(store.has(JOURNAL_KEY)).toBe(false);
    expect(c.journal([['E', note('E')]])).toBe(true);
    expect(Object.keys(JSON.parse(store.get(JOURNAL_KEY)))).toEqual(['E']);
  });
});

describe('changedIds (adopt journaling)', () => {
  it('lists only notes adopt adds or changes in content, never fresh copies of unchanged ones', () => {
    const prev = [note('A'), note('B'), note('C'), note('D')];
    const next = [
      { ...note('A') },                                   // a fresh disk copy, same content
      note('B', '2026-02-01T00:00:00.000Z'),              // newer
      { ...note('C'), tags: ['a', 'b'] },                 // retagged
      { ...note('D'), _path: 'moved.md', _flushed: 'x' }, // local sync state only
      note('N'),                                          // added
    ];
    expect(changedIds(prev, next)).toEqual(['B', 'C', 'N']);
    for (const k of ['title', 'body', 'folder', 'created']) expect(changedIds([note('A')], [{ ...note('A'), [k]: 'other' }])).toEqual(['A']);
    expect(changedIds([], [])).toEqual([]);
  });
  it('an adopted import journaled this way survives a quit before the IndexedDB commit', async () => {
    const c = await open();
    await c.write([note('A')], [], ['A']);
    const prev = [note('A')], next = [note('A'), note('I1'), note('I2')];
    const live = new Map(next.map((n) => [n.id, n]));
    expect(c.journal(changedIds(prev, next).map((id) => [id, live.get(id)]))).toBe(true);
    c.close();   // the quit: replaceAll never ran
    expect(ids(await (await open()).readAll()).sort()).toEqual(['A', 'I1', 'I2']);
  });
});

describe('bootNotes', () => {
  const boot = () => bootNotes({ idb, storage: localStorage });
  it('migrates the legacy localStorage vault once, verified, then removes the key', async () => {
    const legacy = [note('Z'), note('B'), note('M')];
    saveNotes(legacy);
    const r = await boot();
    expect(r.cache).toBeInstanceOf(NoteCache);
    expect(ids(r.notes)).toEqual(['Z', 'B', 'M']);
    expect(hasLegacyNotes()).toBe(false);
    expect(await r.cache.count()).toBe(legacy.length);
    r.cache.close();
    const again = await boot();
    expect(ids(again.notes)).toEqual(['Z', 'B', 'M']);   // order survives a relaunch
  });
  // the legacy key is only written by a fallback session (IndexedDB unavailable or unreadable), so it is
  // newer than a non-empty store: it replaces the store, and a note deleted in that session stays deleted
  const metaRecords = async () => {
    const db = await new Promise((res) => { const r = idb.open('arf-cache'); r.onsuccess = () => res(r.result); });
    const st = db.transaction('meta').objectStore('meta');
    const [keys, vals] = await Promise.all([st.getAllKeys(), st.getAll()].map((q) => new Promise((res) => { q.onsuccess = () => res(q.result); })));
    db.close();
    return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  };
  it('lets a legacy value replace a non-empty store instead of resurrecting notes deleted in the fallback session', async () => {
    const c = await open();
    await c.write([note('A', '2026-02-01T00:00:00.000Z', { body: 'idb, before the fallback session' }), note('B'), note('X', '2026-01-01T00:00:00.000Z', { body: 'deleted in the fallback session' })], [], ['A', 'B', 'X']);
    c.close();
    saveNotes([note('L'), note('A', '2026-01-01T00:00:00.000Z', { body: 'legacy' }), note('B', '2026-03-01T00:00:00.000Z', { body: 'legacy newer' })]);
    const r = await boot();
    expect(ids(r.notes)).toEqual(['L', 'A', 'B']);
    expect(r.notes.map((n) => n.body)).toEqual(['body L', 'legacy', 'legacy newer']);
    expect(hasLegacyNotes()).toBe(false);
    expect(ids(await r.cache.readAll())).toEqual(['L', 'A', 'B']);
    // the store-only note is not resurrected, but it is kept recoverable in the cache's meta store
    const meta = await metaRecords();
    const backups = Object.keys(meta).filter((k) => String(k).startsWith('legacy-replaced-'));
    expect(backups).toHaveLength(1);
    expect(ids(meta[backups[0]].notes)).toEqual(['X']);
    expect(r.recovered.replaced).toBe(backups[0]);
  });
  it('replays the journal before the legacy list replaces the store', async () => {
    const c = await open();
    await c.write([note('A')], [], ['A']);
    c.journal([['J', note('J')]]);   // a creation whose IndexedDB commit never landed
    c.close();
    saveNotes([note('A', '2026-05-01T00:00:00.000Z')]);
    const r = await boot();
    expect(ids(r.notes)).toEqual(['A']);
    expect(localStorage.getItem(JOURNAL_KEY)).toBeNull();
    const meta = await metaRecords();
    expect(ids(meta[r.recovered.replaced].notes)).toEqual(['J']);
  });
  it('keeps the newest of duplicate-id legacy entries and backs the others up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    saveNotes([note('A', '2026-01-01T00:00:00.000Z', { body: 'old A' }), note('B'), note('A', '2026-04-01T00:00:00.000Z', { body: 'new A' }), note('A', '2026-02-01T00:00:00.000Z', { body: 'mid A' })]);
    const r = await boot();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(r.cache).toBeInstanceOf(NoteCache);
    expect(ids(r.notes)).toEqual(['A', 'B']);
    expect(r.notes[0].body).toBe('new A');
    expect(hasLegacyNotes()).toBe(false);
    const dupes = JSON.parse(localStorage.getItem(r.recovered.duplicates));
    expect(dupes.map((n) => n.body)).toEqual(['old A', 'mid A']);
  });
  it('keeps the legacy path when the duplicate backup cannot be written', async () => {
    saveNotes([note('A', '2026-01-01T00:00:00.000Z'), note('A', '2026-04-01T00:00:00.000Z')]);
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (k, v) { if (k.includes('-dupes-')) throw new Error('quota'); return real.call(this, k, v); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await boot();
    spy.mockRestore(); warn.mockRestore();
    expect(r.cache).toBeNull();
    expect(r.notes).toHaveLength(2);
    expect(hasLegacyNotes()).toBe(true);
  });
  it('keeps the legacy key and uses the legacy path when the migration write fails', async () => {
    saveNotes([note('A')]);
    const spy = vi.spyOn(NoteCache.prototype, 'replaceAll').mockResolvedValue(false);
    const r = await boot();
    spy.mockRestore();
    expect(r.cache).toBeNull();
    expect(ids(r.notes)).toEqual(['A']);
    expect(hasLegacyNotes()).toBe(true);
    const c = await open();
    expect(await c.count()).toBe(0);   // nothing half-written, so the next launch retries cleanly
  });
  it('does not migrate entries the store cannot key', async () => {
    saveNotes([note('A'), { title: 'no id' }]);
    const r = await boot();
    expect(r.cache).toBeNull();
    expect(r.notes).toHaveLength(2);
    expect(hasLegacyNotes()).toBe(true);
  });
  it('removes a corrupt legacy value only after it is backed up', async () => {
    localStorage.setItem(LEGACY, 'not json{');
    const r = await boot();
    expect(r.cache).toBeInstanceOf(NoteCache);
    expect(r.notes).toEqual([]);
    expect(hasLegacyNotes()).toBe(false);
    expect(localStorage.getItem(corruptBackupKey())).toBe('not json{');
  });
  it('falls back to localStorage when IndexedDB is unavailable', async () => {
    saveNotes([note('A')]);
    const r = await bootNotes({ idb: null, storage: localStorage });
    expect(r.cache).toBeNull();
    expect(ids(r.notes)).toEqual(['A']);
    expect(hasLegacyNotes()).toBe(true);
  });
  it('flags a failed read so the caller does not seed over it', async () => {
    const spy = vi.spyOn(NoteCache.prototype, 'readAll').mockRejectedValue(new Error('read failed'));
    const r = await boot();
    spy.mockRestore();
    expect(r).toMatchObject({ cache: null, readFailed: true, notes: [] });
  });
  it('returns an empty cache on a first run', async () => {
    const r = await boot();
    expect(r.cache).toBeInstanceOf(NoteCache);
    expect(r.notes).toEqual([]);
    expect(r.readFailed).toBe(false);
  });
});
