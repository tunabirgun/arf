import { describe, it, expect } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { exportVaultZip, planNotePaths, notePath } from '../../src/lib/exporters.js';
import { importZip, importReferences } from '../../src/lib/importers.js';
import { serialize, parse, slug } from '../../src/lib/vaultadapter.js';
import { mergeByUpdated } from '../../src/lib/sync.js';
import { planImport } from '../../src/lib/importflow.js';
import { ulid } from '../../src/lib/vault.js';

const NOW = '2025-02-03T04:05:06.000Z';
const mk = (title, folder, tags, body, extra = {}) => ({ id: ulid(), title, folder, tags, created: '2024-01-01T00:00:00.000Z', updated: '2024-01-02T00:00:00.000Z', body, ...extra });
const unzip = (b) => Object.fromEntries(Object.entries(unzipSync(b)).map(([k, v]) => [k, strFromU8(v)]));
const refs = [
  { id: 'r_smith2020', citekey: 'smith2020', type: 'article-journal', title: 'Things', authors: [{ f: 'Smith', g: 'Jane' }], year: 2020, container: 'J', doi: '10.1/x' },
];

describe('exportVaultZip', () => {
  const notes = [
    mk('Alpha', '', ['a', 'b'], 'Body A'),
    mk('Beta Plan', 'Projects/Alpha', ['x'], '# Heading\n\ntext [[Alpha]]\n\n![](img.png)'),
    mk('Şeker İşleme', 'Ünite', ['kimya'], 'Türkçe içerik: ğüşıöç'),
    mk('Untitled', 'weird\\..\\path/con.', [], 'x'),
  ];
  const zip = exportVaultZip(notes, ['Empty/Nested', 'Projects'], refs, { now: NOW });
  const files = unzip(zip);
  it('writes notes at their folder paths with vaultadapter.serialize', () => {
    expect(files['alpha.md']).toBe(serialize(notes[0]));
    expect(files['Projects/Alpha/beta-plan.md']).toBe(serialize(notes[1]));
    expect(files['Ünite/' + slug(notes[2].title) + '.md']).toBe(serialize(notes[2]));
  });
  it('sanitises folder segments like the vault', () => {
    expect(Object.keys(files)).toContain('weird/path/con-/untitled.md');
  });
  it('adds directory entries for empty folders only', () => {
    const keys = Object.keys(files);
    expect(keys).toContain('Empty/Nested/');
    expect(keys).not.toContain('Projects/');
    expect(keys).not.toContain('Projects/Alpha/');
  });
  it('adds references.bib, references.json and a plain README', () => {
    expect(files['references.bib']).toContain('@article{smith2020');
    expect(JSON.parse(files['references.json'])).toEqual(refs);
    expect(files['README.txt']).toContain('Exported by Arf on 2025-02-03');
    expect(files['README.txt']).toContain('4 notes');
    expect(files['README.txt']).not.toMatch(/[A-Z]:\\|@/);
  });
  it('includeBib:false or no refs omits both bib files', () => {
    expect(Object.keys(unzip(exportVaultZip(notes, [], refs, { now: NOW, includeBib: false }))).some((k) => k.startsWith('references'))).toBe(false);
    expect(Object.keys(unzip(exportVaultZip(notes, [], [], { now: NOW }))).some((k) => k.startsWith('references'))).toBe(false);
  });
  it('is deterministic for the same input', () => {
    expect(exportVaultZip(notes, ['Empty/Nested'], refs, { now: NOW })).toEqual(exportVaultZip(notes, ['Empty/Nested'], refs, { now: NOW }));
  });
  it('handles an empty vault', () => {
    expect(Object.keys(unzip(exportVaultZip([], [], [], { now: NOW })))).toEqual(['README.txt']);
  });
});

describe('collision suffixes match the vault rule', () => {
  const a = mk('Same Title', 'F', [], 'one', { id: '01HZZZZZZZZZZZZZZZZZZZAAAA', created: '2024-01-01T00:00:00.000Z' });
  const b = mk('Same Title', 'F', [], 'two', { id: '01HZZZZZZZZZZZZZZZZZZZBBBB', created: '2024-02-01T00:00:00.000Z' });
  const c = mk('same title', 'f2', [], 'three');
  it('oldest keeps the plain name, the other gets the last 5 id chars (lower-case)', () => {
    const p = planNotePaths([b, a, c]);
    expect(p.get(a.id)).toBe('F/same-title.md');
    expect(p.get(b.id)).toBe('F/same-title-zbbbb.md');
    expect(p.get(c.id)).toBe('f2/same-title.md');
  });
  it('notePath mirrors vaultadapter naming (slug, folder cleaning, reserved names, suffix)', () => {
    // the vault's own relPath is private; its observable behaviour is slug() + the folder path serialize/parse round trip
    const n = mk('Çok Güzel: Başlık?', 'a\\b/./c', [], 'x');
    expect(notePath(n)).toBe('a/b/c/çok-güzel-başlık.md');
    expect(notePath(n, 'abcde')).toBe('a/b/c/çok-güzel-başlık-abcde.md');
    expect(notePath(mk('', '', [], ''))).toBe('untitled.md');
    expect(notePath(mk('NUL', '', [], ''))).toBe('nul-note.md');
    const back = parse(serialize(n), { folder: 'a/b/c' });
    expect(back.title).toBe(n.title);
    expect(back.id).toBe(n.id);
  });
  it('case-only differences in folders collide as on Windows/macOS', () => {
    const x = mk('T', 'Docs', [], '1', { created: '2024-01-01T00:00:00.000Z' });
    const y = mk('T', 'docs', [], '2', { created: '2024-01-02T00:00:00.000Z' });
    const p = planNotePaths([x, y]);
    expect(p.get(x.id)).toBe('Docs/t.md');
    expect(p.get(y.id).toLowerCase()).not.toBe('docs/t.md');
  });
  it('a three-way clash still yields unique paths', () => {
    const ns = [1, 2, 3].map((i) => mk('Dup', '', [], String(i), { id: '01HZZZZZZZZZZZZZZZZZZZABC' + i, created: '2024-01-0' + i + 'T00:00:00.000Z' }));
    expect(new Set(planNotePaths(ns).values()).size).toBe(3);
  });
});

