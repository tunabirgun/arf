import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { importMarkdownFiles, importZip, parseBibTeX, parseRIS, parseCSLJSON, importReferences, mergeImportedRefs, mkCitekey } from '../../src/lib/importers.js';
import { formatRef, joinRefs } from '../../src/lib/cite.js';
import { ulid } from '../../src/lib/vault.js';

const FX = join(import.meta.dirname, 'fixtures', 'import');
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, out); else out.push(p); }
  return out;
}
const vaultFiles = () => walk(join(FX, 'vault')).map((p) => ({ path: relative(join(FX, 'vault'), p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));
const NOW = '2025-01-01T00:00:00.000Z';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const byTitle = (r, t) => r.notes.find((n) => n.title === t);

describe('importMarkdownFiles: Obsidian vault fixture', () => {
  const r = importMarkdownFiles(vaultFiles(), { now: NOW });
  it('imports the markdown files, skips hidden and non-md', () => {
    expect(r.notes).toHaveLength(5);
    expect(r.notes.map((n) => n.title).sort()).toEqual(['Alpha Plan', 'Daily 2024-01-05', 'Window Note', 'plain', 'Şeker İşleme'].sort());
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['hidden', 'not-markdown']);
    expect(r.notes.every((n) => ULID.test(n.id))).toBe(true);
    expect(new Set(r.notes.map((n) => n.id)).size).toBe(5);
  });
  it('YAML list tags, # prefix stripped, H1 as title and stripped from body', () => {
    const n = byTitle(r, 'Daily 2024-01-05');
    expect(n.tags).toEqual(['daily', 'journal']);
    expect(n.folder).toBe('Daily');
    expect(n.body).toBe('Met [[Plan]] today.');
    expect(n.created).toBe(new Date('2024-01-05 09:30').toISOString());
    expect(n.updated).toBe(n.created);
  });
  it('reports aliases and dropped unknown frontmatter keys', () => {
    expect(r.report.aliases).toEqual([{ path: 'Daily/2024-01-05.md', aliases: ['today', 'Jan 5'] }]);
    expect(r.report.droppedFrontmatter).toEqual([{ path: 'Daily/2024-01-05.md', keys: ['cssclass'] }]);
  });
  it('inline-list tags, dates, nested folders, embeds', () => {
    const n = byTitle(r, 'Alpha Plan');
    expect(n.tags).toEqual(['project', 'machine learning']);
    expect(n.folder).toBe('Projects/Alpha');
    expect(n.created).toBe('2023-12-01T08:00:00.000Z');
    expect(n.updated).toBe('2024-02-01T10:00:00.000Z');
    expect(n.body).toContain('![](diagram.png)');
    expect(n.body).toContain('![[Other note]]');       // non-image embed untouched
    expect(n.body).toContain('![[inside-code.png]]');  // not converted inside a code fence
    expect(n.body).toContain('[[Daily]]');
    expect(r.report.embedsConverted).toBe(1);
  });
  it('string tags, Turkish names, no-frontmatter and filename titles', () => {
    const t = byTitle(r, 'Şeker İşleme');
    expect(t.tags).toEqual(['kimya', 'biyoloji']);
    expect(t.folder).toBe('Ünite');
    expect(t.body).toContain('## Alt başlık');
    expect(byTitle(r, 'plain').body).toBe('Just text, no frontmatter.');
    expect(byTitle(r, 'plain').created).toBe(NOW);
    expect(byTitle(r, 'plain').folder).toBe('');
  });
  it('CRLF files lose their carriage returns', () => {
    expect(byTitle(r, 'Window Note').body).toBe('line one\nline two');
    expect(r.notes.every((x) => !x.body.includes('\r'))).toBe(true);
  });
  it('returns all ancestor folders sorted', () => {
    expect(r.folders).toEqual(['Daily', 'Projects', 'Projects/Alpha', 'Ünite']);
  });
  it('is deterministic apart from fresh ids (input order does not matter)', () => {
    const strip = (x) => x.notes.map(({ id, ...rest }) => rest);
    expect(strip(importMarkdownFiles(vaultFiles().reverse(), { now: NOW }))).toEqual(strip(r));
  });
});

describe('importMarkdownFiles: frontmatter and options', () => {
  const one = (text, opts = {}, path = 'a.md') => importMarkdownFiles([{ path, text }], { now: NOW, ...opts });
  it('Arf frontmatter round-trips (quoted title, ids kept, *_local ignored)', () => {
    const id = ulid();
    const r = one('---\nid: ' + id + '\ntitle: "He said \\"hi\\" \\\\ ok"\ntags: [a, b]\ncreated: 2024-03-05T10:00:00.000Z\nupdated: 2024-03-06T10:00:00.000Z\ncreated_local: 2024-03-05T13:00:00+03:00\n---\n\nBody\n');
    expect(r.notes[0]).toEqual({ id, title: 'He said "hi" \\ ok', folder: '', tags: ['a', 'b'], created: '2024-03-05T10:00:00.000Z', updated: '2024-03-06T10:00:00.000Z', body: 'Body' });
    expect(r.report.droppedFrontmatter).toEqual([]);
  });
  it('keepUnknownFrontmatter re-emits unknown keys in a yaml fence', () => {
    const r = one('---\ntitle: T\nlayout: post\ncategories:\n  - x\n  - y\n---\nHello', { keepUnknownFrontmatter: true });
    expect(r.notes[0].body).toBe('```yaml\nlayout: post\ncategories:\n  - x\n  - y\n```\n\nHello');
    expect(r.report.keptFrontmatter).toBe(1);
  });
  it('comma string tags, single-quoted and folded scalars', () => {
    const r = one("---\ntitle: 'It''s here'\ntags: '#a, #b c, a'\n---\nx");
    expect(r.notes[0].title).toBe("It's here");
    expect(r.notes[0].tags).toEqual(['a', 'b c']);
    expect(one('---\ntitle: >\n  folded\n  title\n---\nx').notes[0].title).toBe('folded title');
  });
  it('an H1 is only stripped when it supplied the title, and only if it leads the body', () => {
    expect(one('---\ntitle: Same\n---\n# Same\n\nbody').notes[0].body).toBe('# Same\n\nbody');
    const r = one('intro line\n\n# Later Title\n\ntext');
    expect(r.notes[0].title).toBe('Later Title');
    expect(r.notes[0].body).toBe('intro line\n\n# Later Title\n\ntext');
    expect(one('```\n# not a title\n```\n').notes[0].title).toBe('a');
  });
  it('a leading horizontal rule is not mistaken for frontmatter', () => {
    expect(one('---\njust some prose here\n---\nmore').notes[0].body).toContain('just some prose here');
  });
  it('unparseable dates fall back to now; updated falls back to created', () => {
    expect(one('---\ncreated: yesterday-ish\n---\nx').notes[0].created).toBe(NOW);
    expect(one('---\ndate: 2020-02-02\n---\nx').notes[0].updated).toBe('2020-02-02T00:00:00.000Z');
  });
  it('convertEmbeds:false leaves embeds alone; names with spaces are percent-encoded', () => {
    expect(one('![[a.png]]', { convertEmbeds: false }).notes[0].body).toBe('![[a.png]]');
    expect(one('![[my pic.JPG]]').notes[0].body).toBe('![](my%20pic.JPG)');
  });
  it('folder from backslash paths, dot segments dropped, reserved names fixed', () => {
    const r = importMarkdownFiles([{ path: 'x\\..\\./Notes\\con/b.md', text: 'x' }], { now: NOW });
    expect(r.notes[0].folder).toBe('x/Notes/con-');
    expect(r.skipped).toEqual([]);
  });
  it('skips empty path, oversize and non-text', () => {
    const r = importMarkdownFiles([{ path: '', text: 'x' }, { path: 'big.md', text: 'a'.repeat(100) }, { path: 'n.md', text: null }, { path: 'ok.md', text: 'y' }], { now: NOW, maxBytes: 50 });
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['empty-path', 'not-text', 'too-large']);
    expect(r.notes.map((n) => n.title)).toEqual(['ok']);
  });
  it('multibyte size is measured in bytes', () => {
    expect(importMarkdownFiles([{ path: 'u.md', text: 'ş'.repeat(30) }], { now: NOW, maxBytes: 50 }).skipped[0].reason).toBe('too-large');
  });
  it('duplicate filenames in different folders both import', () => {
    const r = importMarkdownFiles([{ path: 'A/x.md', text: 'one' }, { path: 'B/x.md', text: 'two' }, { path: 'A/x.md', text: 'three' }], { now: NOW });
    expect(r.notes.map((n) => n.folder + ':' + n.body).sort()).toEqual(['A:one', 'A:three', 'B:two']);
    expect(new Set(r.notes.map((n) => n.id)).size).toBe(3);
  });
});

