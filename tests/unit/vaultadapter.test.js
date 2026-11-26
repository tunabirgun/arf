import { describe, it, expect } from 'vitest';
import { slug, legacySlug, keepPath, serialize, parse, localISO, TauriBackend } from '../../src/lib/vaultadapter.js';

describe('slug: NFC, combining marks, no rename flip-flop', () => {
  it('composes decomposed (NFD) titles instead of splitting at the accent', () => {
    expect(slug('café note')).toBe('café-note');
    expect(slug('İstanbul')).toBe('istanbul');
    expect(slug('Ç'.normalize('NFD') + 'ağrı')).toBe('çağrı');
  });
  it('keeps combining marks that belong to letters (Devanagari vowel signs)', () => {
    expect(slug('हिन्दी नोट')).toBe('हिन्दी-नोट');
  });
  it('keepPath keeps a file named by the pre-3.0 slug while the title is unchanged', () => {
    expect(legacySlug('İstanbul')).toBe('i-stanbul');
    const n = { id: '01ABCDEFGHJKMNPQRSTVWXYZ12', title: 'İstanbul', folder: 'Gezi', _path: 'Gezi/i-stanbul.md' };
    expect(keepPath(n)).toBe('Gezi/i-stanbul.md');
    expect(keepPath({ ...n, _path: 'Gezi/i-stanbul-xyz12.md' })).toBe('Gezi/i-stanbul-xyz12.md');
    expect(keepPath({ ...n, title: 'Ankara' })).toBeNull();          // a real rename moves the file
    expect(keepPath({ ...n, folder: 'Other' })).toBeNull();          // and so does a move
    expect(keepPath({ ...n, _path: undefined })).toBeNull();
  });
  it('saveNote does not rename a legacy-named file on save, and renames on a title change', async () => {
    const files = new Map([['V/Gezi/i-stanbul.md', 'old']]);
    const fs = {
      exists: async (p) => files.has(p), mkdir: async () => {}, writeTextFile: async (p, t) => { files.set(p, t); },
      remove: async (p) => { files.delete(p); },
    };
    const b = new TauriBackend('V', fs);
    const n = { id: '01ABCDEFGHJKMNPQRSTVWXYZ12', title: 'İstanbul', folder: 'Gezi', tags: [], body: 'x', _path: 'Gezi/i-stanbul.md' };
    await b.saveNote(n);
    expect(n._path).toBe('Gezi/i-stanbul.md');
    expect([...files.keys()]).toEqual(['V/Gezi/i-stanbul.md']);
    n.title = 'İzmir';
    await b.saveNote(n);
    expect(n._path).toBe('Gezi/izmir.md');
    expect([...files.keys()]).toEqual(['V/Gezi/izmir.md']);
  });
});

describe('slug', () => {
  it('lowercases and hyphenates', () => {
    expect(slug('Hello World')).toBe('hello-world');
  });
  it('keeps Unicode letters (Turkish) instead of collapsing to untitled', () => {
    expect(slug('Çağrı Düşünce')).toBe('çağrı-düşünce');
  });
  it('folds Turkish dotted capital I (İ -> i, no stray combining dot)', () => {
    expect(slug('Şeker İşleme')).toBe('şeker-işleme');
    expect(slug('İSTANBUL')).toBe('istanbul');
    expect(slug('İ')).toBe('i');
    expect(slug('Şeker İşleme')).not.toMatch(/̇/);
  });
  it('leaves dotless ı and other letters untouched', () => {
    expect(slug('ışık Ölçümü')).toBe('ışık-ölçümü');   // toLowerCase is not locale-aware: only İ needs the fold
  });
  it('falls back to untitled for empty or symbol-only titles', () => {
    expect(slug('')).toBe('untitled');
    expect(slug('!!!')).toBe('untitled');
  });
  it('escapes Windows reserved device names', () => {
    expect(slug('CON')).toBe('con-note');
    expect(slug('com1')).toBe('com1-note');
  });
  it('truncates to 80 chars', () => {
    expect(slug('a'.repeat(200)).length).toBe(80);
  });
});

