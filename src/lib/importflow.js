// Glue between the pure importers and App: route picked/dropped files by kind, point imported image
// links at the copies stored in the vault, merge imported notes, and word the result. Pure, no DOM.

import { mergeByUpdated } from './sync.js';

export const IMG_RE = /\.(png|jpe?g|gif|webp|svg)$/i;   // the image kinds importers.js copies out of a zip
const KINDS = [
  ['notes', /\.(md|markdown)$/i], ['zip', /\.zip$/i], ['refs', /\.(bib|bibtex|ris|json)$/i], ['arf', /\.arf$/i], ['image', IMG_RE],
];
// 'notes' | 'zip' | 'refs' | 'arf' | 'image' | null, from the file name
export function importKind(name) {
  const n = String(name || '');
  for (const [k, re] of KINDS) if (re.test(n)) return k;
  return null;
}

// A picked folder's files are named "<folder>/<path>" (webkitRelativePath, or relative to the picked
// root): drop that shared first segment so notes land where they sat inside the folder.
export function stripTopFolder(paths) {
  const ps = paths.map((p) => String(p || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  if (!ps.length || !ps.every((p) => p.includes('/'))) return ps;
  const top = ps[0].slice(0, ps[0].indexOf('/') + 1);
  return ps.every((p) => p.startsWith(top)) ? ps.map((p) => p.slice(top.length)) : ps;
}

function decode(s) { try { return decodeURI(s); } catch (e) { return s; } }
// a Markdown link destination for a stored path: only the characters that would end or break it are escaped
export function encodeLinkPath(p) { return String(p).replace(/%/g, '%25').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29'); }
// resolve a/./b/../c without leaving the root; null when it climbs out
function resolvePath(p) {
  const out = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { if (!out.length) return null; out.pop(); } else out.push(s);
  }
  return out.join('/');
}

export const STORE_PREFIX = 'attachments/images/';
// the vault path of an imported image: content-addressed like a pasted one (App's bytesHash), keeping the
// source extension, so a different image with the same name can never replace another
export function hashedImagePath(hash, srcPath) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(String(srcPath)) || [])[1];
  return STORE_PREFIX + hash + '.' + (ext ? ext.toLowerCase() : 'png');
}