describe('importMarkdownFiles: id handling', () => {
  const id = ulid();
  const text = '---\nid: ' + id + '\ntitle: Mine\n---\nbody';
  it('keeps a valid free ULID', () => {
    expect(importMarkdownFiles([{ path: 'm.md', text }], { now: NOW }).notes[0].id).toBe(id);
  });
  it('an exact id match is the same note even when its title or folder changed (mergeByUpdated decides)', () => {
    const existing = [{ id, title: 'Other', folder: 'Projects', tags: [], created: NOW, updated: NOW, body: '' }];
    const r = importMarkdownFiles([{ path: 'm.md', text }], { now: NOW, existing });
    expect(r.notes[0].id).toBe(id);
    expect(r.report.idsReassigned).toBe(0);
  });
  it('keeps the id when it is the same note (same title + folder), so a re-import merges', () => {
    const existing = [{ id, title: 'Mine', folder: '', tags: [], created: NOW, updated: NOW, body: 'old' }];
    expect(importMarkdownFiles([{ path: 'm.md', text }], { now: NOW, existing }).notes[0].id).toBe(id);
  });
  it('keeps any well-formed id; mints one only for a malformed id or an in-batch duplicate', () => {
    const r = importMarkdownFiles([
      { path: 'a.md', text: '---\nid: not-a-ulid\n---\na' },
      { path: 'b.md', text: '---\nid: ' + id + '\n---\nb' },
      { path: 'c.md', text: '---\nid: ' + id + '\n---\nc' },
      { path: 'd.md', text: '---\nid: "bad\\nid"\n---\nd' },
    ], { now: NOW });
    expect(r.notes[0].id).toBe('not-a-ulid');
    expect(r.notes[1].id).toBe(id);
    expect(r.notes[2].id).not.toBe(id);
    expect(r.notes[3].id).not.toMatch(/\n/);
    expect(ULID.test(r.notes[3].id)).toBe(true);
    expect(r.report.idsReassigned).toBe(2);
  });
  it('keeps non-ULID vault ids (conflict copies, path ids, hash ids) so a restore merges', () => {
    const ids = ['conflict_lx3k9a', 'Projects/old.md', 'n12345'];
    const existing = ids.map((x) => ({ id: x, title: 'T ' + x, folder: '', tags: [], created: NOW, updated: NOW, body: 'b' }));
    const r = importMarkdownFiles(ids.map((x, i) => ({ path: i + '.md', text: '---\nid: ' + x + '\ntitle: "T ' + x + '"\nupdated: ' + NOW + '\n---\nb' })), { now: NOW, existing });
    expect(r.notes.map((n) => n.id)).toEqual(ids);
  });
  it('loose files keep the existing note’s folder on an id match; folder imports move it', () => {
    const existing = [{ id, title: 'Mine', folder: 'Projects', tags: [], created: NOW, updated: NOW, body: 'old' }];
    expect(importMarkdownFiles([{ path: 'm.md', text }], { now: NOW, existing, loose: true }).notes[0].folder).toBe('Projects');
    expect(importMarkdownFiles([{ path: 'm.md', text }], { now: NOW, existing }).notes[0].folder).toBe('');
  });
  it('marks a note without an id (_noId) and an undated id match (_undated) for planImport', () => {
    const existing = [{ id, title: 'Mine', folder: '', tags: [], created: NOW, updated: NOW, body: 'old' }];
    const r = importMarkdownFiles([{ path: 'm.md', text }, { path: 'n.md', text: 'no id' }], { now: NOW, existing });
    expect(r.notes[0]._undated).toBe(true);
    expect(r.notes[1]._noId).toBe(true);
    const dated = importMarkdownFiles([{ path: 'm.md', text: '---\nid: ' + id + '\nupdated: 2026-01-01\n---\nnew' }], { now: NOW, existing });
    expect(dated.notes[0]._undated).toBeUndefined();
  });
});

