import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// the runtime manifest vite.config.js injects in a real build (names as Transformers.js requests them)
const RT = vi.hoisted(() => {
  const rt = { version: '9.9.9', files: { 'ort-wasm-simd-threaded.asyncify.mjs': 'sha384-a', 'ort-wasm-simd-threaded.asyncify.wasm': 'sha384-b', 'ort-wasm-simd-threaded.mjs': 'sha384-c', 'ort-wasm-simd-threaded.wasm': 'sha384-d' } };
  globalThis.__ORT_RUNTIME__ = rt;
  return rt;
});
import { download, cancelDownload, isDownloading, isDownloaded, downloadedSet, runtimeCached, remove, cacheTag, normSpec, modelRevision, initEmbedder, activeSpec } from '../../src/lib/ml.js';
import { TF_CACHE, REQUIRED_FILES, resolveUrl, ORT_CDN, ORT_RUNTIME, HF_HOST } from '../../src/lib/models.js';

// A fake download worker: on a fetch-only init it reports per-file then aggregated progress, then 'fetched'
// (or an error for a repo named */missing). Every created worker is kept so termination can be checked.
const workers = [];
class FakeWorker {
  constructor() { this.terminated = false; workers.push(this); }
  postMessage(m) {
    this.last = m;
    if (m.type !== 'init' || !m.fetchOnly || m.model.endsWith('/hang')) return;
    const send = (data) => setTimeout(() => !this.terminated && this.onmessage({ data }), 0);
    if (m.model.endsWith('/missing')) return send({ type: 'error', error: 'Unauthorized access to file: 401' });
    send({ type: 'progress', file: 'config.json', pct: 100 });
    send({ type: 'progress', total: true, pct: 40, loaded: 40, size: 100 });
    send({ type: 'progress', file: 'onnx/model_quantized.onnx', pct: 10 });   // superseded by the aggregate
    send({ type: 'progress', total: true, pct: 100, loaded: 100, size: 100 });
    send({ type: 'fetched' });
  }
  terminate() { this.terminated = true; }
}

// minimal Cache Storage: one named cache of url -> true
const store = new Map();
const cacheApi = {
  keys: async () => [...store.keys()].map((url) => ({ url })),
  delete: async (req) => store.delete(req.url),
};
let opened = [];
const ls = new Map();
const SHA = (c) => c.repeat(40);
// Hub API: every repo is at commit aaaa..., except 'gone/*' (401)
const apiCalls = [];
const fakeFetch = vi.fn(async (url) => {
  apiCalls.push(url);
  if (url.includes('/api/models/gone/')) return { ok: false, status: 401, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => ({ id: url.split('/api/models/')[1], sha: SHA('a') }) };
});
beforeAll(() => {
  globalThis.Worker = FakeWorker;
  globalThis.caches = { open: async (name) => { opened.push(name); return cacheApi; } };
  globalThis.localStorage = { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k) };
  globalThis.fetch = fakeFetch;
});
afterEach(() => { store.clear(); ls.clear(); opened = []; workers.length = 0; apiCalls.length = 0; });

describe('download without activating', () => {
  it('reads the repo commit, fetches the files at that commit, records it, and terminates its worker', async () => {
    const seen = [];
    await expect(download('a/model', (p) => seen.push(p.pct))).resolves.toBe(true);
    expect(apiCalls).toEqual([HF_HOST + 'api/models/a/model']);
    expect(seen).toEqual([100, 40, 100]);   // per-file events stop once aggregated progress has arrived
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].last).toMatchObject({ type: 'init', model: 'a/model', fetchOnly: true, device: 'wasm', dtype: 'q8', pooling: 'mean', revision: SHA('a') });
    expect(modelRevision('a/model')).toBe(SHA('a'));
    expect(isDownloading('a/model')).toBe(false);
  });
  it('rejects with the worker error and records no revision', async () => {
    await expect(download('a/missing')).rejects.toThrow('401');
    expect(workers[0].terminated).toBe(true);
    expect(modelRevision('a/missing')).toBeNull();
  });
  it('a repo the Hub does not show fails before any worker starts', async () => {
    await expect(download('gone/model')).rejects.toThrow('Not found, or not public yet');
    expect(workers).toHaveLength(0);
  });
  it('cancel rejects, terminates, and frees the slot', async () => {
    const p = download('a/hang');
    expect(isDownloading('a/hang')).toBe(true);
    expect(download('a/hang')).toBe(p);     // a second request joins the first
    await new Promise((r) => setTimeout(r, 0));
    cancelDownload('a/hang');
    await expect(p).rejects.toThrow('cancelled');
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(true);
    expect(isDownloading('a/hang')).toBe(false);
  });
  it('cancel during the revision lookup starts no worker', async () => {
    const p = download('a/early');
    cancelDownload('a/early');
    await expect(p).rejects.toThrow('cancelled');
    await new Promise((r) => setTimeout(r, 5));
    expect(workers).toHaveLength(0);
  });
});

