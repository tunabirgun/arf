// Derived structure over the notes: links, backlinks, tags, and on-device
// similarity. This is the browser-side stand-in for the shipping core-index and
// core-ml packages. Similarity here is TF-IDF cosine — a real, private,
// no-download on-device signal; the shipping app upgrades the vectorizer to
// MiniLM embeddings (Transformers.js) behind the same interface.

export function parseWikilinks(body) {
  const out = []; const re = /\[\[([^\]]+?)\]\]/g; let m;
  while ((m = re.exec(body || ''))) out.push(m[1].trim());
  return out;
}
// strip fenced (``` and ~~~) and inline code so their contents don't leak into tags/tokens
function stripCode(body) {
  return (body || '').replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2|$)/g, ' ').replace(/`[^`]*`/g, ' ');
}
export function parseInlineTags(body) {
  const text = stripCode(body);
  const out = new Set(); const re = /(^|\s)#([a-z0-9][a-z0-9/-]*)/gi; let m;
  while ((m = re.exec(text))) out.add(m[2].toLowerCase());
  return [...out];
}

export function buildIndex(notes) {
  // Object.create(null): a note titled/tagged "__proto__" or "constructor" must
  // behave as an ordinary key, not crash index-building for the whole vault.
  const byId = Object.create(null), byTitle = Object.create(null);
  notes.forEach((n) => { byId[n.id] = n; byTitle[(n.title || '').trim().toLowerCase()] = n; });
  const fwd = Object.create(null), back = Object.create(null);
  notes.forEach((n) => {
    const links = new Set();
    parseWikilinks(n.body).forEach((title) => {
      const t = byTitle[title.toLowerCase()];
      if (t && t.id !== n.id) { links.add(t.id); (back[t.id] = back[t.id] || new Set()).add(n.id); }
    });
    fwd[n.id] = [...links];
  });
  const backArr = Object.create(null); Object.keys(back).forEach((k) => (backArr[k] = [...back[k]]));
  const tagIndex = Object.create(null), noteTags = Object.create(null);
  notes.forEach((n) => {
    const tags = new Set([...(n.tags || []), ...parseInlineTags(n.body)].map((t) => t.toLowerCase()));
    noteTags[n.id] = [...tags];
    tags.forEach((t) => (tagIndex[t] = tagIndex[t] || []).push(n.id));
  });
  return { byId, byTitle, fwd, back: backArr, tagIndex, noteTags };
}

export function hasLinks(id, idx) {
  return (idx.fwd[id] && idx.fwd[id].length) || (idx.back[id] && idx.back[id].length);
}

const STOP = new Set(('the a an and or of to in is are was were on for with as by at it its this that be from we you your our '
  + 'their they them not but if then than so into over under out up down about can may will would could should have has had do does '
  + 'his her he she which who whom what when where why how all any each more most other some such no nor only own same too very s t just')
  .split(/\s+/));

function tokenize(text) {
  return (stripCode(text).toLowerCase().match(/[a-z][a-z0-9']{2,}/g) || [])
    .filter((w) => !STOP.has(w));
}

export function buildVectors(notes) {
  const docs = notes.map((n) => ({ id: n.id, terms: tokenize((n.title || '') + ' ' + (n.body || '')) }));
  const df = {}; docs.forEach((d) => new Set(d.terms).forEach((t) => (df[t] = (df[t] || 0) + 1)));
  const N = docs.length || 1;
  const vecs = {};
  docs.forEach((d) => {
    const tf = {}; d.terms.forEach((t) => (tf[t] = (tf[t] || 0) + 1));
    const v = {}; let norm = 0;
    // smoothed IDF (+1) so terms shared across all notes still carry weight —
    // otherwise a small vault scores cosine 0 and Resonance/Synthesis read empty
    for (const t in tf) { const w = tf[t] * (Math.log((N + 1) / ((df[t] || 0) + 1)) + 1); v[t] = w; norm += w * w; }
    norm = Math.sqrt(norm) || 1;
    for (const t in v) v[t] /= norm;
    vecs[d.id] = v;
  });
  return vecs;
}

export function cosine(a, b) {
  if (!a || !b) return 0;
  const [x, y] = Object.keys(a).length < Object.keys(b).length ? [a, b] : [b, a];
  let s = 0; for (const t in x) if (y[t]) s += x[t] * y[t];
  return s;
}

export function related(id, vecs, notes, { min = 0.06, max = 6, exclude = new Set() } = {}) {
  const v = vecs[id]; if (!v) return [];
  const out = [];
  notes.forEach((n) => {
    if (n.id === id || exclude.has(n.id)) return;
    const s = cosine(v, vecs[n.id]);
    if (s >= min) out.push({ id: n.id, s });
  });
  out.sort((a, b) => b.s - a.s);
  return out.slice(0, max);
}

// Unlinked-but-similar pairs across the whole vault, for the Synthesis digest.
export function digestPairs(notes, vecs, idx, { min = 0.14, max = 6 } = {}) {
  const pairs = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i], b = notes[j];
      const linked = (idx.fwd[a.id] || []).includes(b.id) || (idx.fwd[b.id] || []).includes(a.id);
      if (linked) continue;
      const s = cosine(vecs[a.id], vecs[b.id]);
      if (s >= min) pairs.push({ a: a.id, b: b.id, s });
    }
  }
  pairs.sort((x, y) => y.s - x.s);
  return pairs.slice(0, max);
}