// Point each note's bare image links (![alt](src) outside code) at the stored copies. `target` is a prefix
// (stored path = prefix + asset path) or a Map from asset path to stored path (assets missing from the Map
// keep their links). A link resolves relative to the note's folder, then to the import root, then by a
// unique file name anywhere in the import (Obsidian's shortest-path embeds). External links stay; a link
// already under attachments/images/ is rewritten only when it names an asset of this import exactly (an
// Arf export re-imported), never by file name.
// -> { notes (new objects where a body changed), rewritten (link count), used (asset paths linked) }
export function rewriteImageLinks(notes, assetPaths, target = STORE_PREFIX) {
  const assets = new Set(assetPaths.map((p) => resolvePath(String(p).replace(/\\/g, '/'))).filter(Boolean));
  const dest = (p) => (typeof target === 'string' ? target + p : target.get(p) || null);
  const byName = new Map();
  for (const p of assets) { const k = p.slice(p.lastIndexOf('/') + 1).toLowerCase(); byName.set(k, byName.has(k) ? null : p); }
  let rewritten = 0;
  const used = new Set();
  const find = (folder, src) => {
    const raw = decode(src.replace(/^<|>$/g, '').replace(/^\.\//, ''));
    if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(raw)) return null;
    for (const c of [folder ? folder + '/' + raw : raw, raw]) { const r = resolvePath(c); if (r && assets.has(r)) return r; }
    if (raw.startsWith(STORE_PREFIX)) return null;
    return byName.get(raw.slice(raw.lastIndexOf('/') + 1).toLowerCase()) || null;
  };
  const out = notes.map((n) => {
    if (!n.body || n.body.indexOf('![') < 0) return n;
    let fence = null;
    const body = n.body.split('\n').map((line) => {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; return line; }
      if (fence) return line;
      return line.replace(/(`[^`]*`)|(!\[[^\]]*\]\()(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?\))/g, (m, code, open, src, close) => {
        if (code) return m;
        const hit = find(n.folder || '', src);
        const to = hit && dest(hit);
        if (!to) return m;
        used.add(hit);
        rewritten++;
        return open + encodeLinkPath(to) + close;
      });
    }).join('\n');
    return body === n.body ? n : { ...n, body };
  });
  return { notes: out, rewritten, used };
}

// apply fn to each line outside fenced code, and to each segment outside inline code spans
function outsideCode(text, fn) {
  let fence = null;
  return text.split('\n').map((line) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) fence = f[1][0]; else if (fence === f[1][0]) fence = null; return line; }
    if (fence) return line;
    return line.split(/(`[^`]*`)/).map((seg, i) => (i % 2 ? seg : fn(seg))).join('');
  }).join('\n');
}
// a citekey rename map applied after another: old -> final key, dropping keys that end where they began.
// A key the first stage produced by renaming never stood in the notes, so it is not a source key itself.
export function composeKeyMaps(first, second) {
  const out = {};
  const made = new Set(Object.entries(first || {}).filter(([k, v]) => k !== v).map(([, v]) => v));
  const keys = new Set([...Object.keys(first || {}), ...Object.keys(second || {}).filter((k) => !made.has(k) || (first && k in first))]);
  for (const k of keys) {
    const mid = (first && first[k]) || k;
    const fin = (second && second[mid]) || mid;
    if (fin !== k) out[k] = fin;
  }
  return out;
}
// rewrite [@key] / [@!key] / [@+key] (markdown.js's cite syntax) outside code, by an old -> new key map
export function rewriteCitekeys(notes, keyMap) {
  if (!keyMap || !Object.keys(keyMap).length) return notes;
  const has = Object.prototype.hasOwnProperty;
  return notes.map((n) => {
    if (!n.body || n.body.indexOf('[@') < 0) return n;
    const body = outsideCode(n.body, (s) => s.replace(/\[@([+!]?)([A-Za-z0-9_:.-]+)\]/g, (m, mode, key) => (has.call(keyMap, key) ? '[@' + mode + keyMap[key] + ']' : m)));
    return body === n.body ? n : { ...n, body };
  });
}

const sameText = (a, b) => String(a || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '') === String(b || '').replace(/\r\n?/g, '\n').replace(/\s+$/, '');
const stripMarks = (n) => { if (!n._noId && !n._undated) return n; const { _noId, _undated, ...rest } = n; return rest; };

// Merge imported notes into the vault. A same-id note keeps its file path here (else the vault would
// write a second file for it); mergeByUpdated decides which version wins. Two importer markers:
// _noId (no frontmatter id): an existing note with the same title and body is this note, re-imported, so
// it is reported unchanged instead of added twice; _undated (id match, no date): the vault's copy stays.
// -> { notes, added: ids, merged: ids (replaced an older copy), unchanged: ids (this vault's copy kept) }
export function planImport(existing, incoming) {
  const before = new Map(existing.map((n) => [n.id, n]));
  const unchanged = [], rest = [];
  let byTitle = null;   // built on first need: title -> existing notes (only same-title notes compare bodies)
  for (const n0 of incoming) {
    const n = stripMarks(n0);
    if (n0._noId) {
      if (!byTitle) { byTitle = new Map(); for (const e of existing) { const k = e.title || ''; if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(e); } }
      const twin = (byTitle.get(n.title || '') || []).find((e) => sameText(e.body, n.body));
      if (twin) { unchanged.push(twin.id); continue; }
    }
    if (n0._undated && before.has(n.id)) { unchanged.push(n.id); continue; }
    rest.push(before.has(n.id) ? { ...n, _path: before.get(n.id)._path } : n);
  }
  const notes = mergeByUpdated(existing, rest);
  const kept = new Set(notes);
  const added = [], merged = [];
  for (const n of rest) (!before.has(n.id) ? added : kept.has(n) ? merged : unchanged).push(n.id);
  return { notes, added, merged, unchanged };
}

// Vault-relative files an export should carry: images the notes link under attachments/images/ (decoded
// link paths) and each reference's attachment. Sorted, de-duplicated, never outside attachments/.
export function attachmentPaths(notes, refs) {
  const out = new Set();
  const ok = (p) => { const r = resolvePath(String(p || '').replace(/\\/g, '/')); if (r && /^attachments\//.test(r)) out.add(r); };
  for (const n of notes || []) {
    if (!n.body || n.body.indexOf(STORE_PREFIX) < 0) continue;
    outsideCode(n.body, (s) => { s.replace(/!\[[^\]]*\]\((<[^>]*>|[^)\s]+)/g, (m, src) => { ok(decode(src.replace(/^<|>$/g, ''))); return m; }); return s; });
  }
  for (const r of refs || []) if (r && r.attachment && r.attachment.path) ok(r.attachment.path);
  return [...out].sort();
}

// YYYY-MM-DD in local time (an export at 01:00 must carry today's date, not yesterday's UTC one)
export function localDate(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

const REASONS = { 'not-markdown': 'not Markdown', hidden: 'hidden', 'too-large': 'too large', 'not-text': 'unreadable', 'empty-path': 'no name' };
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
// One line for the result of an import. s: { added, merged, unchanged, skipped:[{reason}], refsAdded,
// refsDuplicates, images, imagesSkipped, imagesTooLarge, files, errors:[string] } — every field optional.
export function importSummary(s) {
  const parts = [];
  const added = s.added || 0, merged = s.merged || 0, unchanged = s.unchanged || 0, notes = added + merged;
  if (notes) parts.push('Imported ' + plural(notes, 'note') + ' (' + added + ' new, ' + merged + ' merged).');
  if (unchanged) parts.push(plural(unchanged, 'note') + ' already up to date.');
  const skipped = s.skipped || [];
  if (skipped.length) {
    const by = new Map();
    for (const k of skipped) { const r = REASONS[k.reason] || k.reason || 'other'; by.set(r, (by.get(r) || 0) + 1); }
    parts.push('Skipped ' + skipped.length + ': ' + [...by].map(([r, c]) => c + ' ' + r).join(', ') + '.');
  }
  if (s.refsAdded || s.refsDuplicates) parts.push(plural(s.refsAdded || 0, 'reference') + ' added' + (s.refsDuplicates ? ', ' + plural(s.refsDuplicates, 'duplicate') + ' skipped' : '') + '.');
  if (s.images) parts.push(plural(s.images, 'image') + ' copied to the vault.');
  if (s.imagesSkipped) parts.push(plural(s.imagesSkipped, 'image') + ' not copied (needs the desktop app with a vault folder).');
  if (s.imagesTooLarge) parts.push(plural(s.imagesTooLarge, 'image') + ' over 25 MB not copied.');
  if (s.files) parts.push(plural(s.files, 'reference file') + ' restored.');
  const errs = s.errors || [];
  const ok = notes || unchanged || s.refsAdded || s.refsDuplicates || s.images || s.files;
  if (errs.length) parts.push(errs.join(' '));
  if (!parts.length) return '⚠ Nothing to import.';
  return (ok ? '✓ ' : '⚠ ') + parts.join(' ');
}
