// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { importKind, stripTopFolder, rewriteImageLinks, encodeLinkPath, planImport, importSummary, hashedImagePath, composeKeyMaps, rewriteCitekeys, attachmentPaths, localDate } from '../../src/lib/importflow.js';
import { importMarkdownFiles } from '../../src/lib/importers.js';
import { renderMarkdown } from '../../src/lib/markdown.js';

const FIX = join(__dirname, 'fixtures', 'import');
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });

describe('importKind', () => {
  it('routes by extension, case-insensitive', () => {
    expect(['a.md', 'b.MARKDOWN', 'v.zip', 'r.bib', 'r.ris', 'r.csl.json', 'w.arf', 'i.PNG', 'x.txt', ''].map(importKind))
      .toEqual(['notes', 'notes', 'zip', 'refs', 'refs', 'refs', 'arf', 'image', null, null]);
  });
});

describe('stripTopFolder', () => {
  it('drops the picked folder name shared by every path', () => {
    expect(stripTopFolder(['vault/a.md', 'vault/Daily/b.md'])).toEqual(['a.md', 'Daily/b.md']);
    expect(stripTopFolder(['vault\\a.md', 'vault\\x\\b.md'])).toEqual(['a.md', 'x/b.md']);
  });
  it('leaves paths alone when they do not share one top folder', () => {
    expect(stripTopFolder(['a.md', 'v/b.md'])).toEqual(['a.md', 'v/b.md']);
    expect(stripTopFolder(['v/a.md', 'w/b.md'])).toEqual(['v/a.md', 'w/b.md']);
    expect(stripTopFolder([])).toEqual([]);
  });
  it('turns the fixture folder into the paths importMarkdownFiles expects', () => {
    const files = walk(join(FIX, 'vault'));
    const rel = stripTopFolder(files.map((f) => relative(FIX, f)));
    const r = importMarkdownFiles(rel.map((p, i) => ({ path: p, text: /\.md$/.test(p) ? readFileSync(files[i], 'utf8') : null })));
    expect(r.notes.find((n) => n.title === 'Alpha Plan').folder).toBe('Projects/Alpha');
    expect(r.notes.every((n) => !n.folder.startsWith('vault'))).toBe(true);
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['hidden', 'not-markdown']);
  });
});

describe('rewriteImageLinks', () => {
  const note = (body, folder = '') => ({ id: 'N', title: 't', folder, tags: [], body });
  const assets = ['Projects/Alpha/diagram.png', 'img/a b.png', 'Ünite/şekil (1).png', 'dup/x.png', 'other/x.png'];
  const one = (body, folder) => rewriteImageLinks([note(body, folder)], assets).notes[0].body;
  it('resolves relative to the note folder, then the root, then a unique file name', () => {
    expect(one('![](diagram.png)', 'Projects/Alpha')).toBe('![](attachments/images/Projects/Alpha/diagram.png)');
    expect(one('![cap](img/a%20b.png)')).toBe('![cap](attachments/images/img/a%20b.png)');
    expect(one('![](../../img/a%20b.png)', 'Projects/Alpha')).toBe('![](attachments/images/img/a%20b.png)');
    expect(one('![](diagram.png)')).toBe('![](attachments/images/Projects/Alpha/diagram.png)');
  });
  it('escapes spaces and parentheses so the link still parses', () => {
    expect(one('![](<Ünite/şekil (1).png>)')).toBe('![](attachments/images/Ünite/şekil%20%281%29.png)');
  });
  it('leaves ambiguous names, external, unknown, stored and code links alone', () => {
    for (const b of ['![](x.png)', '![](https://e.org/diagram.png)', '![](data:image/png;base64,AA)', '![](missing.png)', '![](attachments/images/diagram.png)', '`![](diagram.png)`', '```\n![](diagram.png)\n```'])
      expect(one(b)).toBe(b);
  });
  it('counts rewrites and returns the same object when nothing changed', () => {
    const n = note('no images');
    const r = rewriteImageLinks([n, note('![](diagram.png) and ![t](img/a%20b.png "title")')], assets);
    expect(r.notes[0]).toBe(n);
    expect(r.rewritten).toBe(2);
    expect(r.notes[1].body).toContain('(attachments/images/img/a%20b.png "title")');
  });
  it('a rewritten link renders with the stored path as its src (decoded)', () => {
    const body = one('![](<Ünite/şekil (1).png>)');
    const src = /src="([^"]+)"/.exec(renderMarkdown(body))[1];
    expect(decodeURI(src)).toBe('attachments/images/Ünite/şekil (1).png');
    expect(encodeLinkPath('a b(c)%.png')).toBe('a%20b%28c%29%25.png');
  });
});