describe('importMarkdownFiles / importZip: the reserved root attachments folder', () => {
  const z = (obj) => zipSync(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));
  it('maps a root attachments folder (any case) to attachments-notes', () => {
    const r = importMarkdownFiles([{ path: 'attachments/drawing.md', text: 'x' }, { path: 'Attachments/Sub/b.md', text: 'y' }, { path: 'Notes/attachments/c.md', text: 'z' }], { now: NOW });
    expect(r.notes.map((n) => n.folder).sort()).toEqual(['Attachments-notes/Sub', 'Notes/attachments', 'attachments-notes']);
    expect(r.folders).not.toContain('attachments');
  });
  it('a zip’s root attachments/ notes land in attachments-notes; an empty attachments/ entry adds no folder', () => {
    const r = importZip(z({ 'V/attachments/drawing.md': 'x', 'V/attachments/': new Uint8Array(0), 'V/a.md': 'a' }), { now: NOW });
    expect(r.notes.map((n) => n.folder).sort()).toEqual(['', 'attachments-notes']);
    expect(r.folders).toEqual(['attachments-notes']);
  });
  it('restores reference files that the zip’s references.json names, never as notes; README.txt is skipped quietly', () => {
    const refs = [{ id: 'r_a2020', citekey: 'a2020', type: 'book', title: 'T', authors: [{ f: 'A', g: 'B' }], year: 2020, attachment: { path: 'attachments/a2020.pdf', name: 'a.pdf', kind: 'pdf' } },
      { id: 'r_b2021', citekey: 'b2021', type: 'book', title: 'U', authors: [{ f: 'B', g: 'C' }], year: 2021, attachment: { path: 'attachments/b2021.md', name: 'b.md', kind: 'text' } }];
    const r = importZip(z({ 'a.md': 'x', 'references.json': JSON.stringify(refs), 'attachments/a2020.pdf': '%PDF-1', 'attachments/b2021.md': '# reader text', 'README.txt': 'Arf export', 'attachments/other.pdf': 'p' }), { now: NOW });
    expect(r.notes.map((n) => n.title)).toEqual(['a']);
    expect(r.attachments.map((a) => a.path)).toEqual(['attachments/a2020.pdf', 'attachments/b2021.md']);
    expect(new TextDecoder().decode(r.attachments[0].bytes)).toBe('%PDF-1');
    expect(r.skipped).toEqual([{ path: 'attachments/other.pdf', reason: 'not-markdown' }]);
  });
  it('a loose README.txt is skipped without a report', () => {
    expect(importMarkdownFiles([{ path: 'README.txt', text: 'x' }, { path: 'a.md', text: 'a' }]).skipped).toEqual([]);
  });
});