describe('zip round trip: export -> import', () => {
  const notes = [
    mk('Alpha', '', ['a', 'b'], 'Body A\n\nsecond paragraph'),
    mk('Beta Plan', 'Projects/Alpha', ['x'], '# Heading\n\ntext [[Alpha]]\n\n- [ ] task\n\n```js\nconst a = 1;\n```'),
    mk('Şeker İşleme', 'Ünite/Alt Klasör', ['kimya', 'biyoloji'], 'Türkçe içerik: ğüşıöçİ'),
    mk('Dup', 'A', [], 'one'), mk('Dup', 'B', [], 'two'), mk('Dup', 'A', [], 'three'),
    mk('With H1 body', '', [], '# With H1 body\n\nrest'),
  ];
  const zip = exportVaultZip(notes, ['Boş'], refs, { now: NOW });
  const r = importZip(zip, { now: NOW });
  it('reproduces title, folder, tags, body and ids', () => {
    expect(r.notes).toHaveLength(notes.length);
    for (const n of notes) {
      const got = r.notes.find((x) => x.id === n.id);
      expect(got, n.title).toBeTruthy();
      expect(got).toEqual({ id: n.id, title: n.title, folder: n.folder, tags: n.tags, created: n.created, updated: n.updated, body: n.body });
    }
  });
  it('keeps empty folders and the references', () => {
    expect(r.folders).toContain('Boş');
    expect(r.refs.map((x) => x.citekey)).toEqual(['smith2020']);
    expect(r.skipped).toEqual([]);   // README.txt is Arf's own, skipped quietly
  });
  it('re-importing into the same vault merges instead of duplicating', () => {
    const again = importZip(zip, { now: NOW, existing: notes });
    expect(again.notes.map((n) => n.id).sort()).toEqual(notes.map((n) => n.id).sort());
    expect(mergeByUpdated(notes, again.notes)).toHaveLength(notes.length);
  });
  it('notes with non-ULID ids (conflict copies, path ids, hash ids) restore without duplicates', () => {
    const odd = [mk('Conflict', '', [], 'c', { id: 'conflict_lx3k9a' }), mk('Old', 'Projects', [], 'o', { id: 'Projects/old.md' }),
      mk('Hash', '', [], 'h', { id: 'n12345' }), mk('Plain', '', [], 'p'), mk('Moved since', 'Elsewhere', [], 'm')];
    const back = importZip(exportVaultZip(odd, [], [], { now: NOW }), { now: NOW, existing: odd.map((n, i) => (i === 4 ? { ...n, folder: 'Now here', title: 'Renamed' } : n)) });
    const plan = planImport(odd, back.notes);
    expect(plan.added).toEqual([]);
    expect(plan.notes).toHaveLength(odd.length);
  });
  it('carries attachments/ files and says so in the README; a re-import restores images by content hash', () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const withImg = [mk('Pic', '', [], '![](attachments/images/0a1b.png)')];
    const z = exportVaultZip(withImg, [], [], { now: NOW, attachments: [{ path: 'attachments/images/0a1b.png', bytes: png }, { path: '../escape.png', bytes: png }] });
    const raw = unzipSync(z);
    expect(Object.keys(raw).sort()).toEqual(['README.txt', 'attachments/images/0a1b.png', 'pic.md']);
    expect([...raw['attachments/images/0a1b.png']]).toEqual([...png]);
    expect(strFromU8(raw['README.txt'])).toContain('attachments/ holds 1 file');
    const back = importZip(z, { now: NOW });
    expect(back.assets.map((a) => a.path)).toEqual(['attachments/images/0a1b.png']);
    expect(back.notes[0].folder).toBe('');
    expect(back.skipped).toEqual([]);
  });
  it('the README date can be given as the local day', () => {
    expect(strFromU8(unzipSync(exportVaultZip([], [], [], { now: NOW, date: '2025-02-04' }))['README.txt'])).toContain('on 2025-02-04.');
    expect(strFromU8(unzipSync(exportVaultZip([], [], [], { now: NOW }))['README.txt'])).toContain('No attachments were included');
  });
  it('the exported references.bib re-imports through importReferences', () => {
    const bib = importReferences(strFromU8(unzipSync(zip)['references.bib']), 'references.bib');
    expect(bib.format).toBe('bibtex');
    expect(bib.refs[0]).toMatchObject({ citekey: 'smith2020', title: 'Things', year: 2020, doi: '10.1/x' });
  });
});
