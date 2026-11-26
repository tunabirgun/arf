// Embedding models for connection suggestions. Nothing here is bundled: every model is fetched from
// Hugging Face on demand (Transformers.js layout, q8 ONNX) and cached in the browser Cache Storage.
// Pure module (no Transformers.js import), so the main thread can read the registry without the 1 MB library.
import calibrationFile from './model-thresholds.json';

// Cache layout of @huggingface/transformers 4.3.2 (verified in dist/transformers.web.js: env.cacheKey,
// env.remoteHost, env.remotePathTemplate '{model}/resolve/{revision}/'); the worker sets cacheKey from TF_CACHE.
export const TF_CACHE = 'transformers-cache';
export const HF_HOST = 'https://huggingface.co/';
export const MODEL_FILE = 'onnx/model_quantized.onnx';   // dtype 'q8'
// what a feature-extraction pipeline fetches; a repo counts as downloaded when all of these are cached
export const REQUIRED_FILES = ['config.json', 'tokenizer.json', 'tokenizer_config.json', MODEL_FILE];
export const REPO_RE = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;

// revision: the repo commit the files were pinned to at download (see ml.js), or 'main' for files fetched unpinned
export const resolveUrl = (id, file, revision = 'main') => HF_HOST + id + '/resolve/' + encodeURIComponent(revision) + '/' + file;
// the trailing '/resolve/' keeps tunabirgun/ArfLLM from matching tunabirgun/ArfLLM_Multi
export const repoCachePrefix = (id) => HF_HOST + id + '/resolve/';
export const matchesRepo = (url, id) => typeof url === 'string' && url.startsWith(repoCachePrefix(id));
export const repoFilesPresent = (urls, id, revision = 'main') => { const s = new Set(urls); return REQUIRED_FILES.every((f) => s.has(resolveUrl(id, f, revision))); };

// onnxruntime-web runtime: { version, files: { name: 'sha384-...' } }, injected by vite.config.js from node_modules
// (null outside a Vite build unless a test sets globalThis.__ORT_RUNTIME__). The worker fetches the files from jsDelivr
// at this version, verifies each hash, and caches the verified bytes in TF_CACHE under the same URL.
export const ORT_RUNTIME = typeof __ORT_RUNTIME__ !== 'undefined' ? __ORT_RUNTIME__ : null;
export const ortCdn = (runtime = ORT_RUNTIME) => (runtime ? 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + runtime.version + '/dist/' : null);
export const ORT_CDN = ortCdn();
// true when some runtime variant has both its .mjs and .wasm cached (which variant a webview uses is decided in the worker)
export function runtimePresent(urls, runtime = ORT_RUNTIME) {
  if (!runtime) return false;
  const cdn = ortCdn(runtime), s = new Set(urls);
  const stems = new Set(Object.keys(runtime.files).map((f) => f.replace(/\.(mjs|wasm)$/, '')));
  return [...stems].some((st) => runtime.files[st + '.mjs'] && runtime.files[st + '.wasm'] && s.has(cdn + st + '.mjs') && s.has(cdn + st + '.wasm'));
}

const NO_PREFIX = { query: '', passage: '' };
// a passage prefix for custom models (e.g. 'passage: ' for e5): one line, at most 64 characters, kept verbatim
export const cleanPrefix = (p) => (typeof p === 'string' ? p.replace(/[\r\n]/g, ' ').slice(0, 64) : '');
const uncalibrated = () => ({ resonance: null, synthesis: null, calibrated: false });
const mb = (bytes) => (bytes ? Math.round(bytes / 1e5) / 10 : null);