describe('citekey rename maps', () => {
  it('importReferences maps a key renamed against the library (BibTeX and Arf JSON)', () => {
    const existingRefs = [{ id: 'r_smith2020', citekey: 'smith2020', title: 'Other', authors: [{ f: 'Smith' }], year: 2020 }];
    const bib = importReferences('@book{smith2020, title={Mine}, author={Smith, J}, year={2020}}', 'a.bib', { existingRefs });
    expect(bib.refs[0].citekey).toBe('smith2020b');
    expect(bib.keyMap).toEqual({ smith2020: 'smith2020b' });
    const arf = importReferences(JSON.stringify([{ id: 'r_smith2020_g12', citekey: 'smith2020', title: 'Mine', authors: [{ f: 'Smith', g: 'J' }] }]), 'references.json', { existingRefs });
    expect(arf.keyMap).toEqual({ smith2020: 'smith2020b' });
    expect(arf.refs[0].id).toBe('r_smith2020_g12');   // its own id is kept when free
  });
  it('a second entry with the same key in one file does not remap the first one’s citations', () => {
    const r = importReferences('@book{k1, title={A}, author={X, Y}, year={2001}}\n@book{k1, title={B}, author={X, Y}, year={2002}}', 'a.bib');
    expect(r.refs.map((x) => x.citekey)).toEqual(['k1', 'x2002']);
    expect(r.keyMap).toEqual({});
  });
  it('mergeImportedRefs maps renamed clashes and duplicates to the key they end up with', () => {
    const ex = [{ id: 'r_a2020', citekey: 'a2020', title: 'Same Title', authors: [{ f: 'A', g: '' }], year: 2020, doi: '10.1/X' }];
    const r = mergeImportedRefs(ex, [
      { id: 'r_dup', citekey: 'dup', title: 'Whatever', authors: [], doi: '10.1/x' },
      { id: 'r_a2020', citekey: 'a2020', title: 'Different', authors: [{ f: 'A', g: '' }], year: 2020 },
    ]);
    expect(r.keyMap).toEqual({ dup: 'a2020', a2020: 'a2020b' });
  });
});