describe('rewriteImageLinks: content-hashed targets', () => {
  const note = (body, folder = '') => ({ id: 'N', title: 't', folder, tags: [], body });
  it('a Map target rewrites only mapped assets and reports which assets notes link', () => {
    const assets = ['img/a.png', 'img/b.png', 'img/unused.png'];
    const first = rewriteImageLinks([note('![](img/a.png) ![](b.png)')], assets, new Map());
    expect([...first.used].sort()).toEqual([]);   // nothing mapped yet: nothing rewritten, nothing used
    const probe = rewriteImageLinks([note('![](img/a.png) ![](b.png)')], assets);
    expect([...probe.used].sort()).toEqual(['img/a.png', 'img/b.png']);
    const map = new Map([['img/a.png', hashedImagePath('aaaa', 'img/a.png')], ['img/b.png', hashedImagePath('bbbb', 'img/b.PNG')]]);
    expect(rewriteImageLinks([note('![](img/a.png) ![](b.png)')], assets, map).notes[0].body).toBe('![](attachments/images/aaaa.png) ![](attachments/images/bbbb.png)');
  });
  it('an Arf export’s attachments/images links resolve against the zip’s own copies', () => {
    const map = new Map([['attachments/images/x1.png', 'attachments/images/h9.png']]);
    expect(rewriteImageLinks([note('![](attachments/images/x1.png)', 'Projects')], ['attachments/images/x1.png'], map).notes[0].body).toBe('![](attachments/images/h9.png)');
  });
  it('hashedImagePath keeps the source extension, lower-cased', () => {
    expect(hashedImagePath('ab12', 'Fig 1.JPEG')).toBe('attachments/images/ab12.jpeg');
  });
});

describe('citekey rewrite', () => {
  it('composes two rename stages, dropping round trips', () => {
    expect(composeKeyMaps({ smith2020: 'smith2020b' }, { smith2020b: 'smith2020' })).toEqual({});
    expect(composeKeyMaps({ a: 'a2' }, { a2: 'a3', z: 'q' })).toEqual({ a: 'a3', z: 'q' });
  });
  it('rewrites [@key], [@!key], [@+key] outside code, never a longer key', () => {
    const n = { id: 'n', body: 'See [@smith2020] and [@!smith2020], [@+smith2020] but not [@smith2020a] or `[@smith2020]`\n```\n[@smith2020]\n```' };
    const out = rewriteCitekeys([n], { smith2020: 'smith2020b' })[0].body;
    expect(out).toBe('See [@smith2020b] and [@!smith2020b], [@+smith2020b] but not [@smith2020a] or `[@smith2020]`\n```\n[@smith2020]\n```');
    expect(rewriteCitekeys([n], {})[0]).toBe(n);
  });
});

describe('planImport: re-imports without ids and undated files', () => {
  const ex = [{ id: 'A', title: 'Alpha', folder: 'Projects', updated: '2024-05-01', body: 'text\n', _path: 'Projects/alpha.md' }];
  it('a no-id file whose title and body match an existing note is unchanged, not a duplicate', () => {
    const r = planImport(ex, [{ id: 'NEW', title: 'Alpha', folder: '', updated: '2025-01-01', body: 'text', _noId: true }]);
    expect(r).toMatchObject({ added: [], merged: [], unchanged: ['A'] });
    expect(r.notes).toHaveLength(1);
  });
  it('a no-id file with different text is added, without the marker', () => {
    const r = planImport(ex, [{ id: 'NEW', title: 'Alpha', folder: '', updated: '2025-01-01', body: 'other', _noId: true }]);
    expect(r.added).toEqual(['NEW']);
    expect('_noId' in r.notes.find((n) => n.id === 'NEW')).toBe(false);
  });
  it('an undated id match keeps the vault’s copy', () => {
    const r = planImport(ex, [{ id: 'A', title: 'Alpha', folder: '', updated: '2025-01-01', body: 'import time beats nothing', _undated: true }]);
    expect(r).toMatchObject({ added: [], merged: [], unchanged: ['A'] });
    expect(r.notes[0].body).toBe('text\n');
  });
});

