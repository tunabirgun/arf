import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MODELS, RECOMMENDED_ID, TF_CACHE, HF_HOST, MODEL_FILE, REQUIRED_FILES, resolveUrl, matchesRepo, repoFilesPresent,
  customEntry, findModel, applyCalibration, migrateModelKey, LEGACY_KEYS, adaptiveThresholds, quantile, ADAPTIVE,
  poolingFromConfig, repoInfo, validateRepo, runtimePresent, cleanPrefix, MIN_PAIRS, MIN_NOTES, contentChars, DENSE_ERROR,
} from '../../src/lib/models.js';

const byId = (id) => MODELS.find((m) => m.id === id);
const L6 = 'Xenova/all-MiniLM-L6-v2', L12 = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';

describe('model registry', () => {
  it('lists the two Arf models first, then the two originals, all 384-d mean pooling q8', () => {
    expect(MODELS.map((m) => m.id)).toEqual(['tunabirgun/ArfLLM', 'tunabirgun/ArfLLM_Multi', L6, L12]);
    for (const m of MODELS) { expect(m.dims).toBe(384); expect(m.pooling).toBe('mean'); expect(m.prefix).toEqual({ query: '', passage: '' }); }
    expect(new Set(MODELS.map((m) => m.key)).size).toBe(MODELS.length);
  });
  it('recommends the calibrated English ArfLLM, and only a calibrated entry', () => {
    expect(MODELS.filter((m) => m.recommended).map((m) => m.id)).toEqual(['tunabirgun/ArfLLM']);
    expect(RECOMMENDED_ID).toBe('tunabirgun/ArfLLM');   // English default; ArfLLM_Multi is offered for non-English notes
    expect(byId(RECOMMENDED_ID).thresholds.calibrated).toBe(true);
    expect(MODELS.map((m) => m.id)).toContain('tunabirgun/ArfLLM');   // still listed
  });
  it('derives MB from the recorded bytes for every listed model', () => {
    for (const m of [byId('tunabirgun/ArfLLM'), byId('tunabirgun/ArfLLM_Multi'), byId(L6), byId(L12)]) {
      expect(m.sizeMB).toBe(Math.round(m.q8Bytes / 1e5) / 10);
      expect(m.fileBytes).toBeGreaterThan(m.q8Bytes);
    }
  });
  it('describes the Arf models without quality claims', () => {
    for (const m of MODELS.slice(0, 2)) expect(m.description).not.toMatch(/fine-?tun|improv|better|optimi[sz]|best|state.of/i);
  });
  it('carries measured cut-offs from model-thresholds.json and Arf\'s originals for the base English model', () => {
    const file = JSON.parse(readFileSync(new URL('../../src/lib/model-thresholds.json', import.meta.url), 'utf8'));
    expect(Object.keys(file).sort()).toEqual(['Xenova/paraphrase-multilingual-MiniLM-L12-v2', 'tunabirgun/ArfLLM', 'tunabirgun/ArfLLM_Multi']);
    for (const [id, t] of Object.entries(file)) expect(byId(id).thresholds).toEqual({ resonance: t.resonance, synthesis: t.synthesis, calibrated: true });
    for (const t of Object.values(file)) expect(0 < t.resonance && t.resonance < t.synthesis && t.synthesis < 1).toBe(true);   // values come from the calibration run, not this test
    expect(byId(L6).thresholds).toEqual({ resonance: 0.28, synthesis: 0.45, calibrated: true });
  });
  it('builds custom entries with adaptive thresholds and finds them by id', () => {
    const c = customEntry({ id: 'someone/embed-small', pooling: 'cls', q8Bytes: 3.2e7 });
    expect(c).toMatchObject({ name: 'embed-small', pooling: 'cls', sizeMB: 32, custom: true, icon: 'model-add' });
    expect(c.thresholds.calibrated).toBe(false);
    expect(findModel('someone/embed-small', [{ id: 'someone/embed-small' }]).custom).toBe(true);
    expect(findModel(L6).name).toBe('all-MiniLM-L6-v2');
    expect(findModel('nobody/none')).toBeNull();
    expect(c.prefix).toEqual({ query: '', passage: '' });
    expect(customEntry({ id: 'x/e5', prefix: 'passage: ' }).prefix).toEqual({ query: '', passage: 'passage: ' });
    expect(cleanPrefix('a\nb' + 'x'.repeat(100))).toHaveLength(64);
    expect(cleanPrefix('a\nb')).toBe('a b');
    expect(cleanPrefix(null)).toBe('');
  });
});