describe('JSON reference sniffing', () => {
  it('rejects JSON that is not CSL- or Arf-shaped (package.json, settings)', () => {
    const pkg = readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8');
    for (const t of [pkg, '{"type":"module","author":"Someone","name":"x"}', '[{"a":1}]', '{"title":"Only a title"}']) {
      const r = importReferences(t, 'x.json');
      expect(r.refs).toEqual([]);
      expect(r.errors[0]).toMatch(/Unrecognized reference format/);
    }
  });
  it('accepts CSL items with a title or known type plus authors or an issued date', () => {
    expect(importReferences('[{"title":"T","author":[{"family":"F"}]}]', 'x.json').refs).toHaveLength(1);
    expect(importReferences('{"type":"book","issued":{"date-parts":[[2001]]}}', 'x.json').refs).toHaveLength(1);
  });
  it('a CSL export keeps items without authors or dates (webpages), and reports shapeless ones', () => {
    const r = importReferences(JSON.stringify([{ title: 'Paper', author: [{ family: 'F' }] }, { type: 'webpage', title: 'A page', URL: 'https://x.org' }, { foo: 1 }]), 'x.json');
    expect(r.refs.map((x) => x.title)).toEqual(['Paper', 'A page']);
    expect(r.errors).toEqual(['Skipped 1 item with neither a title nor a CSL type.']);
  });
});

describe('importZip', () => {
  const z = (obj) => zipSync(Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v])));
  it('strips a single top folder, ignores junk, collects images', () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const r = importZip(z({
      'Vault/Notes/a.md': '# A\n\nbody', 'Vault/b.md': 'B text', 'Vault/.obsidian/app.json': '{}', 'Vault/.trash/old.md': 'x',
      '__MACOSX/Vault/._a.md': 'junk', 'Vault/img/pic.png': png, 'Vault/.hidden.md': 'h', 'Vault/doc.pdf': 'pdf',
    }), { now: NOW });
    expect(r.notes.map((n) => [n.folder, n.title]).sort()).toEqual([['', 'b'], ['Notes', 'A']]);
    expect(r.assets).toHaveLength(1);
    expect(r.assets[0].path).toBe('img/pic.png');
    expect([...r.assets[0].bytes]).toEqual([...png]);
    expect(r.skipped).toEqual([{ path: 'doc.pdf', reason: 'not-markdown' }]);
  });
  it('does not strip when entries do not share one top folder', () => {
    expect(importZip(z({ 'A/a.md': 'x', 'B/b.md': 'y' }), { now: NOW }).notes.map((n) => n.folder).sort()).toEqual(['A', 'B']);
    expect(importZip(z({ 'A/a.md': 'x', 'root.md': 'y' }), { now: NOW }).notes.map((n) => n.folder).sort()).toEqual(['', 'A']);
  });
  it('keeps empty directory entries as folders; Turkish names survive', () => {
    const r = importZip(z({ 'Boş Klasör/': new Uint8Array(0), 'Çalışma/İlk Not.md': 'Merhaba' }), { now: NOW });
    expect(r.folders).toEqual(['Boş Klasör', 'Çalışma']);
    expect(r.notes[0].title).toBe('İlk Not');
  });
  it('picks up root references.json / references.bib', () => {
    const refs = [{ id: 'r_x2020', citekey: 'x2020', type: 'book', title: 'T', authors: [{ f: 'X', g: 'Y' }], year: 2020 }];
    expect(importZip(z({ 'a.md': 'x', 'references.json': JSON.stringify(refs) })).refs.map((r) => r.citekey)).toEqual(['x2020']);
    expect(importZip(z({ 'a.md': 'x', 'references.bib': '@book{k1, title={T}, author={A, B}, year={2001}}' })).refs[0].citekey).toBe('k1');
  });
  it('skips oversize entries without unpacking them', () => {
    const r = importZip(z({ 'big.md': 'a'.repeat(200), 'ok.md': 'b' }), { now: NOW, maxBytes: 100 });
    expect(r.notes.map((n) => n.title)).toEqual(['ok']);
    expect(r.skipped).toEqual([{ path: 'big.md', reason: 'too-large' }]);
  });
  it('throws on a non-zip', () => {
    expect(() => importZip(new Uint8Array([1, 2, 3, 4, 5]))).toThrow();
  });
});

