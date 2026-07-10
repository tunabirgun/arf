import { describe, it, expect } from 'vitest';
import { buildBundle, readBundle, normalizeNotes, mergeFolders, mergeRefs, mergeHls } from '../../src/lib/workspace.js';

describe('buildBundle', () => {
  it('produces the versioned bundle envelope', () => {
    const b = buildBundle([{ id: 'a' }], ['f'], [{ id: 'r' }], '1.5.0', '2026-01-01T00:00:00.000Z', ['LibFolder'], { 'ref:x': ['a note'] });
    expect(b).toEqual({
      arf: 1, app: 'Arf', version: '1.5.0', exported: '2026-01-01T00:00:00.000Z',
      notes: [{ id: 'a' }], folders: ['f'], refs: [{ id: 'r' }], libFolders: ['LibFolder'], readerHls: { 'ref:x': ['a note'] },
    });
  });
});

describe('mergeHls', () => {
  it('unions snippets per key without dropping either side', () => {
    const a = { 'ref:1': ['one', 'two'], 'ref:2': ['x'] };
    const b = { 'ref:1': ['two', 'three'], 'ref:3': ['y'] };
    expect(mergeHls(a, b)).toEqual({ 'ref:1': ['one', 'two', 'three'], 'ref:2': ['x'], 'ref:3': ['y'] });
  });
  it('ignores non-arrays and drops empty keys', () => {
    expect(mergeHls({ a: 'nope', b: [] }, { c: ['keep'] })).toEqual({ c: ['keep'] });
  });
  it('tolerates null inputs', () => {
    expect(mergeHls(null, { k: ['v'] })).toEqual({ k: ['v'] });
    expect(mergeHls({}, null)).toEqual({});
  });
});

describe('readBundle', () => {
  it('parses a valid bundle', () => {
    expect(readBundle(JSON.stringify({ notes: [] })).notes).toEqual([]);
  });
  it('rejects JSON that is not a bundle', () => {
    expect(() => readBundle('{}')).toThrow(/Not an Arf workspace/);
    expect(() => readBundle(JSON.stringify({ notes: 'nope' }))).toThrow(/Not an Arf workspace/);
  });
  it('throws on malformed JSON', () => {
    expect(() => readBundle('not json{')).toThrow();
  });
});

describe('normalizeNotes', () => {
  it('drops the source _path and adopts this vault\'s local path for a same-id note', () => {
    const localPath = new Map([['a', 'local/a.md']]);
    const [n] = normalizeNotes([{ id: 'a', _path: 'source/elsewhere.md', title: 'T' }], localPath, () => 'GEN');
    expect(n._path).toBe('local/a.md');
  });
  it('backfills a missing id so id-less notes do not collapse into one', () => {
    const out = normalizeNotes([{ title: 'one' }, { title: 'two' }], new Map(), (() => { let i = 0; return () => 'GEN' + (++i); })());
    expect(out.map((n) => n.id)).toEqual(['GEN1', 'GEN2']);
  });
  it('coerces bad field types to safe defaults', () => {
    const [n] = normalizeNotes([{ id: 'a', title: 42, tags: 'x', body: null, folder: 5 }], new Map(), () => 'GEN');
    expect(n.title).toBe('Untitled');
    expect(n.tags).toEqual([]);
    expect(n.body).toBe('');
    expect(n.folder).toBe('');
  });
  it('skips non-object entries', () => {
    const out = normalizeNotes([null, 'x', 3, { id: 'a' }], new Map(), () => 'GEN');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('a');
  });
});

describe('mergeFolders', () => {
  it('unions and dedupes non-empty paths', () => {
    expect(mergeFolders(['a'], ['b', 'a', '', 3, null])).toEqual(['a', 'b']);
  });
});

describe('mergeRefs', () => {
  it('merges by id (incoming wins) and repairs a missing authors array', () => {
    const out = mergeRefs(
      [{ id: 'r1', title: 'old', authors: [{ f: 'X' }] }],
      [{ id: 'r1', title: 'new' }, { id: 'r2', title: 'added' }],
    );
    const r1 = out.find((r) => r.id === 'r1');
    const r2 = out.find((r) => r.id === 'r2');
    expect(out).toHaveLength(2);
    expect(r1.title).toBe('new');
    expect(Array.isArray(r1.authors)).toBe(true);
    expect(Array.isArray(r2.authors)).toBe(true);
  });
  it('skips refs without an id', () => {
    expect(mergeRefs([], [{ title: 'no id' }, null, { id: 'ok' }])).toHaveLength(1);
  });
});
