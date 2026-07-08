// Derived structure over the notes: links, backlinks, tags, and on-device
// similarity. This is the browser-side stand-in for the shipping core-index and
// core-ml packages. Similarity here is TF-IDF cosine — a real, private,
// no-download on-device signal; the shipping app upgrades the vectorizer to
// MiniLM embeddings (Transformers.js) behind the same interface.

export function parseWikilinks(body) {
  const out = []; const re = /\[\[([^\]]+?)\]\]/g; let m;
  const text = stripCode(body); // ignore [[links]] inside code fences, matching the rendered view
  // edge is built from the target (before a '|' alias), so [[Target|Display]] still links
  while ((m = re.exec(text))) { const raw = m[1].trim(), bar = raw.indexOf('|'); out.push((bar < 0 ? raw : raw.slice(0, bar)).trim()); }
  return out;
}
// strip fenced (``` and ~~~) and inline code so their contents don't leak into tags/tokens.
// coerce to a string first so a tampered cache with a non-string body can't throw here.
function stripCode(body) {
  return String(body == null ? '' : body).replace(/(^|\n)(```|~~~)[\s\S]*?(\n\2|$)/g, ' ').replace(/`[^`]*`/g, ' ');
}
export function parseInlineTags(body) {
  const text = stripCode(body);
  // accept '#' after start-of-string OR any non-word delimiter (space, '*', '[', '(', …) so a tag
  // written as **#project**, [#tag], or (#tag) is indexed the same way the renderer makes it clickable;
  // a '#' after a letter/digit/'/' (C#, x#y) is still not a tag. \p{L}: keep Unicode letters (ğ ş ü é ñ …)
  const out = new Set(); const re = /(^|[^\p{L}\p{N}/])#([\p{L}\p{N}][\p{L}\p{N}/_-]*)/gu; let m;
  while ((m = re.exec(text))) out.add(m[2].toLowerCase());
  return [...out];
}

export function buildIndex(notes) {
  // Object.create(null): a note titled/tagged "__proto__" or "constructor" must
  // behave as an ordinary key, not crash index-building for the whole vault.
  const byId = Object.create(null), byTitle = Object.create(null);
  notes.forEach((n) => {
    byId[n.id] = n;
    // on a duplicate title, resolve deterministically (lowest id) so [[links]] don't flip
    // with the platform's directory-read order. String(): a tampered cache with a numeric
    // title must not throw and blank the whole index.
    const key = String(n.title == null ? '' : n.title).trim().toLowerCase();
    if (key && (!byTitle[key] || n.id < byTitle[key].id)) byTitle[key] = n;
  });
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
    const tags = new Set([...(Array.isArray(n.tags) ? n.tags : []), ...parseInlineTags(n.body)].filter((t) => typeof t === 'string').map((t) => t.toLowerCase()));
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
  + 'his her he she which who whom what when where why how all any each more most other some such no nor only own same too very s t just untitled note')
  .split(/\s+/));

function tokenize(text) {
  // Unicode-aware: a word is any run of letters/digits (ğ ş ü é ñ … all count), so search,
  // resonance, and shared-term extraction work on Turkish/European text, not just ASCII
  return (stripCode(text).toLowerCase().match(/[\p{L}][\p{L}\p{N}']{2,}/gu) || [])
    .filter((w) => !STOP.has(w));
}

// Build the note vectors AND a vectorize() that projects arbitrary text (e.g. the
// paragraph being typed) into the same IDF space, so it can be compared live.
export function buildVectorizer(notes) {
  const docs = notes.map((n) => ({ id: n.id, terms: tokenize((n.title || '') + ' ' + (n.body || '')) }));
  const df = Object.create(null); docs.forEach((d) => new Set(d.terms).forEach((t) => (df[t] = (df[t] || 0) + 1)));
  const N = docs.length || 1;
  // smoothed IDF (+1) so terms shared across all notes still carry weight —
  // otherwise a small vault scores cosine 0 and Resonance/Synthesis read empty
  const vecOf = (terms) => {
    // null-proto: a token like "constructor" must not read Object.prototype (→ NaN weights, broken cosine)
    const tf = Object.create(null); terms.forEach((t) => (tf[t] = (tf[t] || 0) + 1));
    const v = Object.create(null); let norm = 0;
    for (const t in tf) { const w = tf[t] * (Math.log((N + 1) / ((df[t] || 0) + 1)) + 1); v[t] = w; norm += w * w; }
    norm = Math.sqrt(norm) || 1;
    for (const t in v) v[t] /= norm;
    return v;
  };
  const vecs = {};
  docs.forEach((d) => (vecs[d.id] = vecOf(d.terms)));
  // inverse document frequency of a token: high for words unique to a few notes,
  // ~1 for words spread across the whole vault. Lets callers rank a pair's overlap
  // by what actually distinguishes it, not by vault-wide filler.
  const idf = (t) => Math.log((N + 1) / ((df[t] || 0) + 1)) + 1;
  return { vecs, idf, vectorize: (text) => vecOf(tokenize(text)) };
}
export function buildVectors(notes) { return buildVectorizer(notes).vecs; }

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

// The distinctive content words two notes share — the "why" behind a suggested connection,
// so the digest can point at the overlap instead of asking you to find it yourself.
export function sharedTerms(a, b, max = 5, idf = null) {
  if (!a || !b) return [];
  const fa = new Map();
  tokenize((a.title || '') + ' ' + (a.body || '')).forEach((t) => fa.set(t, (fa.get(t) || 0) + 1));
  const fb = new Map();
  tokenize((b.title || '') + ' ' + (b.body || '')).forEach((t) => fb.set(t, (fb.get(t) || 0) + 1));
  const shared = [...fa.keys()].filter((t) => t.length > 3 && fb.has(t));
  if (!idf) { // legacy path: rank by raw frequency in A
    shared.sort((x, y) => (fa.get(y) - fa.get(x)) || (y.length - x.length));
    return shared.slice(0, max);
  }
  // distinctiveness: a term that recurs in both notes but is rare across the vault
  // says more about the pair than a word every note happens to carry.
  const score = (t) => Math.min(fa.get(t), fb.get(t)) * idf(t);
  shared.sort((x, y) => (score(y) - score(x)) || (idf(y) - idf(x)) || (y.length - x.length));
  // if the vault has genuinely distinctive overlap, drop the near-ubiquitous filler
  const strong = shared.filter((t) => idf(t) > 1.05);
  return (strong.length ? strong : shared).slice(0, max);
}
