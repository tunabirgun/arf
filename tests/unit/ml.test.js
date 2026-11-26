import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { embedNotes, clearEmbedCaches, initEmbedder, resetEmbedder, embedGeneration, contentHash, cosine, cacheTag, remove, StaleRunError } from '../../src/lib/ml.js';

// Stub the embedder worker: embed() posts to it, so the real request/response path is exercised.
// The vector is a pure function of the text, so any result can be checked against it directly.
const embedCalls = [];
const fakeVec = (text) => { const v = [0, 0, 0, 0]; for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i); const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
let onEmbed = null;   // test hook: runs when the worker receives an embed request
class FakeWorker {
  postMessage(m) {
    if (m.type !== 'embed') return;
    embedCalls.push(m.texts.slice());
    if (onEmbed) onEmbed(m);
    setTimeout(() => this.onmessage({ data: { type: 'embedded', id: m.id, vectors: m.texts.map(fakeVec) } }), 0);
  }
  terminate() {}
}
beforeAll(() => { globalThis.Worker = FakeWorker; });

const textOf = (n) => n.title + '\n' + n.body;
const mkNotes = (count) => Array.from({ length: count }, (_, i) => ({ id: 'n' + i, title: 'T' + i, body: 'body number ' + i + ' ' + 'x'.repeat(i % 7) }));
const expected = (notes) => Object.fromEntries(notes.map((n) => [n.id, fakeVec(textOf(n).slice(0, 4000))]));

