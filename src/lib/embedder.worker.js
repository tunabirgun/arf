// On-device sentence embeddings via Transformers.js (all-MiniLM-L6-v2, quantized).
// Runs in a Web Worker so model download + inference never block the UI.
// The model (a public ~23 MB file) is fetched once and cached by the browser;
// your note text is never uploaded — embedding happens entirely on this device.
import { pipeline, env } from '@huggingface/transformers';

env.allowLocalModels = false;

let extractor = null;
let loading = null;
let MODEL = 'Xenova/all-MiniLM-L6-v2'; // English by default; the multilingual model is set via the init message

function loadWith(device) {
  return pipeline('feature-extraction', MODEL, {
    dtype: 'q8',
    device,
    progress_callback: (p) => { if (p && p.status === 'progress') self.postMessage({ type: 'progress', file: p.file, pct: Math.round(p.progress || 0) }); },
  });
}

async function getExtractor() {
  if (extractor) return extractor;
  if (!loading) {
    loading = (async () => {
      try { extractor = await loadWith('webgpu'); }
      catch (e) { extractor = await loadWith('wasm'); }  // WebGPU unavailable → WASM
      return extractor;
    })().catch((err) => { loading = null; extractor = null; throw err; });  // allow a retry instead of caching the rejection forever
  }
  return loading;
}

self.onmessage = async (e) => {
  const { type, id, texts, model } = e.data;
  if (type === 'init') {
    if (model) MODEL = model;
    try { await getExtractor(); self.postMessage({ type: 'ready' }); }
    catch (err) { self.postMessage({ type: 'error', error: String(err && err.message || err) }); }
    return;
  }
  if (type === 'embed') {
    try {
      const ex = await getExtractor();
      const out = await ex(texts, { pooling: 'mean', normalize: true });
      self.postMessage({ type: 'embedded', id, vectors: out.tolist() });
    } catch (err) {
      self.postMessage({ type: 'error', id, error: String(err && err.message || err) });
    }
  }
};