describe('applyCalibration', () => {
  const copy = () => MODELS.map((m) => ({ ...m, thresholds: { ...m.thresholds } }));
  it('fills valid thresholds and marks them calibrated', () => {
    const ms = copy();
    expect(applyCalibration({ 'tunabirgun/ArfLLM': { resonance: 0.31, synthesis: 0.52 } }, ms)).toEqual(['tunabirgun/ArfLLM']);
    expect(ms[0].thresholds).toEqual({ resonance: 0.31, synthesis: 0.52, calibrated: true });
    expect(MODELS[0].thresholds.resonance).not.toBe(0.31);   // the shipped registry is untouched
  });
  it('skips unknown ids and out-of-order or non-numeric values', () => {
    const ms = copy();
    expect(applyCalibration({ 'x/y': { resonance: 0.2, synthesis: 0.3 }, 'tunabirgun/ArfLLM': { resonance: 0.6, synthesis: 0.5 }, 'tunabirgun/ArfLLM_Multi': { resonance: 'a', synthesis: 1 } }, ms)).toEqual([]);
    expect(applyCalibration(null, ms)).toEqual([]);
  });
  it('the shipped thresholds file is a JSON object', () => {
    const j = JSON.parse(readFileSync(new URL('../../src/lib/model-thresholds.json', import.meta.url), 'utf8'));
    expect(j && typeof j === 'object' && !Array.isArray(j)).toBe(true);
  });
});

describe('migrateModelKey', () => {
  it('maps the pre-3.0 keys to their Xenova ids', () => {
    expect(migrateModelKey('en', '1')).toBe(L6);
    expect(migrateModelKey('multi', '0')).toBe(L12);
    expect(LEGACY_KEYS).toEqual({ en: L6, multi: L12 });
  });
  it('an old user without arf-mlmodel ran the English MiniLM', () => {
    expect(migrateModelKey(null, '1')).toBe(L6);
    expect(migrateModelKey(null, '0')).toBe(L6);
  });
  it('a fresh profile gets no model; repo ids pass through; junk is dropped', () => {
    expect(migrateModelKey(null, null)).toBeNull();
    expect(migrateModelKey('tunabirgun/ArfLLM_Multi', '1')).toBe('tunabirgun/ArfLLM_Multi');
    expect(migrateModelKey('not a repo', null)).toBeNull();
  });
});