describe('cached files', () => {
  const put = (id, files = REQUIRED_FILES, rev = 'main') => files.forEach((f) => store.set(resolveUrl(id, f, rev), true));
  const putRuntime = (stem = 'ort-wasm-simd-threaded.asyncify', exts = ['mjs', 'wasm']) => exts.forEach((e) => store.set(ORT_CDN + stem + '.' + e, true));
  it('the runtime manifest comes from the build define', () => {
    expect(ORT_RUNTIME).toBe(RT);
    expect(ORT_CDN).toBe('https://cdn.jsdelivr.net/npm/onnxruntime-web@9.9.9/dist/');
  });
  it('isDownloaded / downloadedSet need the model files and a complete runtime', async () => {
    put('tunabirgun/ArfLLM_Multi');
    put('tunabirgun/ArfLLM', REQUIRED_FILES.slice(0, 2));   // incomplete
    expect(await isDownloaded('tunabirgun/ArfLLM_Multi')).toBe(false);   // no runtime yet
    putRuntime('ort-wasm-simd-threaded.asyncify', ['wasm']);
    expect(await isDownloaded('tunabirgun/ArfLLM_Multi')).toBe(false);   // half a runtime
    expect(await runtimeCached()).toBe(false);
    putRuntime('ort-wasm-simd-threaded.asyncify');
    expect(await runtimeCached()).toBe(true);
    expect(await isDownloaded('tunabirgun/ArfLLM_Multi')).toBe(true);
    expect(await isDownloaded('tunabirgun/ArfLLM')).toBe(false);
    expect([...await downloadedSet(['tunabirgun/ArfLLM', 'tunabirgun/ArfLLM_Multi'])]).toEqual(['tunabirgun/ArfLLM_Multi']);
    expect(new Set(opened)).toEqual(new Set([TF_CACHE]));
  });
  it('the plain (non-asyncify) runtime variant counts too', async () => {
    put('a/b'); putRuntime('ort-wasm-simd-threaded');
    expect(await isDownloaded('a/b')).toBe(true);
  });
  it('a model with a recorded revision is present only with the files at that commit', async () => {
    await download('a/pinned');
    putRuntime(); put('a/pinned');                        // files at main: not the recorded commit
    expect(await isDownloaded('a/pinned')).toBe(false);
    put('a/pinned', REQUIRED_FILES, SHA('a'));
    expect(await isDownloaded('a/pinned')).toBe(true);
  });
  it('remove deletes every revision of that repo and its revision record, keeping the other repo and the runtime', async () => {
    await download('tunabirgun/ArfLLM');
    put('tunabirgun/ArfLLM'); put('tunabirgun/ArfLLM', REQUIRED_FILES, SHA('a')); put('tunabirgun/ArfLLM_Multi'); putRuntime();
    expect(await remove('tunabirgun/ArfLLM')).toBe(2 * REQUIRED_FILES.length);
    expect(modelRevision('tunabirgun/ArfLLM')).toBeNull();
    expect(await isDownloaded('tunabirgun/ArfLLM')).toBe(false);
    expect(await isDownloaded('tunabirgun/ArfLLM_Multi')).toBe(true);
    expect(store.has(ORT_CDN + 'ort-wasm-simd-threaded.asyncify.wasm')).toBe(true);
  });
});

describe('embedding spaces', () => {
  it('keeps the plain key for mean pooling without a prefix or revision, and separates everything else', () => {
    expect(cacheTag('Xenova/all-MiniLM-L6-v2')).toBe('Xenova/all-MiniLM-L6-v2:q8');
    expect(cacheTag({ model: 'x/y', pooling: 'mean', prefix: '', dtype: 'q8' })).toBe('x/y:q8');
    const tags = new Set([cacheTag('x/y'), cacheTag({ model: 'x/y', pooling: 'cls' }), cacheTag({ model: 'x/y', prefix: 'passage: ' }), cacheTag('x/z'),
      cacheTag({ model: 'x/y', revision: SHA('a') }), cacheTag({ model: 'x/y', revision: SHA('b') })]);
    expect(tags.size).toBe(6);
    for (const t of tags) expect(t.startsWith('x/y:') || t.startsWith('x/z:')).toBe(true);
    expect(normSpec('x/y')).toEqual({ model: 'x/y', pooling: 'mean', prefix: '', dtype: 'q8', revision: null });
  });
  it('initEmbedder takes the recorded revision, so updated weights get a new space', async () => {
    initEmbedder(() => {}, 'r/m');
    expect(activeSpec().revision).toBeNull();
    const active = workers.at(-1);
    expect(active.last).toMatchObject({ type: 'init', model: 'r/m', revision: 'main' });
    await download('r/m');
    initEmbedder(() => {}, 'r/m');
    expect(activeSpec().revision).toBe(SHA('a'));
    expect(cacheTag(activeSpec())).toBe('r/m:q8@' + SHA('a'));
    expect(active.last).toMatchObject({ type: 'init', model: 'r/m', revision: SHA('a') });
  });
});