// direct view of the persistent store, to clear it between tests and to wait for fire-and-forget puts
function withStore(mode, fn) {
  return new Promise((res, rej) => {
    const r = indexedDB.open('arf-embed', 2);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('vecs')) r.result.createObjectStore('vecs'); };
    r.onerror = () => rej(r.error);
    r.onsuccess = () => { const db = r.result, tx = db.transaction('vecs', mode), out = fn(tx.objectStore('vecs')); tx.oncomplete = () => { db.close(); res(out && out.result); }; };
  });
}
const clearStore = () => withStore('readwrite', (s) => s.clear());
async function storedCount(want) {
  for (let i = 0; i < 200; i++) { const c = await withStore('readonly', (s) => s.count()); if (c >= want) return c; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('store never reached ' + want);
}

let readTx, digest;
beforeEach(async () => {
  embedCalls.length = 0; clearEmbedCaches(); await clearStore();
  readTx = vi.spyOn(IDBDatabase.prototype, 'transaction');
  digest = vi.spyOn(crypto.subtle, 'digest');
});
afterEach(() => { vi.restoreAllMocks(); onEmbed = null; });
const readonlyTx = () => readTx.mock.calls.filter((c) => c[1] === 'readonly').length;

describe('embedNotes fast path', () => {
  it('returns exactly the embedding of each note, cold or warm', async () => {
    const notes = mkNotes(70);
    const cold = await embedNotes(notes, textOf);
    expect(cold).toEqual(expected(notes));
    expect(embedCalls.flat()).toHaveLength(70);
    expect(embedCalls.map((c) => c.length)).toEqual([32, 32, 6]); // bounded chunks, unchanged
    await storedCount(70);
    embedCalls.length = 0;
    expect(await embedNotes(notes, textOf)).toEqual(cold);       // memory warm
    clearEmbedCaches();
    expect(await embedNotes(notes, textOf)).toEqual(cold);       // memory cold, IndexedDB warm
    expect(embedCalls).toHaveLength(0);
  });

  it('reads all IndexedDB misses in one readonly transaction, and none when memory is warm', async () => {
    const notes = mkNotes(200);
    await embedNotes(notes, textOf); await storedCount(200);
    clearEmbedCaches(); readTx.mockClear();
    const r = await embedNotes(notes, textOf);
    expect(r).toEqual(expected(notes));
    expect(readonlyTx()).toBe(1);
    readTx.mockClear();
    await embedNotes(notes, textOf);
    expect(readonlyTx()).toBe(0);
    expect(embedCalls.flat()).toHaveLength(200);                 // nothing re-embedded after the first run
  });

  it('re-hashes and re-embeds only the note whose text changed', async () => {
    const notes = mkNotes(40);
    await embedNotes(notes, textOf); await storedCount(40);
    embedCalls.length = 0; digest.mockClear();
    await embedNotes(notes, textOf);
    expect(digest).not.toHaveBeenCalled();                       // hash memo hit for every note
    notes[5].body += ' edited';
    const r = await embedNotes(notes, textOf);
    expect(digest).toHaveBeenCalledTimes(1);
    expect(embedCalls).toEqual([[textOf(notes[5])]]);
    expect(r).toEqual(expected(notes));
    expect(r.n5).not.toEqual(fakeVec(textOf(mkNotes(40)[5])));   // the stale vector is not served
  });

  it('serves a deleted-then-restored note from IndexedDB without re-embedding', async () => {
    const notes = mkNotes(10);
    await embedNotes(notes, textOf); await storedCount(10);
    const rest = notes.slice(1);
    await embedNotes(rest, textOf);                              // prunes n0's memo entries
    embedCalls.length = 0; readTx.mockClear();
    const r = await embedNotes(notes, textOf);
    expect(r).toEqual(expected(notes));
    expect(embedCalls).toHaveLength(0);
    expect(readonlyTx()).toBe(1);
  });

  it('handles notes with identical text, empty text, and text over the 4000-char cap', async () => {
    const notes = [
      { id: 'a', title: 'same', body: 'same body' }, { id: 'b', title: 'same', body: 'same body' },
      { id: 'c', title: '', body: '' }, { id: 'd', title: 'long', body: 'y'.repeat(9000) }, { id: 'e', title: 'long', body: 'y'.repeat(9000) + 'tail ignored' },
    ];
    const r1 = await embedNotes(notes, textOf);
    expect(r1).toEqual(expected(notes));
    await storedCount(3);
    clearEmbedCaches();
    expect(await embedNotes(notes, textOf)).toEqual(r1);
    expect(Object.keys(r1)).toEqual(notes.map((n) => n.id));
  });

  it('keeps models in separate cache spaces and recovers after clearEmbedCaches', async () => {
    const notes = mkNotes(6);
    await embedNotes(notes, textOf); await storedCount(6);
    embedCalls.length = 0;
    initEmbedder(() => {}, 'other/model');                       // different model => different content hashes
    const r = await embedNotes(notes, textOf);
    expect(embedCalls.flat()).toHaveLength(6);
    expect(r).toEqual(expected(notes));
    initEmbedder(() => {}, 'Xenova/all-MiniLM-L6-v2');           // back: first model's vectors still in IndexedDB
    embedCalls.length = 0; clearEmbedCaches();
    await embedNotes(notes, textOf);
    expect(embedCalls).toHaveLength(0);
  });

  it('hashes and cosine are unchanged helpers', async () => {
    expect(await contentHash('abc')).toBe(await contentHash('abc'));
    expect(await contentHash('abc')).toMatch(/^[0-9a-f]{24}$/);
    expect(cosine([1, 0], [1, 0])).toBe(1);
  });
});

describe('model switches and removal', () => {
  const L6 = 'Xenova/all-MiniLM-L6-v2';
  const storedKeys = () => withStore('readonly', (s) => s.getAllKeys());
  it('stores vectors under their tag, one key range per model', async () => {
    initEmbedder(() => {}, L6);
    await embedNotes(mkNotes(3), textOf); await storedCount(3);
    const keys = await storedKeys();
    expect(keys).toHaveLength(3);
    for (const k of keys) expect(k.startsWith(cacheTag(L6) + '\n')).toBe(true);
  });
  it('a run overtaken by a model switch rejects as stale and caches nothing from the new worker', async () => {
    initEmbedder(() => {}, L6);
    const notes = mkNotes(40);
    onEmbed = () => { onEmbed = null; initEmbedder(() => {}, 'other/model'); };   // switch while the first chunk is in flight
    const g = embedGeneration();
    const err = await embedNotes(notes, textOf).catch((e) => e);
    expect(err).toBeInstanceOf(StaleRunError);
    expect(err.stale).toBe(true);
    expect(embedGeneration()).toBe(g + 1);
    expect(embedCalls).toHaveLength(1);                           // the second chunk was never posted
    await new Promise((r) => setTimeout(r, 20));
    expect(await withStore('readonly', (s) => s.count())).toBe(0);  // nor was the first chunk cached
  });
  it('resetEmbedder also invalidates a run waiting on hashing', async () => {
    initEmbedder(() => {}, L6);
    const p = embedNotes(mkNotes(5), textOf);
    resetEmbedder();
    await expect(p).rejects.toBeInstanceOf(StaleRunError);
    expect(embedCalls).toHaveLength(0);
  });
  it('remove() deletes only that model\'s vectors, every tag of it', async () => {
    const notes = mkNotes(4);
    initEmbedder(() => {}, L6); await embedNotes(notes, textOf);
    initEmbedder(() => {}, { model: L6, pooling: 'cls' }); await embedNotes(notes, textOf);
    initEmbedder(() => {}, 'other/model'); await embedNotes(notes, textOf);
    await storedCount(12);
    await remove(L6);
    const keys = await storedKeys();
    expect(keys).toHaveLength(4);
    for (const k of keys) expect(k.startsWith('other/model:')).toBe(true);
    embedCalls.length = 0;
    initEmbedder(() => {}, L6);
    await embedNotes(notes, textOf);
    expect(embedCalls.flat()).toHaveLength(4);                    // nothing served from memory either
  });
});