describe('attachmentPaths and localDate', () => {
  it('collects linked vault images and reference attachments, nothing outside attachments/', () => {
    const notes = [{ body: '![](attachments/images/a%20b.png) ![](https://x/y.png) ![](../x.png) `![](attachments/images/code.png)`' }, { body: '![](<attachments/images/c.png>)' }];
    const refs = [{ attachment: { path: 'attachments/r.pdf' } }, { attachment: { path: '../evil.pdf' } }, {}];
    expect(attachmentPaths(notes, refs)).toEqual(['attachments/images/a b.png', 'attachments/images/c.png', 'attachments/r.pdf']);
  });
  it('localDate uses the local calendar day', () => {
    expect(localDate(new Date(2026, 10, 26, 1, 25))).toBe('2026-11-26');
  });
});

describe('planImport', () => {
  const ex = [
    { id: 'A', title: 'a', updated: '2024-01-01', body: 'old', _path: 'a.md' },
    { id: 'B', title: 'b', updated: '2024-05-01', body: 'local', _path: 'b.md' },
  ];
  const inc = [
    { id: 'A', title: 'a', updated: '2024-02-01', body: 'newer' },
    { id: 'B', title: 'b', updated: '2024-01-01', body: 'older' },
    { id: 'C', title: 'c', updated: '2024-01-01', body: 'new' },
  ];
  const r = planImport(ex, inc);
  it('classifies new, merged and unchanged notes', () => {
    expect(r.added).toEqual(['C']); expect(r.merged).toEqual(['A']); expect(r.unchanged).toEqual(['B']);
    expect(r.notes.map((n) => n.body)).toEqual(['newer', 'local', 'new']);
  });
  it('keeps this vault’s file path on a merged note and none on a new one', () => {
    expect(r.notes.find((n) => n.id === 'A')._path).toBe('a.md');
    expect(r.notes.find((n) => n.id === 'C')._path).toBeUndefined();
    expect(inc[0]._path).toBeUndefined();   // inputs are not mutated
  });
});

describe('importSummary', () => {
  it('reports notes, merges, skips with reasons, references and duplicates', () => {
    expect(importSummary({ added: 4, merged: 1, unchanged: 2, skipped: [{ reason: 'hidden' }, { reason: 'not-markdown' }, { reason: 'not-markdown' }], refsAdded: 3, refsDuplicates: 1 }))
      .toBe('✓ Imported 5 notes (4 new, 1 merged). 2 notes already up to date. Skipped 3: 1 hidden, 2 not Markdown. 3 references added, 1 duplicate skipped.');
  });
  it('singular forms, images, and a warning when nothing came in', () => {
    expect(importSummary({ added: 1, images: 1 })).toBe('✓ Imported 1 note (1 new, 0 merged). 1 image copied to the vault.');
    expect(importSummary({ refsAdded: 0, refsDuplicates: 2 })).toBe('✓ 0 references added, 2 duplicates skipped.');
    expect(importSummary({ errors: ['Unrecognized reference format.'] })).toBe('⚠ Unrecognized reference format.');
    expect(importSummary({})).toBe('⚠ Nothing to import.');
    expect(importSummary({ skipped: [{ reason: 'not-markdown' }] })).toBe('⚠ Skipped 1: 1 not Markdown.');
    expect(importSummary({ unchanged: 1, imagesTooLarge: 2, files: 1 })).toBe('✓ 1 note already up to date. 2 images over 25 MB not copied. 1 reference file restored.');
  });
});
