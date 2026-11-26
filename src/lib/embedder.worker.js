// On-device sentence embeddings via Transformers.js (q8 ONNX models from the Hugging Face Hub).
// Runs in a Web Worker so model download + inference never block the UI.
// Model files and the onnxruntime WASM runtime are fetched on demand and cached in Cache Storage;
// your note text is never uploaded — embedding happens entirely on this device.
import { pipeline, env, Tensor } from '@huggingface/transformers';
import { embedOne, fetchVerified, IntegrityError } from './embedder-core.js';
import { TF_CACHE, ORT_CDN, ORT_RUNTIME } from './models.js';

env.allowLocalModels = false;
// the runtime is fetched, verified and handed to onnxruntime below; Transformers.js must not fetch or cache its own copy
env.useWasmCache = false;

// onnxruntime-web runtime, pinned to the exact version bundled with Transformers.js and to the SHA-384 of each file
// (both injected by vite.config.js from node_modules). Keep the file names Transformers.js chose (asyncify, or plain
// for old Safari). Only verified bytes reach onnxruntime: the .wasm as wasmBinary, the .mjs as a blob URL.
const wasm = env.backends.onnx && env.backends.onnx.wasm;
let runtimeReady = null;
function prepareRuntime() {
  if (!wasm) return Promise.resolve();
  if (!runtimeReady) {
    const base = (u, fallback) => (typeof u === 'string' && u && !u.startsWith('blob:') ? u.slice(u.lastIndexOf('/') + 1) : fallback);
    const p = wasm.wasmPaths && typeof wasm.wasmPaths === 'object' ? wasm.wasmPaths : {};
    const mjs = base(p.mjs, 'ort-wasm-simd-threaded.asyncify.mjs'), bin = base(p.wasm, 'ort-wasm-simd-threaded.asyncify.wasm');
    const opts = { cacheName: TF_CACHE };
    runtimeReady = Promise.all([
      fetchVerified(ORT_CDN + mjs, ORT_RUNTIME && ORT_RUNTIME.files[mjs], opts),
      fetchVerified(ORT_CDN + bin, ORT_RUNTIME && ORT_RUNTIME.files[bin], opts),
    ]).then(([mjsBytes, wasmBytes]) => {
      wasm.wasmBinary = wasmBytes;
      wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([mjsBytes], { type: 'text/javascript' })), wasm: ORT_CDN + bin };
    }).catch((err) => { runtimeReady = null; throw err; });
  }
  return runtimeReady;
}

let extractor = null;
let loading = null;
let cfg = { model: 'Xenova/all-MiniLM-L6-v2', pooling: 'mean', prefix: '', dtype: 'q8', device: null, revision: 'main' };

const progress = (p) => {
  if (!p) return;
  // progress_total aggregates the model files; plain per-file progress is forwarded too, as a fallback
  if (p.status === 'progress_total') self.postMessage({ type: 'progress', total: true, pct: Math.round(p.progress || 0), loaded: p.loaded, size: p.total });
  else if (p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, pct: Math.round(p.progress || 0), loaded: p.loaded, size: p.total });
};
// Pin the revision in the URL template rather than the `revision` option: Transformers.js 4.3.2 drops that option in
// its pipeline file listing and size probes (get_pipeline_files, get_file_metadata), which then hit resolve/main and,
// offline, fail on an uncached main/tokenizer_config.json. With the template every request and cache key is
// <model>/resolve/<sha>/<file>, i.e. models.js resolveUrl(id, file, sha).
const DEFAULT_TEMPLATE = env.remotePathTemplate;
function loadWith(device) {
  env.remotePathTemplate = cfg.revision && cfg.revision !== 'main' ? '{model}/resolve/' + encodeURIComponent(cfg.revision) + '/' : DEFAULT_TEMPLATE;
  return pipeline('feature-extraction', cfg.model, { dtype: cfg.dtype, device, progress_callback: progress });
}

async function getExtractor() {
  if (extractor) return extractor;
  if (!loading) {
    loading = (async () => {
      await prepareRuntime();
      // int8 (q8) models run on the WASM backend: that is the configuration Transformers.js recommends for q8 and the
      // one the parity and threshold gates were measured on (CPU). On WebGPU, q8 was very slow in the native run and a
      // failed WebGPU init left the WASM fallback unusable on machines without a GPU adapter.
      extractor = await loadWith(cfg.device || 'wasm');
      return extractor;
    })().catch((err) => { loading = null; extractor = null; throw err; });  // allow a retry instead of caching the rejection forever
  }
  return loading;
}

const errText = (err) => (err instanceof IntegrityError ? 'Runtime integrity check failed: ' : '') + String(err && err.message || err);

self.onmessage = async (e) => {
  const { type, id, texts } = e.data;
  if (type === 'init') {
    const o = e.data;
    cfg = { model: o.model || cfg.model, pooling: o.pooling || 'mean', prefix: o.prefix || '', dtype: o.dtype || 'q8', device: o.device || null, revision: o.revision || 'main' };
    try {
      await getExtractor();
      // a download-only load releases the session right away; the files stay in Cache Storage
      if (o.fetchOnly) { try { await extractor.dispose(); } catch (err) {} extractor = null; loading = null; self.postMessage({ type: 'fetched' }); }
      else self.postMessage({ type: 'ready' });
    } catch (err) { self.postMessage({ type: 'error', error: errText(err) }); }
    return;
  }
  if (type === 'embed') {
    try {
      const ex = await getExtractor();
      const ctx = { tokenizer: ex.tokenizer, model: ex.model, Tensor }, vectors = [];
      // one forward pass per text (see embedOne): results do not depend on which notes share a chunk
      for (const t of texts) vectors.push(Array.from((await embedOne(ctx, cfg.prefix + t, cfg.pooling)).vector));
      self.postMessage({ type: 'embedded', id, vectors });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: errText(err) });
    }
  }
};
