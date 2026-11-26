// Importers: Markdown / Obsidian / Jekyll notes (loose files or a .zip) and reference files
// (BibTeX, RIS, CSL-JSON). Pure functions, no DOM, no Tauri: App.svelte feeds them text/bytes
// and merges the result. Note shape matches vault.js: {id, title, folder, tags, created, updated, body}.

import { unzipSync, strFromU8 } from 'fflate';
import { ulid } from './vault.js';
import { canonFolder, isReservedRoot, mapReservedRoot } from './folders.js';

const MAX_NOTE_BYTES = 5 * 1024 * 1024;
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;   // a reference PDF/EPUB restored from Arf's own export
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
// a frontmatter id is kept unless it is malformed: control characters (a newline would inject YAML keys) or
// absurdly long. Any other id stays, so an exact id match with an existing note means the same note.
const BAD_ID = /[\u0000-\u001f\u007f]/;
const idOk = (s) => !!s && s.length <= 200 && !BAD_ID.test(s);
const README_RE = /^README\.txt$/;   // the root README of Arf's own export zip (exact name), skipped silently

// ======================= Markdown notes =======================

const normPath = (p) => String(p || '').replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').join('/');
// hidden / tool folders that are never notes (Obsidian config, trash, macOS resource forks, dotfiles)
export const ignoredPath = (p) => p.split('/').some((s) => s.startsWith('.') || s === '__MACOSX');

// ---- minimal YAML frontmatter (the subset Arf, Obsidian and Jekyll actually emit) ----
const KEY_RE = /^([A-Za-z0-9_][\w .-]*?):(?:[ \t]+(.*))?$/;

