// Exporters: the whole vault as a portable .zip (notes as Markdown files in their folders,
// plus the reference library as BibTeX and JSON). Pure; the caller writes the bytes.

import { zipSync, strToU8 } from 'fflate';
import { serialize, slug } from './vaultadapter.js';
import { canonFolder } from './folders.js';
import { joinRefs } from './cite.js';

// Same path rule as vaultadapter's (unexported) relPath: canonical folder + slug(title) + optional suffix + .md.
// canonFolder applies the identical segment sanitising (drop ''/'.'/'..', trailing dot/space, reserved names).
export function notePath(note, suffix) {
  const dir = canonFolder(note.folder);
  return (dir ? dir + '/' : '') + slug(note.title) + (suffix ? '-' + suffix : '') + '.md';
}

// path per note id. The oldest note keeps the plain name; a clash gets the vault's own suffix (last 5
// id characters, lower-case), then a counter if even that collides. Compared case-insensitively
// because Windows/macOS extractors fold case.
export function planNotePaths(notes) {
  const order = [...notes].sort((a, b) => ((a.created || '') < (b.created || '') ? -1 : (a.created || '') > (b.created || '') ? 1 : String(a.id) < String(b.id) ? -1 : 1));
  const taken = new Set(), out = new Map();
  for (const n of order) {
    let p = notePath(n);
    if (taken.has(p.toLowerCase())) p = notePath(n, String(n.id).slice(-5).toLowerCase());
    for (let i = 2; taken.has(p.toLowerCase()); i++) p = notePath(n, String(n.id).slice(-5).toLowerCase() + '-' + i);
    taken.add(p.toLowerCase()); out.set(n.id, p);
  }
  return out;
}

// opts: {now: ISO string, date: 'YYYY-MM-DD' for the README (local day; default the UTC day of now),
// includeBib: true, attachments: [{path, bytes}] vault files under attachments/ (images, reference files)}
export function exportVaultZip(notes, folders, refs, opts = {}) {
  notes = Array.isArray(notes) ? notes : []; refs = Array.isArray(refs) ? refs : [];
  const now = opts.now || new Date().toISOString();
  const mtime = new Date(now);
  const fileOpts = { level: 6, mtime: isNaN(mtime.getTime()) ? new Date(0) : mtime };
  const files = {};
  const paths = planNotePaths(notes);
  for (const n of notes) files[paths.get(n.id)] = [strToU8(serialize(n)), fileOpts];

  // folders holding nothing (no note, no subfolder) become directory entries so they survive the round trip
  const all = new Set();
  const add = (f) => { let cur = ''; for (const s of canonFolder(f).split('/')) { if (!s) continue; cur = cur ? cur + '/' + s : s; all.add(cur); } };
  (folders || []).forEach(add);
  notes.forEach((n) => add(n.folder));
  const used = new Set();
  for (const p of paths.values()) { let i = p.lastIndexOf('/'); while (i > 0) { used.add(p.slice(0, i)); i = p.lastIndexOf('/', i - 1); } }
  for (const f of [...all].sort()) if (!used.has(f)) files[f + '/'] = [new Uint8Array(0), { level: 0, mtime: fileOpts.mtime }];

  const withBib = opts.includeBib !== false && refs.length > 0;
  if (withBib) {
    files['references.bib'] = [strToU8(joinRefs(refs, 'BibTeX') + '\n'), fileOpts];
    files['references.json'] = [strToU8(JSON.stringify(refs, null, 2) + '\n'), fileOpts];
  }
  // attachments/ (note images, reference PDFs/EPUBs): stored, not deflated (mostly compressed already)
  let nAtt = 0;
  for (const a of Array.isArray(opts.attachments) ? opts.attachments : []) {
    const p = String((a && a.path) || '').replace(/\\/g, '/');
    if (!/^attachments\/[^]+/.test(p) || p.split('/').some((s) => !s || s === '.' || s === '..') || !(a.bytes instanceof Uint8Array) || files[p]) continue;
    files[p] = [a.bytes, { level: 0, mtime: fileOpts.mtime }]; nAtt++;
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(opts.date || '') ? opts.date : now.slice(0, 10);
  const readme = [
    'Arf export',
    '',
    'Exported by Arf on ' + date + '.',
    '',
    'This archive holds ' + notes.length + ' note' + (notes.length === 1 ? '' : 's') + ' as plain Markdown files, placed in the same folders they had in Arf.',
    'Each file starts with a short YAML block (id, title, tags, created, updated).',
    withBib ? 'references.bib and references.json hold the ' + refs.length + ' reference' + (refs.length === 1 ? '' : 's') + ' of the library (BibTeX and Arf JSON).' : 'No references were included.',
    nAtt ? 'attachments/ holds ' + nAtt + ' file' + (nAtt === 1 ? '' : 's') + ' from the vault: images the notes show and files attached to references.'
      : 'No attachments were included (images and reference files are only exported from the desktop app with a vault folder).',
    '',
    'To restore it, use Import in Arf and choose this .zip file.' + (nAtt ? ' Images and reference files come back with it.' : ''),
    '',
  ].join('\n');
  files['README.txt'] = [strToU8(readme), fileOpts];
  return zipSync(files);
}