describe('adaptive thresholds', () => {
  const unit = (a) => { const n = Math.hypot(a, 1); return [a / n, 1 / n]; };
  const ring = (n, f = (i) => Math.sin(i * 1.7) * 3) => { const v = {}; for (let i = 0; i < n; i++) v['n' + String(i).padStart(3, '0')] = unit(f(i)); return v; };
  const allPairs = (vecs) => { const ids = Object.keys(vecs).sort(), s = []; for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) s.push(vecs[ids[i]][0] * vecs[ids[j]][0] + vecs[ids[i]][1] * vecs[ids[j]][1]); return s.sort((a, b) => a - b); };
  it('quantile uses linear interpolation (type 7)', () => {
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12);
    expect(quantile([1, 2, 3, 4], 0.99)).toBeCloseTo(3.97, 12);
    expect(quantile([5], 0.9)).toBe(5);
    expect(quantile([], 0.9)).toBeNull();
  });
  it('the minimum sample is derived: minAbove pairs above the Synthesis quantile', () => {
    expect(MIN_PAIRS).toBe(Math.round(ADAPTIVE.minAbove / (1 - ADAPTIVE.synthesisQ)));
    expect(MIN_PAIRS).toBe(400);
    expect((MIN_NOTES * (MIN_NOTES - 1)) / 2).toBeGreaterThanOrEqual(MIN_PAIRS);
    expect(((MIN_NOTES - 1) * (MIN_NOTES - 2)) / 2).toBeLessThan(MIN_PAIRS);
    expect(MIN_NOTES).toBe(29);
  });
  it('returns null below the minimum, so the caller falls back to TF-IDF', () => {
    expect(adaptiveThresholds({})).toBeNull();
    expect(adaptiveThresholds({ a: [1, 0], b: [0, 1] })).toBeNull();
    expect(adaptiveThresholds(ring(MIN_NOTES - 1))).toBeNull();
    expect(adaptiveThresholds({ ...ring(MIN_NOTES - 1), x: null })).toBeNull();
    expect(adaptiveThresholds(ring(MIN_NOTES))).not.toBeNull();
  });
  it('enumerates every pair of a mid-size vault and takes the 0.90 / 0.99 quantiles', () => {
    const vecs = ring(40), sims = allPairs(vecs);     // 780 pairs <= maxPairs
    const t = adaptiveThresholds(vecs);
    expect(t.pairs).toBe(780);
    expect(t.notes).toBe(40);
    expect(t.resonance).toBeCloseTo(Math.max(0, quantile(sims, 0.9)), 12);
    expect(t.synthesis).toBeCloseTo(Math.max(0, quantile(sims, 0.99)), 12);
    expect(t.calibrated).toBe(false);
  });
  it('samples a seeded, order-independent set of pairs on a large vault, never fewer than the minimum', () => {
    const vecs = ring(120);
    const t1 = adaptiveThresholds(vecs);
    const shuffled = Object.fromEntries(Object.entries(vecs).reverse());
    expect(adaptiveThresholds(shuffled)).toEqual(t1);
    expect(t1.pairs).toBe(ADAPTIVE.maxPairs);          // 120*119/2 = 7140 > 4000
    expect(t1.synthesis).toBeGreaterThanOrEqual(t1.resonance);
    expect(adaptiveThresholds(vecs, { seed: 7 })).not.toEqual(t1);
    expect(adaptiveThresholds(vecs, { maxPairs: 50 }).pairs).toBe(MIN_PAIRS);
  });
  it('leaves near-empty notes out of the sample when texts are supplied', () => {
    const vecs = ring(MIN_NOTES + 3), ids = Object.keys(vecs).sort();
    const long = 'a note with enough words to count';
    expect(contentChars(long)).toBeGreaterThanOrEqual(ADAPTIVE.minChars);
    expect(contentChars('İstanbul çay 2024')).toBe(15);     // letters and digits of any script
    const text = (id) => (ids.indexOf(id) < 4 ? 'Untitled\n' : long);
    expect(adaptiveThresholds(vecs, { textOf: text })).toBeNull();          // 4 stubs out: MIN_NOTES - 1 usable notes left
    expect(adaptiveThresholds(vecs, { textOf: () => long }).notes).toBe(MIN_NOTES + 3);
    expect(adaptiveThresholds(vecs).notes).toBe(MIN_NOTES + 3);            // no texts: nothing excluded
  });
  it('never goes below the floor: cosine 0 by default, or a supplied calibration-derived floor', () => {
    // regular simplex: 40 unit vectors with every pairwise cosine -1/39, so both raw quantiles are negative
    const n = 40, vecs = {};
    for (let i = 0; i < n; i++) { const v = Array.from({ length: n }, (_, k) => (k === i ? 1 : 0) - 1 / n), s = Math.hypot(...v); vecs['n' + i] = v.map((x) => x / s); }
    expect(vecs.n0.reduce((a, x, k) => a + x * vecs.n1[k], 0)).toBeCloseTo(-1 / (n - 1), 12);
    expect(adaptiveThresholds(vecs)).toMatchObject({ resonance: 0, synthesis: 0 });
    const raw = adaptiveThresholds(ring(40));
    const floored = adaptiveThresholds(ring(40), { floor: { resonance: 0.95, synthesis: 0.99 } });
    expect(floored.resonance).toBe(Math.max(raw.resonance, 0.95));
    expect(floored.synthesis).toBe(Math.max(raw.synthesis, 0.99));
  });
});