describe('parseBibTeX', () => {
  const refs = parseBibTeX(readFileSync(join(FX, 'refs.bib'), 'utf8'));
  const by = (k) => refs.find((r) => r.citekey === k);
  it('parses entries, ignoring comments, @comment, @preamble and % lines', () => {
    expect(refs.map((r) => r.citekey)).toEqual(['Sahin2021', 'knuth84', 'noyear', 'conf1']);
  });
  it('decodes LaTeX accents, Turkish letters, braces, math, @string macros', () => {
    const r = by('Sahin2021');
    expect(r.authors).toEqual([{ f: 'Şahin', g: 'Ayşe' }, { f: 'Kılıç', g: 'Mehmet' }, { f: 'Müller', g: 'Hans' }, { f: 'Gökğul-Ok', g: 'Z.' }]);
    expect(r.title).toBe('A DNA study of Brain örgüt: nested braces and $\\alpha$-decay');
    expect(r.container).toBe('Journal of Great Biology');
    expect(r.year).toBe(2021);
    expect(r.volume).toBe('12');
    expect(r.pages).toBe('34–56');
    expect(r.doi).toBe('10.1000/ABC_1');
    expect(r.type).toBe('article-journal');
  });
  it('quoted values, concatenated macro, First Last authors, ISBN, book type', () => {
    const r = by('knuth84');
    expect(r.type).toBe('book');
    expect(r.title).toBe('The TeXbook');
    expect(r.publisher).toBe('Big Press');
    expect(r.authors).toEqual([{ f: 'Knuth', g: 'Donald E.' }]);
    expect(r.isbn).toBe('9780201134476');
    expect(r.container).toBe('');
  });
  it('missing year, "others", von particles, \\url, misc -> webpage', () => {
    const r = by('noyear');
    expect(r.year).toBe('');
    expect(r.authors).toEqual([{ f: 'Doe', g: 'Jane' }, { f: 'van der Berg', g: 'Ludwig' }]);
    expect(r.type).toBe('webpage');
    expect(r.url).toBe('https://example.org/a_b');
    expect(r.container).toBe('');
    expect(r.id).toBe('r_noyear');
  });
  it('inproceedings maps to article-journal with booktitle as container', () => {
    const r = by('conf1');
    expect(r.title).toBe('Conf étude');
    expect(r.container).toBe('Proc. of Things');
    expect(r.pages).toBe('1–9');
  });
  it('keeps valid keys, regenerates invalid or taken ones with the app rule', () => {
    const text = '@article{Ünlü2020, author={Ünlü, Ali}, title={A}, year={2020}}\n@article{ok:1, author={Kılıç, B}, title={B}, year={2021}}\n@article{ok:1, author={Kılıç, B}, title={C}, year={2021}}';
    const r = parseBibTeX(text, { existingRefs: [{ id: 'r_unlu2020', citekey: 'unlu2020' }] });
    expect(r.map((x) => x.citekey)).toEqual(['unlu2020b', 'ok:1', 'kilic2021']);
    expect(new Set(r.map((x) => x.id)).size).toBe(3);
  });
  it('generated keys fold Turkish letters like the Library', () => {
    expect(mkCitekey([{ f: 'Şahin-Öz' }], 2020)).toBe('sahinoz2020');
    expect(mkCitekey([{ f: 'Kılıç' }], 2020)).toBe('kilic2020');
    expect(mkCitekey([], '')).toBe('ref');
  });
  it('arXiv eprint becomes a preprint with DOI and URL', () => {
    const r = parseBibTeX('@misc{v, author={Vaswani, A}, title={Attention}, year={2017}, eprint={1706.03762}, archivePrefix={arXiv}}')[0];
    expect(r.type).toBe('preprint');
    expect(r.doi).toBe('10.48550/arXiv.1706.03762');
    expect(r.container).toBe('arXiv');
  });
  it('tolerates an unterminated entry and reports it', () => {
    const errors = [];
    const r = parseBibTeX('@article{a, title={One}, year={2000}}\n@article{b, title={Two', { errors });
    expect(r.map((x) => x.title)).toEqual(['One', 'Two']);
    expect(errors.length).toBe(1);
  });
  it('handles empty or garbage input', () => {
    expect(parseBibTeX('')).toEqual([]);
    expect(parseBibTeX('hello @ world')).toEqual([]);
  });
});