function unquote(s) {
  s = s.trim();
  if (s[0] === '"') {
    let out = '';
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        const n = s[++i];
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n;
      } else if (c === '"') return out;
      else out += c;
    }
    return out;
  }
  if (s[0] === "'") {
    const m = /^'((?:[^']|'')*)'/.exec(s);
    if (m) return m[1].replace(/''/g, "'");
  }
  return s.replace(/\s+#.*$/, '').trim();
}
function splitInlineList(inner) {
  const items = []; let cur = '', q = null;
  for (const c of inner) {
    if (q) { cur += c; if (c === q) q = null; } else if (c === '"' || c === "'") { q = c; cur += c; } else if (c === ',') { items.push(cur); cur = ''; } else cur += c;
  }
  items.push(cur);
  return items.map((x) => unquote(x)).filter((x) => x !== '');
}
function parseFrontmatter(block) {
  const entries = []; let cur = null;
  for (const line of block.split('\n')) {
    if (/^\s*(#.*)?$/.test(line)) { if (cur) cur.cont.push(line); continue; }
    if (/^[ \t]/.test(line) || /^-(\s|$)/.test(line)) { if (cur) cur.cont.push(line); continue; }
    const m = KEY_RE.exec(line);
    if (m) { cur = { key: m[1].trim(), lower: m[1].trim().toLowerCase(), inline: (m[2] || '').trim(), cont: [], line }; entries.push(cur); } else cur = null;
  }
  for (const e of entries) {
    while (e.cont.length && !e.cont[e.cont.length - 1].trim()) e.cont.pop();
    e.raw = [e.line, ...e.cont].join('\n');
    const il = e.inline;
    if (/^[|>][+-]?\d*$/.test(il)) {
      const lines = e.cont.map((l) => l.replace(/^\s+/, ''));
      e.str = (il[0] === '|' ? lines.join('\n') : lines.join(' ')).trim();
    } else if (il.startsWith('[')) {
      const text = (il + ' ' + e.cont.map((l) => l.trim()).join(' ')).trim();
      const end = text.lastIndexOf(']');
      e.list = splitInlineList(text.slice(1, end < 0 ? undefined : end));
    } else if (il === '' && e.cont.some((l) => /^\s*-\s/.test(l) || /^\s*-$/.test(l))) {
      e.list = e.cont.map((l) => /^\s*-\s*(.*)$/.exec(l)).filter(Boolean).map((m) => unquote(m[1])).filter((x) => x !== '');
    } else e.str = il === '' ? '' : unquote(il);
  }
  return entries;
}

function toISO(v) {
  if (v == null) return null;
  let s = String(v).trim().replace(/^["']|["']$/g, '');
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00.000Z';
  const t = Date.parse(s);
  if (isNaN(t) || Math.abs(t) > 8.64e15) return null;
  return new Date(t).toISOString();
}

function tagsOf(e) {
  let items = [];
  if (e.list) items = e.list;
  else if (e.str) items = e.str.includes(',') ? e.str.split(',') : e.str.split(/\s+/);
  const out = [];
  for (let t of items) { t = String(t).trim().replace(/^#+/, '').trim(); if (t && !out.includes(t)) out.push(t); }
  return out;
}

// apply fn to each line outside fenced code blocks
function outsideFences(text, fn) {
  let fence = null;
  return text.split('\n').map((line) => {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) { if (!fence) fence = m[1][0]; else if (fence === m[1][0]) fence = null; return line; }
    return fence ? line : fn(line);
  }).join('\n');
}
function firstH1(body) {
  let fence = null, idx = -1, title = '';
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i]);
    if (m) { if (!fence) fence = m[1][0]; else if (fence === m[1][0]) fence = null; continue; }
    if (fence) continue;
    const h = /^#[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(lines[i]);
    if (h && h[1].trim()) { idx = i; title = h[1].trim(); break; }
  }
  return { idx, title, lines };
}
// ![[img.png]] / ![[img.png|300]] -> ![](img.png); non-image embeds (![[note]]) are kept
function convertEmbeds(body) {
  let n = 0;
  const out = outsideFences(body, (line) => line.split(/(`[^`]*`)/).map((seg, i) => {
    if (i % 2) return seg;
    return seg.replace(/!\[\[([^\]|#]+?\.(?:png|jpe?g|gif|webp|svg))(?:[|#][^\]]*)?\]\]/gi, (_, f) => { n++; return '![](' + f.trim().replace(/ /g, '%20') + ')'; });
  }).join(''));
  return { body: out, count: n };
}

const KNOWN_KEYS = new Set(['id', 'title', 'tags', 'tag', 'created', 'date', 'created_at', 'updated', 'modified', 'last_modified', 'updated_at',
  'created_local', 'updated_local', 'aliases', 'alias']);

// files: [{path, text}]; opts: {existing, now, keepUnknownFrontmatter, convertEmbeds (default true), extraFolders,
// loose (the files carry no folder information: loose picks or drops, so a note matched by id keeps its folder)}
// A note may carry two markers for planImport (importflow.js), which strips them:
//   _noId    no frontmatter id: planImport treats a same title + body existing note as this one (re-import)
//   _undated an id that matches an existing note but no date: the existing copy is kept
export function importMarkdownFiles(files, opts = {}) {
  const existing = Array.isArray(opts.existing) ? opts.existing : [];
  const now = opts.now || new Date().toISOString();
  const convert = opts.convertEmbeds !== false;
  const maxBytes = opts.maxBytes || MAX_NOTE_BYTES;
  const exById = new Map(existing.map((n) => [n.id, n]));
  const used = new Set(exById.keys()), inImport = new Set();
  const enc = new TextEncoder();
  const report = { aliases: [], droppedFrontmatter: [], embedsConverted: 0, idsReassigned: 0, keptFrontmatter: 0 };
  const skipped = [], notes = [], folderSet = new Set();
  const addFolder = (f) => { let cur = ''; for (const s of f.split('/')) { if (!s) continue; cur = cur ? cur + '/' + s : s; folderSet.add(cur); } };
  // an empty root attachments/ directory entry is the vault's own reserved folder, never a note folder
  (opts.extraFolders || []).forEach((f) => { if (!isReservedRoot(f)) addFolder(canonFolder(f)); });

  const list = (files || []).filter((f) => f && typeof f === 'object').map((f) => ({ path: String(f.path || ''), text: f.text }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of list) {
    const p = normPath(f.path);
    if (!p) { skipped.push({ path: f.path, reason: 'empty-path' }); continue; }
    if (README_RE.test(p)) continue;
    if (!/\.(md|markdown)$/i.test(p)) { skipped.push({ path: p, reason: 'not-markdown' }); continue; }
    if (ignoredPath(p)) { skipped.push({ path: p, reason: 'hidden' }); continue; }
    if (typeof f.text !== 'string') { skipped.push({ path: p, reason: 'not-text' }); continue; }
    if (f.text.length > maxBytes || enc.encode(f.text).length > maxBytes) { skipped.push({ path: p, reason: 'too-large' }); continue; }

    let text = f.text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    let entries = [], body = text;
    const fm = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(text);
    if (fm) {
      const parsed = parseFrontmatter(fm[1] || '');
      if (parsed.length || !(fm[1] || '').trim()) { entries = parsed; body = text.slice(fm[0].length); }
    }
    body = body.replace(/^\n+/, '');
    const get = (...keys) => { for (const k of keys) { const e = entries.find((x) => x.lower === k); if (e) return e; } return null; };

    // title
    const te = get('title');
    let title = te && te.str != null ? te.str.replace(/\s+/g, ' ').trim() : (te && te.list ? te.list.join(' ').trim() : '');
    if (!title) {
      const h = firstH1(body);
      if (h.idx >= 0) {
        title = h.title;
        if (h.lines.slice(0, h.idx).every((l) => !l.trim())) body = h.lines.slice(h.idx + 1).join('\n').replace(/^\n+/, '');
      }
    }
    const base = p.slice(p.lastIndexOf('/') + 1).replace(/\.(md|markdown)$/i, '');
    if (!title) title = base;

    // folder
    let folder = mapReservedRoot(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
    if (folder) addFolder(folder);

    // tags, dates
    const tg = get('tags', 'tag');
    const tags = tg ? tagsOf(tg) : [];
    const ce = get('created', 'date', 'created_at'), ue = get('updated', 'modified', 'last_modified', 'updated_at');
    const dated = !!(toISO(ce && ce.str) || toISO(ue && ue.str));
    const created = toISO(ce && ce.str) || toISO(ue && ue.str) || now;
    const updated = toISO(ue && ue.str) || created;

    // aliases are dropped (reported); unknown keys are kept in a yaml fence only on request
    const al = get('aliases', 'alias');
    if (al) { const a = al.list || (al.str ? [al.str] : []); if (a.length) report.aliases.push({ path: p, aliases: a }); }
    const unknown = entries.filter((e) => !KNOWN_KEYS.has(e.lower));
    if (unknown.length) {
      if (opts.keepUnknownFrontmatter) { body = '```yaml\n' + unknown.map((e) => e.raw).join('\n') + '\n```\n\n' + body; report.keptFrontmatter++; } else report.droppedFrontmatter.push({ path: p, keys: unknown.map((e) => e.key) });
    }

    if (convert) { const c = convertEmbeds(body); body = c.body; report.embedsConverted += c.count; }
    body = body.replace(/\s+$/, '');

    // id: any well-formed id is kept, and an exact match with an existing note is that note (mergeByUpdated
    // decides which copy wins). A new id only for a malformed id or a second use within this import.
    let id = '';
    const ie = get('id');
    const fid = ie && ie.str ? ie.str.trim() : '';
    if (idOk(fid) && !inImport.has(fid)) id = fid;
    if (!id) { do id = ulid(); while (used.has(id) || inImport.has(id)); if (fid) report.idsReassigned++; }
    used.add(id); inImport.add(id);
    const ex = exById.get(id);
    if (ex && opts.loose) folder = canonFolder(ex.folder);
    const note = { id, title, folder, tags, created, updated, body };
    if (!fid) note._noId = true;
    else if (ex && !dated) note._undated = true;
    notes.push(note);
  }
  return { notes, folders: [...folderSet].sort(), skipped, report };
}

// repair zip entry names written as raw UTF-8 without the UTF-8 flag (decoded as Latin-1 by fflate)
function fixName(n) {
  if (!/[\u0080-ÿ]/.test(n) || /[^\u0000-ÿ]/.test(n)) return n;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(n, (c) => c.charCodeAt(0))); } catch (e) { return n; }
}

// bytes: zip. Result = importMarkdownFiles result + assets [{path, bytes}] + refs (from references.json/.bib at the root, if any)
export function importZip(bytes, opts = {}) {
  const maxNote = opts.maxBytes || MAX_NOTE_BYTES;
  const items = []; // {p, kind}
  const entries = unzipSync(bytes, {
    filter(f) {
      const p = normPath(fixName(f.name));
      if (!p || ignoredPath(p)) return false;
      if (f.name.endsWith('/')) { items.push({ p, kind: 'dir' }); return false; }
      const md = /\.(md|markdown)$/i.test(p), img = IMG_EXT.test(p), refs = /(^|\/)references\.(json|bib)$/i.test(p);
      if (!md && !img && !refs) { items.push({ p, kind: 'other' }); return false; }
      if (f.originalSize > (img ? MAX_ASSET_BYTES : md ? maxNote : 20 * 1024 * 1024)) { items.push({ p, kind: 'big' }); return false; }
      items.push({ p, kind: md ? 'md' : img ? 'img' : 'refs' });
      return true;
    },
  });
  const data = new Map();
  for (const [k, v] of Object.entries(entries)) data.set(normPath(fixName(k)), v);

  // strip one shared top-level folder (e.g. "MyVault/…")
  let strip = '';
  if (items.length) {
    const top = items[0].p.split('/')[0];
    if (items.every((i) => i.p.split('/')[0] === top && (i.kind === 'dir' || i.p.includes('/')))) strip = top + '/';
  }
  const rel = (p) => (strip && p.startsWith(strip) ? p.slice(strip.length) : strip && p + '/' === strip ? '' : p);

  let refsEntry = null;
  for (const it of items) {
    const p = rel(it.p);
    if (p && it.kind === 'refs' && !p.includes('/') && (!refsEntry || /json$/i.test(p))) refsEntry = { name: p, text: strFromU8(data.get(it.p)) };
  }
  const rr = refsEntry ? importReferences(refsEntry.text, refsEntry.name, { existingRefs: opts.existingRefs }) : null;
  // reference files (PDF/EPUB, also .md/.txt/.html) that the zip's own references name: Arf's export carries them
  // under attachments/. They are restored as files, never imported as notes or reported as skipped.
  const attPaths = new Set();
  for (const r of (rr ? rr.refs : [])) { const ap = r && r.attachment && normPath(r.attachment.path); if (ap && /^attachments\//i.test(ap) && !IMG_EXT.test(ap)) attPaths.add(ap); }
  const files = [], assets = [], extra = [], zskipped = [], attachments = [], wantAtt = new Map();
  for (const it of items) {
    const p = rel(it.p);
    if (!p || it.kind === 'refs') continue;
    if (attPaths.has(p)) { if (it.kind === 'md') attachments.push({ path: p, bytes: data.get(it.p) }); else if (it.kind === 'other') wantAtt.set(it.p, p); continue; }
    if (it.kind === 'dir') extra.push(p);
    else if (it.kind === 'md') files.push({ path: p, text: strFromU8(data.get(it.p)) });
    else if (it.kind === 'img') assets.push({ path: p, bytes: data.get(it.p) });
    else if (!(it.kind === 'other' && README_RE.test(p))) zskipped.push({ path: p, reason: it.kind === 'big' ? 'too-large' : 'not-markdown' });
  }
  // second pass for the named reference files only (the first pass left non-note entries packed)
  if (wantAtt.size) {
    const more = unzipSync(bytes, { filter: (f) => wantAtt.has(normPath(fixName(f.name))) && f.originalSize <= MAX_ATTACHMENT_BYTES });
    for (const [k, v] of Object.entries(more)) attachments.push({ path: wantAtt.get(normPath(fixName(k))), bytes: v });
  }
  const res = importMarkdownFiles(files, { ...opts, extraFolders: [...(opts.extraFolders || []), ...extra] });
  res.skipped.push(...zskipped);
  res.assets = assets.sort((a, b) => (a.path < b.path ? -1 : 1));
  res.attachments = attachments.sort((a, b) => (a.path < b.path ? -1 : 1));
  res.refs = rr ? rr.refs : [];
  res.refKeyMap = rr ? rr.keyMap : {};
  return res;
}

// ======================= References =======================

// the Library's citekey rule (Library.svelte mkCitekey), replicated because it lives inside the component
export function mkCitekey(authors, year) {
  const raw = (authors && authors[0] && authors[0].f ? authors[0].f : 'ref');
  const base = raw.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ş/g, 's').replace(/Ş/g, 's').replace(/ğ/g, 'g').replace(/Ğ/g, 'g')
    .toLowerCase().replace(/[^a-z0-9]/g, '') || 'ref';
  return base + (year || '');
}
const KEY_OK = /^[A-Za-z0-9_:.-]+$/; // the [@citekey] syntax of markdown.js

// give every ref a unique citekey + id ('r_' + citekey); keeps a valid original key when free.
// opts.keyMap (an object) collects original key -> assigned key for every key that changed.
function finalizeRefs(refs, opts = {}, label) {
  const ex = opts.existingRefs || [];
  const keys = new Set(ex.map((r) => r.citekey)), ids = new Set(ex.map((r) => r.id));
  const free = (k) => !keys.has(k) && !ids.has('r_' + k);
  const batch = new Set();
  for (const r of refs) {
    const orig = r._key;
    let k = r._key && KEY_OK.test(r._key) && free(r._key) ? r._key : '';
    delete r._key;
    if (!k) {
      const base = mkCitekey(r.authors, r.year);
      k = base;
      for (let i = 0; !free(k); i++) k = base + (i < 25 ? String.fromCharCode(98 + i) : String(i - 23));
    }
    r.citekey = k; r.id = 'r_' + k; r.sources = [label];
    keys.add(k); ids.add(r.id);
    // a renamed key maps old -> new, unless an earlier entry of this file kept that key (its citations are its own)
    if (opts.keyMap && orig && orig !== k && KEY_OK.test(orig) && !batch.has(orig)) opts.keyMap[orig] = k;
    batch.add(k);
  }
  return refs;
}

// merge imported refs into an existing library: skip a ref whose DOI (or title+first author+year) is already there.
// Returns {refs: merged array (new ones appended), added, duplicates, keyMap}. keyMap: incoming citekey -> the key it
// is known by after the merge (a renamed clash, or the existing ref it duplicates), only for keys that changed.
export function mergeImportedRefs(existing, incoming) {
  const doi = (r) => String(r.doi || '').toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '').trim();
  const sig = (r) => [String(r.title || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''), ((r.authors || [])[0] || {}).f || '', r.year || ''].join('|').toLowerCase();
  const byDoi = new Map(), bySig = new Map();
  for (const r of existing) { const d = doi(r); if (d && !byDoi.has(d)) byDoi.set(d, r); const s = sig(r); if (!bySig.has(s)) bySig.set(s, r); }
  const keys = new Set(existing.map((r) => r.citekey)), ids = new Set(existing.map((r) => r.id));
  const added = [], duplicates = [], keyMap = {};
  for (const r0 of incoming) {
    const d = doi(r0), s = sig(r0);
    const dup = (d && byDoi.get(d)) || (r0.title && bySig.get(s));
    if (dup) { duplicates.push(r0); if (r0.citekey && dup.citekey && r0.citekey !== dup.citekey) keyMap[r0.citekey] = dup.citekey; continue; }
    let r = r0;
    if (keys.has(r.citekey) || ids.has(r.id)) {
      const base = r.citekey; let k = base;
      for (let i = 0; keys.has(k) || ids.has('r_' + k); i++) k = base + (i < 25 ? String.fromCharCode(98 + i) : String(i - 23));
      r = { ...r, citekey: k, id: 'r_' + k };
      if (base && base !== k) keyMap[base] = k;
    }
    if (d) byDoi.set(d, r);
    bySig.set(s, r); keys.add(r.citekey); ids.add(r.id); added.push(r);
  }
  return { refs: [...existing, ...added], added, duplicates, keyMap };
}

const ws = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const yearOf = (s) => { const m = /(\d{4})/.exec(String(s == null ? '' : s)); return m ? Number(m[1]) : ''; };
const cleanDoi = (s) => ws(s).replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
const cleanIsbn = (s) => { const v = ws(s); return /^[0-9][0-9\s-]{8,16}[0-9xX]$/.test(v) ? v.replace(/[\s-]/g, '') : v; };
const cleanPages = (s) => ws(s).replace(/\s*[-–—]+\s*/g, '–');
const isIsbn = (s) => /^(97[89])?\d{9}[\dxX]$/.test(String(s).replace(/[\s-]/g, ''));

function splitName(name) {
  // "Last, First" | "Last, Jr, First" | "First Last" | "First van Last" | "{Corporate Name}"
  name = name.trim();
  if (!name) return null;
  if (/^\{[^{}]*\}$/.test(name)) return { f: name.slice(1, -1).trim(), g: '' };
  const parts = splitTop(name, ',');
  if (parts.length > 1) return { f: parts[0].trim() + (parts.length > 2 ? ' ' + parts[1].trim() : ''), g: parts[parts.length - 1].trim() };
  const tokens = splitTop(name, ' ').filter(Boolean);
  if (tokens.length === 1) return { f: tokens[0], g: '' };
  let i = tokens.length - 1;
  while (i > 1 && /^[a-zà-ÿ]/.test(tokens[i - 1].replace(/^\{/, ''))) i--; // von / van / de particles belong to the family name
  return { f: tokens.slice(i).join(' '), g: tokens.slice(0, i).join(' ') };
}
// split at top-level brace depth only
function splitTop(s, sep) {
  const out = []; let depth = 0, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { cur += c + (s[i + 1] || ''); i++; continue; }
    if (c === '{') depth++; else if (c === '}') depth = Math.max(0, depth - 1);
    if (!depth && (sep === ' ' ? /\s/.test(c) : c === sep)) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---- LaTeX -> Unicode ----
const MARKS = { '`': '̀', "'": '́', '^': '̂', '~': '̃', '=': '̄', '.': '̇', '"': '̈', u: '̆', v: '̌', c: '̧', H: '̋', k: '̨', r: '̊', d: '̣', b: '̱' };
const LETTER_CMDS = { i: 'ı', j: 'ȷ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', textbackslash: '\\',
  textendash: '–', textemdash: '—', textquoteright: '’', textquoteleft: '‘', textquotedblleft: '“', textquotedblright: '”', textasciitilde: '~', textasciicircum: '^',
  textless: '<', textgreater: '>', textunderscore: '_', textbar: '|', textdegree: '°', textmu: 'µ', LaTeX: 'LaTeX', TeX: 'TeX', ldots: '…', dots: '…' };
const FORMAT_CMDS = new Set(['emph', 'textit', 'textbf', 'textsc', 'textrm', 'texttt', 'textsf', 'textsl', 'textup', 'underline', 'url', 'mbox', 'text', 'bf', 'it', 'em', 'sc', 'rm', 'tt', 'sf', 'sl', 'protect', 'ensuremath']);
const ACCENT_LETTER = new Set(['u', 'v', 'c', 'H', 'k', 'r', 'd', 'b']);

function readArg(s, i) { // brace group or single token at i; returns [raw, nextIndex]
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let d = 0, j = i;
    for (; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) break; }
    return [s.slice(i + 1, j), j + 1];
  }
  if (s[i] === '\\') { const m = /^\\([a-zA-Z]+)/.exec(s.slice(i)); if (m) return ['\\' + m[1], i + m[0].length]; return [s.slice(i, i + 2), i + 2]; }
  return [s[i] || '', i + 1];
}
function accentOn(mark, arg) {
  let base = latex(arg);
  if (arg.trim() === '\\i') base = 'i'; else if (arg.trim() === '\\j') base = 'j';
  if (!base) return MARKS[mark] === '̈' ? '' : '';
  return (base[0] + MARKS[mark] + base.slice(1)).normalize('NFC');
}
// full decode of a text field (titles, authors, abstracts); math ($…$) is kept verbatim
function latex(s) {
  let out = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === undefined) { i++; continue; }
      if (/[&%$#_{}]/.test(n)) { out += n; i += 2; continue; }
      if ((n === '^' || n === '~') && s.startsWith('{}', i + 2)) { out += n; i += 4; continue; }
      if (n === ' ' || n === ',' || n === ';' || n === '!') { out += n === ' ' ? ' ' : ''; i += 2; continue; }
      if (n === '\\') { out += ' '; i += 2; continue; }
      if (MARKS[n] && !/[a-zA-Z]/.test(n)) { const [a, j] = readArg(s, i + 2); out += accentOn(n, a); i = j; continue; }
      const m = /^[a-zA-Z]+/.exec(s.slice(i + 1));
      if (m) {
        const name = m[0]; let j = i + 1 + name.length;
        if (ACCENT_LETTER.has(name)) { const [a, k] = readArg(s, j); out += accentOn(name, a); i = k; continue; }
        if (Object.prototype.hasOwnProperty.call(LETTER_CMDS, name)) { out += LETTER_CMDS[name]; if (s[j] === ' ') j++; i = j; continue; }
        if (FORMAT_CMDS.has(name)) { if (s[j] === ' ') j++; i = j; continue; }
        out += '\\' + name; i = j; continue; // unknown command: keep literally
      }
      out += n; i += 2; continue;
    }
    if (c === '$') {
      let j = i + 1;
      while (j < s.length && s[j] !== '$') { if (s[j] === '\\') j++; j++; }
      if (j < s.length) { out += s.slice(i, j + 1); i = j + 1; continue; }
      out += c; i++; continue;
    }
    if (c === '{' || c === '}') { i++; continue; }
    if (c === '~') { out += ' '; i++; continue; }
    if (c === '-' && s.startsWith('---', i)) { out += '—'; i += 3; continue; }
    if (c === '-' && s.startsWith('--', i)) { out += '–'; i += 2; continue; }
    out += c; i++;
  }
  return ws(out);
}
// minimal decode for identifiers (doi, url, isbn): only backslash escapes, no dash/tilde rewriting
function latexRaw(s) {
  return ws(String(s).replace(/\\textbackslash\s?/g, '\\').replace(/\\([\^~])\{\}/g, '$1').replace(/\\([&%$#_{}])/g, '$1').replace(/^\\url\{(.*)\}$/, '$1'));
}

// ---- BibTeX ----
const MONTHS = { jan: 'January', feb: 'February', mar: 'March', apr: 'April', may: 'May', jun: 'June', jul: 'July', aug: 'August', sep: 'September', oct: 'October', nov: 'November', dec: 'December' };

function bibType(t, f) {
  t = t.toLowerCase();
  if (t === 'article' || t === 'inproceedings' || t === 'conference' || t === 'incollection' || t === 'techreport' || t === 'report' || t === 'phdthesis' || t === 'mastersthesis' || t === 'thesis' || t === 'proceedings') return 'article-journal';
  if (t === 'book' || t === 'inbook' || t === 'booklet' || t === 'manual' || t === 'mvbook') return 'book';
  if (t === 'online' || t === 'electronic' || t === 'www' || t === 'webpage') return 'webpage';
  if (t === 'dataset') return 'dataset';
  if (t === 'unpublished') return 'preprint';
  if (t === 'misc') {
    const hay = ((f.journal || '') + ' ' + (f.howpublished || '') + ' ' + (f.archiveprefix || '') + ' ' + (f.eprinttype || '') + ' ' + (f.publisher || '')).toLowerCase();
    if (f.eprint || /arxiv|biorxiv|medrxiv|ssrn|preprint|chemrxiv|zenodo/.test(hay) || /^10\.(48550|1101)\//.test(f.doi || '')) return 'preprint';
    if ((f.url || f.howpublished) && !f.doi && !f.journal) return 'webpage';
    return 'preprint';
  }
  return 'article-journal';
}

function readBalanced(s, i) { // s[i] is '{'; returns [inner, indexAfterClose, ok]
  let d = 0, j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') d++; else if (c === '}' && --d === 0) return [s.slice(i + 1, j), j + 1, true];
  }
  return [s.slice(i + 1), s.length, false];
}

function* bibEntries(text, errors) {
  const macros = { ...MONTHS };
  let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '%' && /^[ \t]*$/.test(text.slice(text.lastIndexOf('\n', i - 1) + 1, i))) { const e = text.indexOf('\n', i); i = e < 0 ? n : e + 1; continue; }
    if (c !== '@') { i++; continue; }
    const tm = /^@\s*([A-Za-z]+)\s*([{(])/.exec(text.slice(i, i + 64));
    if (!tm) { i++; continue; }
    const type = tm[1].toLowerCase(), open = tm[2], close = open === '{' ? '}' : ')';
    i += tm[0].length;
    if (type === 'comment') { if (open === '{') i = readBalanced(text, i - 1)[1]; else { const e = text.indexOf('\n', i); i = e < 0 ? n : e + 1; } continue; }
    if (type === 'preamble') { if (open === '{') i = readBalanced(text, i - 1)[1]; else { const e = text.indexOf(')', i); i = e < 0 ? n : e + 1; } continue; }

    const skipWs = () => { while (i < n && /[\s]/.test(text[i])) i++; };
    const readValue = () => {
      let val = '';
      for (;;) {
        skipWs();
        const ch = text[i];
        if (ch === '{') { const [inner, nx] = readBalanced(text, i); val += inner; i = nx; }
        else if (ch === '"') {
          let d = 0, j = i + 1;
          for (; j < n; j++) { const q = text[j]; if (q === '\\') { j++; continue; } if (q === '{') d++; else if (q === '}') d--; else if (q === '"' && d <= 0) break; }
          val += text.slice(i + 1, j); i = j + 1;
        } else {
          const m = /^[^\s,{}()="#]+/.exec(text.slice(i, i + 200));
          if (!m) break;
          const t = m[0];
          val += /^\d+$/.test(t) ? t : (macros[t.toLowerCase()] != null ? macros[t.toLowerCase()] : t);
          i += t.length;
        }
        skipWs();
        if (text[i] === '#') { i++; continue; }
        break;
      }
      return val;
    };

    if (type === 'string') {
      for (;;) {
        skipWs();
        if (i >= n || text[i] === close) { i++; break; }
        if (text[i] === ',') { i++; continue; }
        const nm = /^[^\s=,{}()"]+/.exec(text.slice(i, i + 200));
        if (!nm) { i++; break; }
        i += nm[0].length; skipWs();
        if (text[i] !== '=') continue;
        i++;
        macros[nm[0].toLowerCase()] = readValue();
      }
      continue;
    }

    // regular entry: key, then name = value pairs
    skipWs();
    const km = /^[^\s,{}()]*/.exec(text.slice(i, i + 300));
    const key = km[0]; i += key.length; skipWs();
    const fields = {}; let ok = false;
    for (;;) {
      skipWs();
      if (i >= n) break;
      if (text[i] === close) { i++; ok = true; break; }
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '@') break; // unterminated entry: stop before the next one
      const nm = /^[^\s=,{}()"]+/.exec(text.slice(i, i + 200));
      if (!nm) { i++; continue; }
      i += nm[0].length; skipWs();
      if (text[i] !== '=') continue;
      i++;
      fields[nm[0].toLowerCase()] = readValue();
    }
    if (!ok && errors) errors.push('BibTeX entry "' + key + '" is not closed');
    yield { type, key, fields };
  }
}

function bibToRef(e) {
  const f = e.fields;
  const g = (...ks) => { for (const k of ks) if (f[k] != null && ws(f[k])) return f[k]; return ''; };
  const type = bibType(e.type, f);
  const authors = andSplit(g('author', 'editor'));
  let container = ws(latex(g('journal', 'journaltitle', 'booktitle', 'website', 'series')));
  if (type === 'book') container = '';
  if (type === 'webpage' && !container) { const hp = g('organization', 'howpublished'); if (!/^(\\url\{)?https?:/i.test(hp.trim())) container = ws(latex(hp)); }
  let doi = cleanDoi(latexRaw(g('doi'))), url = latexRaw(g('url'));
  if (!url && /^https?:\/\//i.test(latexRaw(g('howpublished')))) url = latexRaw(g('howpublished'));
  const ep = g('eprint'), epType = (g('archiveprefix', 'eprinttype')).toLowerCase();
  if (ep && (epType === 'arxiv' || /^\d{4}\.\d{4,5}/.test(ep))) { if (!doi) doi = '10.48550/arXiv.' + ws(ep).replace(/v\d+$/, ''); if (!url) url = 'https://arxiv.org/abs/' + ws(ep); if (!container) container = 'arXiv'; }
  const ref = {
    _key: e.key, type, title: latex(g('title')) || 'Untitled', authors,
    year: yearOf(g('year') || g('date')), container, publisher: latex(g('publisher', 'institution', 'school')),
    volume: latexRaw(g('volume')), pages: cleanPages(latexRaw(g('pages'))), doi, isbn: cleanIsbn(latexRaw(g('isbn'))), url,
  };
  const ab = latex(g('abstract')); if (ab) ref.abstract = ab;
  return ref;
}
function andSplit(s) {
  // split on top-level " and " (case-insensitive), then decode each name part
  const toks = splitTop(ws(s), ' ').filter(Boolean), names = []; let cur = [];
  for (const t of toks) { if (t.toLowerCase() === 'and') { names.push(cur.join(' ')); cur = []; } else cur.push(t); }
  names.push(cur.join(' '));
  return names.map((n) => (/^others$/i.test(n.trim()) ? null : splitName(n))).filter(Boolean)
    .map((a) => ({ f: latex(a.f), g: latex(a.g) })).filter((a) => a.f || a.g);
}

export function parseBibTeX(text, opts = {}) {
  const refs = [];
  for (const e of bibEntries(String(text || '').replace(/^﻿/, ''), opts.errors)) refs.push(bibToRef(e));
  return finalizeRefs(refs, opts, 'BibTeX file');
}

// ---- RIS ----
function risType(t) {
  t = (t || '').toUpperCase();
  if (t === 'BOOK' || t === 'CHAP' || t === 'EBOOK' || t === 'ECHAP' || t === 'EDBOOK') return 'book';
  if (t === 'ELEC' || t === 'WEB' || t === 'BLOG') return 'webpage';
  if (t === 'MGZN' || t === 'NEWS') return 'article-magazine';
  if (t === 'GEN' || t === 'UNPB' || t === 'PPRS') return 'preprint';
  if (t === 'DATA') return 'dataset';
  return 'article-journal';
}
function risName(s) {
  s = ws(s);
  if (!s) return null;
  if (s.includes(',')) { const [f, ...rest] = s.split(','); return { f: f.trim(), g: rest.join(',').trim() }; }
  return splitName(s);
}

export function parseRIS(text, opts = {}) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const recs = []; let cur = null, last = null;
  for (const line of lines) {
    const m = /^([A-Z][A-Z0-9])  ?-[ \t]?(.*)$/.exec(line);
    if (m) {
      const tag = m[1], val = m[2];
      if (tag === 'TY') { cur = { TY: val.trim(), tags: [] }; recs.push(cur); last = null; continue; }
      if (tag === 'ER') { cur = null; last = null; continue; }
      if (!cur) continue;
      last = [tag, val]; cur.tags.push(last);
    } else if (cur && last && line.trim()) last[1] += ' ' + line.trim();
  }
  const refs = recs.map((r) => {
    const first = (...ts) => { for (const t of ts) { const e = r.tags.find((x) => x[0] === t && ws(x[1])); if (e) return ws(e[1]); } return ''; };
    const all = (...ts) => r.tags.filter((x) => ts.includes(x[0])).map((x) => x[1]);
    const type = risType(r.TY);
    const authors = all('AU', 'A1').map(risName).filter(Boolean);
    const sn = first('SN');
    const sp = first('SP'), ep = first('EP');
    const ref = {
      _key: first('ID'), type, title: first('TI', 'T1') || 'Untitled', authors,
      year: yearOf(first('PY', 'Y1', 'DA')), container: type === 'book' ? '' : first('JO', 'JF', 'T2', 'JA'),
      publisher: first('PB'), volume: first('VL'), pages: cleanPages(sp && ep ? sp + '-' + ep : sp), doi: cleanDoi(first('DO')),
      isbn: sn && (type === 'book' || isIsbn(sn)) ? cleanIsbn(sn) : '', url: first('UR', 'L1'),
    };
    const ab = first('AB', 'N2'); if (ab) ref.abstract = ab;
    const acc = first('Y2'); if (acc) ref.accessed = acc;
    return ref;
  });
  return finalizeRefs(refs, opts, 'RIS file');
}

// ---- CSL-JSON ----
function cslType(t) {
  t = String(t || '');
  if (['article-journal', 'book', 'preprint', 'dataset', 'webpage', 'article-magazine'].includes(t)) return t;
  if (t === 'article') return 'preprint';
  if (t === 'article-newspaper') return 'article-magazine';
  if (t === 'post-weblog' || t === 'post' || t === 'webpage') return 'webpage';
  if (t === 'chapter' || t === 'entry-encyclopedia') return 'book';
  return 'article-journal';
}
const cslStr = (v) => ws(Array.isArray(v) ? v[0] : v);

export function parseCSLJSON(text, opts = {}) {
  let data = typeof text === 'string' ? JSON.parse(text.replace(/^﻿/, '')) : text;
  if (data && !Array.isArray(data) && Array.isArray(data.items)) data = data.items;
  if (!Array.isArray(data)) data = data && typeof data === 'object' ? [data] : [];
  const refs = data.filter((o) => o && typeof o === 'object').map((o) => {
    const authors = (Array.isArray(o.author) ? o.author : []).map((a) => {
      if (!a || typeof a !== 'object') return null;
      if (a.family || a.given) return { f: ws(a.family), g: ws(a.given) };
      return a.literal || a.name ? { f: ws(a.literal || a.name), g: '' } : null;
    }).filter(Boolean);
    const iss = o.issued || o['published-print'] || o.published;
    let year = '';
    if (iss) { const dp = iss['date-parts'] && iss['date-parts'][0]; year = yearOf(dp ? dp[0] : iss.raw || iss.literal || (typeof iss === 'string' ? iss : '')); }
    const type = cslType(o.type);
    const ref = {
      _key: ws(o.id || o['citation-key'] || ''), type, title: cslStr(o.title) || 'Untitled', authors, year,
      container: cslStr(o['container-title']), publisher: cslStr(o.publisher), volume: cslStr(o.volume != null ? String(o.volume) : ''),
      pages: cleanPages(cslStr(o.page != null ? String(o.page) : '')), doi: cleanDoi(cslStr(o.DOI)), isbn: cleanIsbn(cslStr(o.ISBN)), url: cslStr(o.URL),
    };
    const ab = cslStr(o.abstract); if (ab) ref.abstract = ab;
    return ref;
  });
  return finalizeRefs(refs, opts, 'CSL-JSON file');
}

// CSL-JSON item shapes Arf accepts: a known CSL type or a title, plus an author list or an issued date. Anything
// else (package.json, settings files) is not a reference file.
const CSL_TYPES = new Set(['article', 'article-journal', 'article-magazine', 'article-newspaper', 'bill', 'book', 'broadcast', 'chapter', 'classic',
  'collection', 'dataset', 'document', 'entry', 'entry-dictionary', 'entry-encyclopedia', 'event', 'figure', 'graphic', 'hearing', 'interview',
  'legal_case', 'legislation', 'manuscript', 'map', 'motion_picture', 'musical_score', 'pamphlet', 'paper-conference', 'patent', 'performance',
  'periodical', 'personal_communication', 'post', 'post-weblog', 'regulation', 'report', 'review', 'review-book', 'software', 'song', 'speech',
  'standard', 'thesis', 'treaty', 'webpage']);
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
function cslShaped(o) {
  if (!isPlain(o)) return false;
  const head = (typeof o.title === 'string' && o.title.trim()) || (typeof o.type === 'string' && CSL_TYPES.has(o.type));
  const authors = Array.isArray(o.author) && o.author.length > 0 && o.author.every(isPlain);
  const issued = isPlain(o.issued) || (typeof o.issued === 'string' && /\d{4}/.test(o.issued));
  return !!head && (authors || issued);
}
const arfShaped = (r) => isPlain(r) && typeof r.citekey === 'string' && Array.isArray(r.authors);
const UNRECOGNIZED = 'Unrecognized reference format (expected BibTeX, RIS or CSL-JSON).';

// Sniff the format from content (extension only breaks ties). -> {refs, format, errors, keyMap}
// keyMap: original citekey -> assigned citekey, for every key renamed to stay unique in the library.
export function importReferences(text, filename = '', opts = {}) {
  const errors = [], keyMap = {};
  const t = String(text || '').replace(/^﻿/, '');
  const trimmed = t.trim();
  const ext = (/\.([A-Za-z0-9]+)$/.exec(filename) || [])[1] || '';
  const o = { ...opts, errors, keyMap };
  if (!trimmed) return { refs: [], format: 'unknown', errors: ['The file is empty.'], keyMap };
  let format = 'unknown';
  if (/^[[{]/.test(trimmed)) format = 'csl-json';
  else if (/(^|\n)\s*TY {1,2}- /.test(t)) format = 'ris';
  else if (/(^|\n)\s*@\s*[A-Za-z]+\s*[{(]/.test(t)) format = 'bibtex';
  else if (/^(json)$/i.test(ext)) format = 'csl-json'; else if (/^(ris|enw)$/i.test(ext)) format = 'ris'; else if (/^(bib|bibtex)$/i.test(ext)) format = 'bibtex';
  if (format === 'unknown') return { refs: [], format, errors: [UNRECOGNIZED], keyMap };
  try {
    let refs;
    if (format === 'csl-json') {
      const j = JSON.parse(trimmed);
      const arr = Array.isArray(j) ? j : (j && Array.isArray(j.items) ? j.items : (j && typeof j === 'object' ? [j] : []));
      // an Arf references.json (authors as {f,g}, citekey) is accepted as-is
      if (arr.length && arr.every(arfShaped)) {
        format = 'arf-json';
        refs = arr.map((r) => ({ ...r, authors: r.authors.filter((a) => a && typeof a === 'object').map((a) => ({ ...a, f: a.f || '', g: a.g || '' })) }));
        const ex = opts.existingRefs || [];
        const seen = new Set(ex.map((r) => r.citekey)), ids = new Set(ex.map((r) => r.id)), batch = new Set();
        for (const r of refs) {
          let k = r.citekey; const base = k;
          for (let i = 0; seen.has(k) || ids.has('r_' + k); i++) k = base + (i < 25 ? String.fromCharCode(98 + i) : String(i - 23));
          // the notes of this import cite the renamed ref by its old key, unless an earlier entry here kept that key
          if (base !== k && !batch.has(base) && !(base in keyMap)) keyMap[base] = k;
          batch.add(k);
          // keep the ref's own id (e.g. a Gutenberg 'r_<key>_g<n>') unless it is missing or taken
          r.citekey = k; r.id = typeof r.id === 'string' && r.id && !ids.has(r.id) ? r.id : 'r_' + k;
          seen.add(k); ids.add(r.id);
        }
      } else {
        // the file is CSL-JSON when at least one item has the full shape; then every item with a title or a known
        // type imports (a webpage may lack authors and a date), and the rest are reported
        if (!arr.some(cslShaped)) return { refs: [], format: 'unknown', errors: [UNRECOGNIZED], keyMap };
        const items = arr.filter((x) => isPlain(x) && ((typeof x.title === 'string' && x.title.trim()) || (typeof x.type === 'string' && CSL_TYPES.has(x.type))));
        if (items.length < arr.length) errors.push('Skipped ' + (arr.length - items.length) + ' item' + (arr.length - items.length === 1 ? '' : 's') + ' with neither a title nor a CSL type.');
        refs = parseCSLJSON(items, o);
      }
    } else if (format === 'ris') refs = parseRIS(t, o);
    else refs = parseBibTeX(t, o);
    if (!refs.length) errors.push('No references found in the file.');
    return { refs, format, errors, keyMap };
  } catch (e) {
    return { refs: [], format, errors: ['Could not parse the ' + format + ' file: ' + (e && e.message ? e.message : e)], keyMap };
  }
}
