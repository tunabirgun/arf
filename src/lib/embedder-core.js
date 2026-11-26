// Pure pieces of the embedder worker, kept free of imports so Node (the parity harness) and the unit tests can load
// them unchanged: HF-convention truncation, one-text forward pass with pooling, and the runtime integrity check.

// --- tokenization ---
// Hugging Face tokenizers truncate the text tokens and then add the special tokens, so a long input keeps its closing
// [SEP] / </s>. Transformers.js 4.3.2 cuts the encoded array instead, dropping it. The worker encodes untruncated and
// applies the HF convention here, so the app's vectors match sentence-transformers and the Python ONNX reference.
export function closingTokenId(tokenizer) {
  const id = tokenizer.sep_token_id ?? tokenizer.eos_token_id;
  return Number.isInteger(id) ? id : null;
}

// the limit Transformers.js itself applies (tokenizer_config model_max_length); null when the config sets none
export function maxLength(tokenizer) {
  const n = tokenizer.model_max_length;
  return Number.isFinite(n) && n > 1 && n < 1e6 ? n : null;
}

// enc: { input_ids: number[], attention_mask: number[], token_type_ids?: number[] } for one text.
// Over maxLen: keep the first maxLen-1 positions and the final (closing special token) position of every array.
// The closing token is kept only when the encoding really ends with it; otherwise this is a plain cut.
export function truncateHF(enc, maxLen, closingId) {
  const n = enc.input_ids.length;
  if (!maxLen || n <= maxLen) return enc;
  const keepClose = closingId != null && enc.input_ids[n - 1] === closingId;
  const out = {};
  for (const [k, a] of Object.entries(enc)) out[k] = keepClose ? [...a.slice(0, maxLen - 1), a[n - 1]] : a.slice(0, maxLen);
  return out;
}

export function encodeHF(tokenizer, text) {
  const enc = tokenizer(text, { add_special_tokens: true, padding: false, truncation: false, return_tensor: false });
  return truncateHF(enc, maxLength(tokenizer), closingTokenId(tokenizer));
}

// --- pooling ---
// hidden: Float32Array of [1, T, H]; mask: number[] of length T. Returns an L2-normalized Float32Array(H).
export function poolNormalize(hidden, T, H, mask, pooling) {
  const v = new Float64Array(H);
  if (pooling === 'cls') for (let h = 0; h < H; h++) v[h] = hidden[h];
  else if (pooling === 'mean') {
    let cnt = 0;
    for (let t = 0; t < T; t++) { if (!mask[t]) continue; cnt++; const o = t * H; for (let h = 0; h < H; h++) v[h] += hidden[o + h]; }
    for (let h = 0; h < H; h++) v[h] /= Math.max(cnt, 1e-9);
  } else throw new Error('Unsupported pooling: ' + pooling);
  let s = 0; for (let h = 0; h < H; h++) s += v[h] * v[h];
  const n = Math.sqrt(s) || 1, out = new Float32Array(H);
  for (let h = 0; h < H; h++) out[h] = v[h] / n;
  return out;
}

// One text, one forward pass (batch 1): dynamic int8 quantization scales activations per batch, so batching or padding
// would make a note's vector depend on its neighbours; the parity gate and the calibration both embed one text per call.
// ctx: { tokenizer, model, Tensor } from a Transformers.js feature-extraction pipeline. Returns { vector, ids }.
export async function embedOne(ctx, text, pooling = 'mean') {
  const enc = encodeHF(ctx.tokenizer, text);
  const T = enc.input_ids.length, inputs = {};
  for (const [k, a] of Object.entries(enc)) inputs[k] = new ctx.Tensor('int64', BigInt64Array.from(a, (x) => BigInt(x)), [1, T]);
  const out = await ctx.model(inputs);   // the model wrapper zero-fills token_type_ids when the graph needs them
  const hs = out.last_hidden_state ?? out.logits ?? out.token_embeddings;
  const H = hs.dims[hs.dims.length - 1];
  return { vector: poolNormalize(hs.data, T, H, enc.attention_mask, pooling), ids: enc.input_ids };
}

// --- onnxruntime-web runtime integrity ---
// expected: 'sha384-<base64>' (SRI form). Uses Web Crypto, available in workers and in Node.
export async function sri384(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-384', bytes));
  let s = ''; for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]);
  return 'sha384-' + btoa(s);
}

export class IntegrityError extends Error {}

// Cache-first fetch of one runtime file, accepted only when its hash matches. A cached copy that fails the check is
// deleted and fetched again; a network copy that fails is never cached or returned. Verified bytes are cached under
// the URL, so the runtime loads offline after the first download. Returns an ArrayBuffer.
export async function fetchVerified(url, expected, { fetchImpl = fetch, cacheStorage = globalThis.caches, cacheName } = {}) {
  const name = url.slice(url.lastIndexOf('/') + 1);
  if (!expected) throw new IntegrityError('Runtime file ' + name + ' has no pinned hash; refusing to load it');
  let cache = null;
  try { if (cacheStorage && cacheName) cache = await cacheStorage.open(cacheName); } catch (e) {}
  if (cache) {
    try {
      const hit = await cache.match(url);
      if (hit) { const b = await hit.arrayBuffer(); if (await sri384(b) === expected) return b; await cache.delete(url); }
    } catch (e) {}
  }
  let res;
  try { res = await fetchImpl(url); } catch (e) { throw new Error('Could not download runtime file ' + name); }
  if (!res.ok) throw new Error('Could not download runtime file ' + name + ' (HTTP ' + res.status + ')');
  const bytes = await res.arrayBuffer();
  if (await sri384(bytes) !== expected) throw new IntegrityError('Integrity check failed for runtime file ' + name + '; it was not loaded');
  if (cache) {
    const type = name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
    try { await cache.put(url, new Response(bytes.slice(0), { headers: { 'content-type': type } })); } catch (e) {}
  }
  return bytes;
}