describe('custom repo validation', () => {
  const json = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const api = (extra = []) => ({ tags: ['license:mit'], siblings: [{ rfilename: 'config.json', size: 600 }, { rfilename: 'tokenizer.json', size: 7e5 }, { rfilename: 'tokenizer_config.json', size: 400 }, { rfilename: MODEL_FILE, size: 3.2e7 }, ...extra] });
  it('rejects a malformed id without a request', async () => {
    const f = vi.fn();
    expect(await repoInfo('no-slash', f)).toEqual({ ok: false, error: 'Use the form owner/name' });
    expect(await repoInfo('a/b/c', f)).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });
  it('treats 401 and 404 as missing or private', async () => {
    expect(await repoInfo('tunabirgun/ArfLLM', async () => json(401, { error: 'Invalid username or password.' }))).toEqual({ ok: false, error: 'Not found, or not public yet' });
    expect((await repoInfo('a/b', async () => json(404, {}))).error).toBe('Not found, or not public yet');
    expect((await repoInfo('a/b', async () => json(500, {}))).error).toBe('Hugging Face returned 500');
    expect((await repoInfo('a/b', async () => { throw new TypeError('offline'); })).error).toBe('Could not reach Hugging Face');
  });
  it('requires the q8 ONNX file and a tokenizer', async () => {
    const noOnnx = { siblings: [{ rfilename: 'tokenizer.json', size: 1 }] };
    expect((await repoInfo('a/b', async () => json(200, noOnnx))).error).toContain(MODEL_FILE);
    const noTok = { siblings: [{ rfilename: MODEL_FILE, size: 1 }] };
    expect((await repoInfo('a/b', async () => json(200, noTok))).error).toContain('tokenizer.json');
  });
  it('reports sizes, licence, and CLS pooling from 1_Pooling/config.json', async () => {
    const calls = [];
    const f = async (url) => {
      calls.push(url);
      if (url.includes('/api/models/')) return json(200, api([{ rfilename: '1_Pooling/config.json', size: 190 }]));
      return json(200, { word_embedding_dimension: 384, pooling_mode_cls_token: true, pooling_mode_mean_tokens: false });
    };
    const r = await validateRepo(' someone/bge-like ', f);
    expect(r).toMatchObject({ ok: true, id: 'someone/bge-like', q8Bytes: 3.2e7, fileBytes: 600 + 7e5 + 400 + 3.2e7, licence: 'mit', pooling: 'cls', dims: 384 });
    expect(calls).toEqual([HF_HOST + 'api/models/someone/bge-like?blobs=true', resolveUrl('someone/bge-like', '1_Pooling/config.json')]);
  });
  it('defaults to mean pooling when the repo has no pooling config', async () => {
    const f = vi.fn(async () => json(200, api()));
    expect(await validateRepo('a/b', f)).toMatchObject({ ok: true, pooling: 'mean', dims: null });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('poolingFromConfig: mean or CLS in either config form, everything else refused', () => {
    expect(poolingFromConfig({ pooling_mode_mean_tokens: true, word_embedding_dimension: 768 })).toEqual({ pooling: 'mean', dims: 768 });
    expect(poolingFromConfig({ pooling_mode: 'mean', embedding_dimension: 384, include_prompt: true })).toEqual({ pooling: 'mean', dims: 384 });
    expect(poolingFromConfig({ pooling_mode: 'cls', embedding_dimension: 1024 })).toEqual({ pooling: 'cls', dims: 1024 });
    expect(poolingFromConfig(null)).toEqual({ pooling: 'mean', dims: null });
    expect(poolingFromConfig({ word_embedding_dimension: 384 })).toEqual({ pooling: 'mean', dims: 384 });
    for (const cfg of [{ pooling_mode_max_tokens: true }, { pooling_mode_lasttoken: true }, { pooling_mode_weightedmean_tokens: true },
      { pooling_mode_mean_sqrt_len_tokens: true }, { pooling_mode_cls_token: true, pooling_mode_mean_tokens: true }, { pooling_mode: 'lasttoken' }, { pooling_mode: ['mean', 'max'] }]) {
      expect(poolingFromConfig(cfg).error).toMatch(/supports mean or CLS pooling only/);
      expect(poolingFromConfig(cfg).pooling).toBeUndefined();
    }
  });
  it('refuses a lasttoken repo and a repo with a Dense head (folder or modules.json)', async () => {
    const withPool = (cfg, extra = [], mods = null) => async (url) => {
      if (url.includes('/api/models/')) return json(200, api([{ rfilename: '1_Pooling/config.json', size: 100 }, ...extra]));
      if (url.endsWith('modules.json')) return json(200, mods);
      return json(200, cfg);
    };
    expect(await validateRepo('q/qwen-like', withPool({ pooling_mode_lasttoken: true }))).toEqual({ ok: false, error: 'Uses lasttoken pooling; Arf supports mean or CLS pooling only' });
    expect(await validateRepo('d/dense', withPool({ pooling_mode_mean_tokens: true }, [{ rfilename: '2_Dense/config.json', size: 10 }]))).toEqual({ ok: false, error: DENSE_ERROR });
    const mods = [{ idx: 0, path: '', type: 'sentence_transformers.models.Transformer' }, { idx: 1, path: '1_Pooling', type: 'sentence_transformers.models.Pooling' }, { idx: 2, path: 'proj', type: 'sentence_transformers.models.Dense' }];
    expect(await validateRepo('d/dense2', withPool({ pooling_mode_mean_tokens: true }, [{ rfilename: 'modules.json', size: 10 }], mods))).toEqual({ ok: false, error: DENSE_ERROR });
    const ok = await validateRepo('m/plain', withPool({ pooling_mode: 'mean', embedding_dimension: 384 }, [{ rfilename: 'modules.json', size: 10 }], mods.slice(0, 2)));
    expect(ok).toMatchObject({ ok: true, pooling: 'mean', dims: 384 });
  });
  it('reports the commit sha as the revision', async () => {
    const sha = 'f'.repeat(40);
    expect((await repoInfo('a/b', async () => json(200, { ...api(), sha }))).revision).toBe(sha);
    expect((await repoInfo('a/b', async () => json(200, { ...api(), sha: 'main' }))).revision).toBeNull();
  });
});

describe('onnxruntime runtime presence', () => {
  const rt = { version: '1.2.3', files: { 'r.asyncify.mjs': 'sha384-a', 'r.asyncify.wasm': 'sha384-b', 'r.mjs': 'sha384-c', 'r.wasm': 'sha384-d', 'r.jspi.mjs': 'sha384-e' } };
  const u = (f) => 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.2.3/dist/' + f;
  it('needs one complete pinned variant, at the pinned version', () => {
    expect(runtimePresent([u('r.asyncify.mjs'), u('r.asyncify.wasm')], rt)).toBe(true);
    expect(runtimePresent([u('r.mjs'), u('r.wasm')], rt)).toBe(true);
    expect(runtimePresent([u('r.asyncify.mjs'), u('r.wasm')], rt)).toBe(false);
    expect(runtimePresent([u('r.jspi.mjs'), u('r.jspi.wasm')], rt)).toBe(false);          // the .wasm has no pinned hash
    expect(runtimePresent([u('r.mjs').replace('1.2.3', '1.2.4'), u('r.wasm').replace('1.2.3', '1.2.4')], rt)).toBe(false);
    expect(runtimePresent([u('r.mjs'), u('r.wasm')], null)).toBe(false);
  });
});

describe('Transformers.js cache layout', () => {
  const tf = readFileSync(new URL('../../node_modules/@huggingface/transformers/dist/transformers.web.js', import.meta.url), 'utf8');
  it('matches the installed library (cache name, host, path template)', () => {
    expect(tf).toContain('cacheKey: "' + TF_CACHE + '"');
    expect(tf).toContain('remoteHost: "' + HF_HOST + '"');
    expect(tf).toContain('remotePathTemplate: "{model}/resolve/{revision}/"');
  });
  it('matches a repo by its /resolve/ prefix, so ArfLLM never claims ArfLLM_Multi files', () => {
    const a = 'tunabirgun/ArfLLM', b = 'tunabirgun/ArfLLM_Multi';
    expect(matchesRepo(resolveUrl(a, MODEL_FILE), a)).toBe(true);
    expect(matchesRepo(resolveUrl(b, MODEL_FILE), a)).toBe(false);
    expect(matchesRepo(resolveUrl(a, MODEL_FILE), b)).toBe(false);
    expect(matchesRepo('https://cdn.jsdelivr.net/npm/onnxruntime-web@1/dist/ort-wasm-simd-threaded.asyncify.wasm', a)).toBe(false);
  });
  it('counts a repo as downloaded only when every required file is cached', () => {
    const urls = REQUIRED_FILES.map((f) => resolveUrl(L6, f));
    expect(repoFilesPresent(urls, L6)).toBe(true);
    expect(repoFilesPresent(urls.slice(1), L6)).toBe(false);
    expect(repoFilesPresent(urls, L12)).toBe(false);
  });
  it('the onnxruntime-web Transformers.js declares is the one installed', () => {
    const tfPkg = JSON.parse(readFileSync(new URL('../../node_modules/@huggingface/transformers/package.json', import.meta.url), 'utf8'));
    const ort = JSON.parse(readFileSync(new URL('../../node_modules/onnxruntime-web/package.json', import.meta.url), 'utf8'));
    expect(tfPkg.version).toBe('4.3.2');
    expect(ort.version).toBe(tfPkg.dependencies['onnxruntime-web']);
  });
});