// Descriptions are deliberately neutral: no quality claim until evaluation has established one.
// File sizes (bytes) are from https://huggingface.co/api/models/<id>?blobs=true, checked 2026-11-25:
// q8 = onnx/model_quantized.onnx, files = q8 + config.json + tokenizer.json + tokenizer_config.json.
export const MODELS = [
  { id: 'tunabirgun/ArfLLM', key: 'arfllm', name: 'ArfLLM', description: "Arf's English note-similarity model (384-d, on-device)",
    languages: 'English', q8Bytes: 22944452, fileBytes: 23411690, dims: 384, pooling: 'mean', prefix: NO_PREFIX,
    recommended: true, icon: 'arfllm', licence: 'Apache-2.0', thresholds: uncalibrated() },
  { id: 'tunabirgun/ArfLLM_Multi', key: 'arfllm-multi', name: 'ArfLLM_Multi', description: "Arf's multilingual note-similarity model, incl. Turkish (384-d, on-device)",
    languages: 'Multilingual, incl. Turkish', q8Bytes: 118245805, fileBytes: 135329856, dims: 384, pooling: 'mean', prefix: NO_PREFIX,
    recommended: false, icon: 'arfllm-multi', licence: 'Apache-2.0', thresholds: uncalibrated() },
  { id: 'Xenova/all-MiniLM-L6-v2', key: 'minilm-l6', name: 'all-MiniLM-L6-v2', description: 'General-purpose English sentence model (384-d)',
    languages: 'English', q8Bytes: 22972370, fileBytes: 22972370 + 650 + 711661 + 366, dims: 384, pooling: 'mean', prefix: NO_PREFIX,
    recommended: false, icon: 'chip', licence: 'Apache-2.0',
    // Arf's original Resonance/Synthesis cut-offs, set for this model
    thresholds: { resonance: 0.28, synthesis: 0.45, calibrated: true } },
  { id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', key: 'minilm-l12-multi', name: 'paraphrase-multilingual-MiniLM-L12-v2', description: 'General-purpose multilingual sentence model, 50+ languages (384-d)',
    languages: 'Multilingual, incl. Turkish', q8Bytes: 118308126, fileBytes: 118308126 + 673 + 17082913 + 496, dims: 384, pooling: 'mean', prefix: NO_PREFIX,
    recommended: false, icon: 'chip', licence: 'Apache-2.0', thresholds: uncalibrated() },
];
for (const m of MODELS) { m.sizeMB = mb(m.q8Bytes); m.downloadMB = mb(m.fileBytes); }

// A user-added Hugging Face repo: thresholds always adaptive. prefix: optional passage prefix (cleanPrefix).
export function customEntry({ id, pooling = 'mean', dims = null, q8Bytes = null, fileBytes = null, licence = null, prefix = '' }) {
  return { id, key: 'custom:' + id, name: id.split('/')[1], description: 'Custom model from Hugging Face', languages: 'Unknown',
    q8Bytes, fileBytes, sizeMB: mb(q8Bytes), downloadMB: mb(fileBytes), dims, pooling, prefix: { query: '', passage: cleanPrefix(prefix) },
    recommended: false, icon: 'model-add', licence, custom: true, thresholds: uncalibrated() };
}

export function findModel(id, customs = []) {
  return MODELS.find((m) => m.id === id) || (customs.find((c) => c.id === id) ? customEntry(customs.find((c) => c.id === id)) : null);
}

// Fill measured thresholds, e.g. from the training run's thresholds.json: { "<repo id>": { resonance, synthesis } }.
// Entries that are unknown or not -1 < resonance < synthesis <= 1 are skipped. Returns the ids applied.
export function applyCalibration(json, models = MODELS) {
  const applied = [];
  for (const [id, t] of Object.entries(json || {})) {
    const m = models.find((x) => x.id === id);
    const r = t && Number(t.resonance), s = t && Number(t.synthesis);
    if (!m || !Number.isFinite(r) || !Number.isFinite(s) || !(r > -1 && r < s && s <= 1)) continue;
    m.thresholds = { resonance: r, synthesis: s, calibrated: true };
    applied.push(id);
  }
  return applied;
}
applyCalibration(calibrationFile);

// The recommended model is the entry flagged recommended, provided it has measured thresholds; otherwise the first
// calibrated entry. So an entry is never recommended before its calibration ships in model-thresholds.json.
export const RECOMMENDED_ID = (MODELS.find((m) => m.recommended && m.thresholds.calibrated) || MODELS.find((m) => m.thresholds.calibrated)).id;