describe('serialize / parse', () => {
  const note = {
    id: 'ABC123', title: 'My "Quoted" Note', tags: ['x', 'y'],
    created: '2020-01-01T00:00:00.000Z', updated: '2020-01-02T00:00:00.000Z',
    body: 'Hello\nworld',
  };

  it('round-trips id, title (with quotes), tags, timestamps, body', () => {
    const p = parse(serialize(note));
    expect(p.id).toBe('ABC123');
    expect(p.title).toBe('My "Quoted" Note');
    expect(p.tags).toEqual(['x', 'y']);
    expect(p.created).toBe('2020-01-01T00:00:00.000Z');
    expect(p.updated).toBe('2020-01-02T00:00:00.000Z');
    expect(p.body).toBe('Hello\nworld\n');
  });

  it('round-trips a backslash in the title', () => {
    const p = parse(serialize({ ...note, title: 'path\\to\\thing' }));
    expect(p.title).toBe('path\\to\\thing');
  });

  it('neutralizes a newline injected into the title (no forged frontmatter line)', () => {
    const out = serialize({ ...note, title: 'T\nid: evil' });
    expect(/\nid: evil/.test(out)).toBe(false);
    expect(parse(out).id).toBe('ABC123');
  });

  it('parses a note with no frontmatter using fallbacks', () => {
    const p = parse('just some body text', { fallbackTitle: 'Fallback' });
    expect(p.title).toBe('Fallback');
    expect(p.body).toBe('just some body text');
    expect(p.id).toMatch(/^n/);
  });

  it('tolerates CRLF frontmatter', () => {
    const text = '---\r\nid: z1\r\ntitle: "T"\r\ntags: [a, b]\r\n---\r\nbody here';
    const p = parse(text);
    expect(p.id).toBe('z1');
    expect(p.tags).toEqual(['a', 'b']);
    expect(p.body).toBe('body here');
  });

  it('writes local-time companions but keeps created/updated canonical UTC on parse', () => {
    const out = serialize(note);
    expect(out).toContain('created: 2020-01-01T00:00:00.000Z');
    expect(out).toContain('created_local:');
    expect(out).toContain('updated_local:');
    const p = parse(out);                       // parse ignores the _local lines; UTC stays canonical
    expect(p.created).toBe('2020-01-01T00:00:00.000Z');
    expect(p.updated).toBe('2020-01-02T00:00:00.000Z');
  });

  it('self-flush round-trips byte-for-byte (local fields are derived, not re-stamped)', () => {
    expect(serialize(note)).toBe(serialize(note));
  });
});

describe('localISO', () => {
  it('encodes local wall-clock with a signed UTC offset', () => {
    expect(localISO('2020-01-01T00:00:00.000Z')).toMatch(/^2019|^2020-01-01T\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  });
  it('returns empty for an unparseable timestamp (so no bogus line is written)', () => {
    expect(localISO('not-a-date')).toBe('');
    expect(localISO('')).toBe('');
  });
  it('round-trips back to the same UTC instant', () => {
    const utc = '2020-06-15T12:34:56.000Z';
    expect(new Date(localISO(utc)).toISOString()).toBe(utc);
  });
});

describe('parse stamp option', () => {
  const STAMP = '2021-05-05T05:05:05.000Z';
  it('uses opts.stamp for a missing created/updated', () => {
    const p = parse('plain body', { stamp: STAMP });
    expect(p.created).toBe(STAMP);
    expect(p.updated).toBe(STAMP);
  });
  it('lets frontmatter timestamps win over the stamp, per field', () => {
    const p = parse('---\nid: a\nupdated: 2020-01-02T00:00:00.000Z\n---\nbody', { stamp: STAMP });
    expect(p.updated).toBe('2020-01-02T00:00:00.000Z');
    expect(p.created).toBe(STAMP);
  });
  it('without a stamp still falls back to the current time', () => {
    const before = Date.now();
    const p = parse('plain body');
    expect(Date.parse(p.updated)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(p.created)).toBeGreaterThanOrEqual(before);
  });
});