describe('parseRIS', () => {
  const refs = parseRIS(readFileSync(join(FX, 'refs.ris'), 'utf8').replace(/\r?\n/g, '\r\n'));
  it('parses multiple CRLF records', () => {
    expect(refs).toHaveLength(3);
    expect(refs[0]).toMatchObject({ citekey: 'smith2020', type: 'article-journal', title: 'A Study of Things', container: 'Journal of Things', year: 2020, volume: '12', pages: '34–56', doi: '10.1/x', isbn: '' });
    expect(refs[0].authors).toEqual([{ f: 'Smith', g: 'Jane' }, { f: 'Doe', g: 'John' }]);
    expect(refs[0].abstract).toBe('First line continued here.');
  });
  it('book + webpage records with generated keys', () => {
    expect(refs[1]).toMatchObject({ type: 'book', title: 'The Book', publisher: 'Uni Press', isbn: '9780262035613', citekey: 'jones2019' });
    expect(refs[2]).toMatchObject({ type: 'webpage', title: 'A Page', url: 'https://example.org', year: '', citekey: 'ref' });
  });
  it('handles a record without ER, and garbage', () => {
    expect(parseRIS('TY  - JOUR\nTI  - Only\n')[0].title).toBe('Only');
    expect(parseRIS('garbage')).toEqual([]);
  });
});

describe('parseCSLJSON', () => {
  const refs = parseCSLJSON(readFileSync(join(FX, 'refs.csl.json'), 'utf8'));
  it('maps family/given, literal, issued, container, DOI, URL, page', () => {
    expect(refs[0]).toMatchObject({ citekey: 'doe2018', type: 'article-journal', year: 2018, container: 'Cell', doi: '10.1016/j.cell.2018.01.001', pages: '1–10', volume: '7', url: 'https://x.org' });
    expect(refs[0].authors).toEqual([{ f: 'Doe', g: 'John' }, { f: 'WHO Consortium', g: '' }]);
  });
  it('raw dates, missing id, chapter -> book, single object, items wrapper', () => {
    expect(refs[1]).toMatchObject({ type: 'book', year: 2020, citekey: 'sahin2020' });
    expect(parseCSLJSON('{"title":"S","author":[{"family":"A","given":"B"}],"issued":{"date-parts":[["2001"]]}}')[0].year).toBe(2001);
    expect(parseCSLJSON('{"items":[{"title":"I"}]}')).toHaveLength(1);
  });
});

describe('importReferences', () => {
  it('sniffs by content, not extension', () => {
    const bib = readFileSync(join(FX, 'refs.bib'), 'utf8'), ris = readFileSync(join(FX, 'refs.ris'), 'utf8'), json = readFileSync(join(FX, 'refs.csl.json'), 'utf8');
    expect(importReferences(bib, 'x.txt').format).toBe('bibtex');
    expect(importReferences(ris, 'x.bib').format).toBe('ris');
    expect(importReferences(json, 'x.ris').format).toBe('csl-json');
    expect(importReferences(bib, 'x.txt').refs.length).toBe(4);
  });
  it('reports empty, unknown and malformed input', () => {
    expect(importReferences('   ', 'a.bib').errors[0]).toMatch(/empty/);
    expect(importReferences('plain words', 'a.txt').format).toBe('unknown');
    const bad = importReferences('{ not json', 'a.json');
    expect(bad.refs).toEqual([]);
    expect(bad.errors[0]).toMatch(/Could not parse/);
  });
  it('accepts an Arf references.json unchanged, de-duplicating keys against existing', () => {
    const refs = [{ id: 'r_a2020', citekey: 'a2020', type: 'book', title: 'T', authors: [{ f: 'A', g: 'B' }], year: 2020 }];
    const r = importReferences(JSON.stringify(refs), 'references.json', { existingRefs: [{ id: 'r_a2020', citekey: 'a2020' }] });
    expect(r.format).toBe('arf-json');
    expect(r.refs[0].citekey).toBe('a2020b');
  });
});