// Old installs stored 'en'/'multi' in arf-mlmodel and only wrote it on a switch; anyone who ever touched
// the model toggle (arf-ml set) without that key ran the English MiniLM. Fresh profiles get no model.
export const LEGACY_KEYS = { en: 'Xenova/all-MiniLM-L6-v2', multi: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2' };
export function migrateModelKey(stored, mlFlag) {
  if (stored && LEGACY_KEYS[stored]) return LEGACY_KEYS[stored];
  if (stored && REPO_RE.test(stored)) return stored;
  return mlFlag != null ? LEGACY_KEYS.en : null;
}

// --- adaptive thresholds for uncalibrated models ---
// Basis: cosine similarity between two random notes of the user's own vault is the null distribution of
// "unrelated". Resonance keeps pairs above its 0.90 quantile (top 10 %), Synthesis above the 0.99 quantile
// (top 1 %). Pairs: every pair when n(n-1)/2 <= maxPairs, else maxPairs pairs drawn with replacement by a
// seeded PRNG over id-sorted notes, so the result is deterministic and independent of note order.
// Quantiles use linear interpolation between order statistics (Hyndman-Fan type 7, R's default).
// Minimum sample: the Synthesis cut-off must have at least minAbove sampled pairs above it, so pairs >= minAbove /
// (1 - synthesisQ) = 400, i.e. at least 29 usable notes (29*28/2 = 406). Below that the upper quantile sits at or next
// to the sample maximum and always flags some pair, so adaptiveThresholds returns null and the caller uses TF-IDF.
// Near-empty notes (fewer than minChars letters or digits, when the caller supplies textOf) are left out of the
// sample: their vectors carry little content and crowd the upper quantiles (minChars is a heuristic, not measured).
// Floor: each cut-off is at least `floor` (default cosine 0, i.e. orthogonal: a suggested pair must at least point the
// same way). A caller holding a calibration-derived cosine for the model can pass it as the floor instead.
export const ADAPTIVE = { maxPairs: 4000, seed: 0x5eed, resonanceQ: 0.9, synthesisQ: 0.99, minAbove: 4, minChars: 20 };
export const MIN_PAIRS = Math.ceil(ADAPTIVE.minAbove / (1 - ADAPTIVE.synthesisQ) - 1e-9);
export const MIN_NOTES = Math.ceil((1 + Math.sqrt(1 + 8 * MIN_PAIRS)) / 2);

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
export const contentChars = (t) => (String(t || '').match(/[\p{L}\p{N}]/gu) || []).length;

export function quantile(sorted, p) {
  if (!sorted.length) return null;
  const h = (sorted.length - 1) * p, lo = Math.floor(h);
  return lo + 1 < sorted.length ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

// vecs: id -> L2-normalized vector. textOf(id) -> that note's embedded text (optional; enables the near-empty filter).
// Returns null when fewer than MIN_PAIRS pairs of usable notes exist.
export function adaptiveThresholds(vecs, { maxPairs = ADAPTIVE.maxPairs, seed = ADAPTIVE.seed, textOf = null, minChars = ADAPTIVE.minChars, floor = null } = {}) {
  const ids = Object.keys(vecs || {}).filter((id) => vecs[id] && vecs[id].length && (!textOf || contentChars(textOf(id)) >= minChars)).sort();
  const n = ids.length, all = (n * (n - 1)) / 2;
  if (all < MIN_PAIRS) return null;
  const sims = [];
  if (all <= maxPairs) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) sims.push(dot(vecs[ids[i]], vecs[ids[j]]));
  } else {
    const rnd = mulberry32(seed);
    while (sims.length < Math.max(maxPairs, MIN_PAIRS)) {
      const i = Math.floor(rnd() * n); let j = Math.floor(rnd() * (n - 1)); if (j >= i) j++;
      sims.push(dot(vecs[ids[i]], vecs[ids[j]]));
    }
  }
  sims.sort((a, b) => a - b);
  const fr = Number(floor && floor.resonance) || 0, fs = Number(floor && floor.synthesis) || 0;
  return { resonance: Math.max(quantile(sims, ADAPTIVE.resonanceQ), fr), synthesis: Math.max(quantile(sims, ADAPTIVE.synthesisQ), fs), pairs: sims.length, notes: n, calibrated: false };
}