describe('round trip through cite.js formatters', () => {
  const originals = [
    { id: 'r_smith2020', citekey: 'smith2020', type: 'article-journal', title: 'A Study of Things: 100% & more_x', authors: [{ f: 'Smith', g: 'Jane' }, { f: 'Doe', g: 'John' }], year: 2020, container: 'Journal of Things', volume: '12', pages: '34–56', doi: '10.1/x_y', url: 'https://ex.org/a?b=1&c=2' },
    { id: 'r_jones2019', citekey: 'jones2019', type: 'book', title: 'The Book', authors: [{ f: 'Jones', g: 'Amy' }], year: 2019, publisher: 'Uni Press', isbn: '9780262035613' },
    { id: 'r_vaswani2017', citekey: 'vaswani2017', type: 'preprint', title: 'Attention Is All You Need', authors: [{ f: 'Vaswani', g: 'Ashish' }], year: 2017, container: 'arXiv', doi: '10.48550/arXiv.1706.03762', url: 'https://arxiv.org/abs/1706.03762' },
    { id: 'r_sahin2021', citekey: 'sahin2021', type: 'article-journal', title: 'Işık, çok güzel: ğüşöç $\\alpha$ x', authors: [{ f: 'Şahin', g: 'Ayşe' }, { f: 'Kılıç', g: 'Mehmet' }], year: 2021, container: 'Türk Dergisi', volume: '3', pages: '1–2', doi: '10.9/t' },
    { id: 'r_page2020', citekey: 'page2020', type: 'webpage', title: 'A Page', authors: [{ f: 'Page', g: 'Sam' }], year: 2020, container: 'Example Site', url: 'https://example.org' },
  ];
  const core = (r) => ({ citekey: r.citekey, type: r.type, title: r.title, authors: r.authors, year: r.year, container: r.container || '', publisher: r.publisher || '', volume: r.volume || '', pages: r.pages || '', doi: r.doi || '', isbn: r.isbn || '', url: r.url || '' });
  it('BibTeX', () => {
    // toBibTeX writes @online for webpages and has no container field for them other than "journal"
    expect(parseBibTeX(joinRefs(originals, 'BibTeX')).map(core)).toEqual(originals.map(core));
  });
  it('RIS', () => {
    expect(parseRIS(joinRefs(originals, 'RIS (EndNote)')).map(core)).toEqual(originals.map(core));
  });
  it('CSL-JSON', () => {
    expect(parseCSLJSON(joinRefs(originals, 'CSL-JSON')).map(core)).toEqual(originals.map(core));
  });
  it('importReferences sniffs each generated format', () => {
    expect(importReferences(joinRefs(originals, 'BibTeX')).format).toBe('bibtex');
    expect(importReferences(joinRefs(originals, 'RIS (EndNote)')).format).toBe('ris');
    expect(importReferences(joinRefs(originals, 'CSL-JSON')).format).toBe('csl-json');
    expect(formatRef(originals[0], 'APA')).toContain('Smith');
  });
});

describe('mergeImportedRefs', () => {
  const ex = [{ id: 'r_a2020', citekey: 'a2020', title: 'Same Title', authors: [{ f: 'A', g: '' }], year: 2020, doi: '10.1/X' }];
  it('drops DOI and title duplicates (case-insensitive), renames key clashes', () => {
    const inc = [
      { id: 'r_z', citekey: 'z', title: 'Other', authors: [], year: 2000, doi: 'https://doi.org/10.1/x' },
      { id: 'r_a2', citekey: 'a2020', title: 'same  title!', authors: [{ f: 'A', g: '' }], year: 2020 },
      { id: 'r_a2020', citekey: 'a2020', title: 'Different', authors: [{ f: 'A', g: '' }], year: 2020 },
    ];
    const r = mergeImportedRefs(ex, inc);
    expect(r.duplicates).toHaveLength(2);
    expect(r.added.map((x) => x.citekey)).toEqual(['a2020b']);
    expect(r.added[0].id).toBe('r_a2020b');
    expect(r.refs).toHaveLength(2);
  });
});