// --- custom repo validation (Hugging Face public API) ---
// sentence-transformers' 1_Pooling/config.json in either form: booleans (pooling_mode_mean_tokens, ...) with
// word_embedding_dimension, or the newer pooling_mode: 'mean' with embedding_dimension. Arf pools by mean or CLS only;
// any other or combined mode (max, lasttoken, weightedmean, mean_sqrt_len_tokens) is refused, not silently mis-pooled.
const POOL_FLAGS = { pooling_mode_cls_token: 'cls', pooling_mode_mean_tokens: 'mean', pooling_mode_max_tokens: 'max', pooling_mode_mean_sqrt_len_tokens: 'mean_sqrt_len_tokens', pooling_mode_weightedmean_tokens: 'weightedmean', pooling_mode_lasttoken: 'lasttoken' };
export function poolingFromConfig(cfg) {
  const dims = (cfg && Number(cfg.word_embedding_dimension ?? cfg.embedding_dimension)) || null;
  let modes = [];
  if (cfg && cfg.pooling_mode != null) modes = [].concat(cfg.pooling_mode).map((m) => String(m).toLowerCase());
  else if (cfg) modes = Object.keys(POOL_FLAGS).filter((k) => cfg[k] === true).map((k) => POOL_FLAGS[k]);
  if (!modes.length) return { pooling: 'mean', dims };
  if (modes.length === 1 && (modes[0] === 'mean' || modes[0] === 'cls')) return { pooling: modes[0], dims };
  return { error: 'Uses ' + modes.join(' + ') + ' pooling; Arf supports mean or CLS pooling only', dims };
}

export const DENSE_ERROR = 'Has a Dense layer after pooling, which Arf cannot run';
const isDenseType = (t) => /(^|\.)Dense$/.test(String(t || ''));

export async function repoInfo(id, fetchImpl = fetch) {
  if (!REPO_RE.test(id || '')) return { ok: false, error: 'Use the form owner/name' };
  let res;
  try { res = await fetchImpl(HF_HOST + 'api/models/' + id + '?blobs=true'); }
  catch (e) { return { ok: false, error: 'Could not reach Hugging Face' }; }
  // the API answers 401 (not 404) for a repo that does not exist or is not public
  if (res.status === 401 || res.status === 404) return { ok: false, error: 'Not found, or not public yet' };
  if (!res.ok) return { ok: false, error: 'Hugging Face returned ' + res.status };
  let j; try { j = await res.json(); } catch (e) { return { ok: false, error: 'Unreadable answer from Hugging Face' }; }
  const size = new Map((j.siblings || []).map((f) => [f.rfilename, f.size || 0]));
  if (!size.has(MODEL_FILE)) return { ok: false, error: 'No ' + MODEL_FILE + ' (Transformers.js q8) in this repository' };
  if (!size.has('tokenizer.json')) return { ok: false, error: 'No tokenizer.json in this repository' };
  const licence = ((j.tags || []).find((t) => t.startsWith('license:')) || '').slice(8) || null;
  return { ok: true, id, q8Bytes: size.get(MODEL_FILE), fileBytes: REQUIRED_FILES.reduce((s, f) => s + (size.get(f) || 0), 0), licence,
    revision: revisionOf(j), hasPooling: size.has('1_Pooling/config.json'), hasModules: size.has('modules.json'),
    hasDense: [...size.keys()].some((f) => /^\d+_Dense\//.test(f)) };
}
// the commit sha the Hub API reports for a repo (40 hex), or null
export const revisionOf = (j) => (j && typeof j.sha === 'string' && /^[0-9a-f]{40}$/.test(j.sha) ? j.sha : null);

// repoInfo plus pooling/dims from 1_Pooling/config.json; refuses a Dense head or an unsupported pooling mode
export async function validateRepo(id, fetchImpl = fetch) {
  const info = await repoInfo((id || '').trim(), fetchImpl);
  if (!info.ok) return info;
  if (info.hasDense) return { ok: false, error: DENSE_ERROR };
  if (info.hasModules) {
    try {
      const r = await fetchImpl(resolveUrl(info.id, 'modules.json'));
      if (r.ok) { const mods = await r.json(); if (Array.isArray(mods) && mods.some((m) => m && isDenseType(m.type))) return { ok: false, error: DENSE_ERROR }; }
    } catch (e) {}
  }
  let pool = { pooling: 'mean', dims: null };
  if (info.hasPooling) {
    try { const r = await fetchImpl(resolveUrl(info.id, '1_Pooling/config.json')); if (r.ok) pool = poolingFromConfig(await r.json()); } catch (e) {}
  }
  if (pool.error) return { ok: false, error: pool.error };
  return { ...info, ...pool };
}
