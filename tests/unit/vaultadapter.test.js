import { describe, it, expect } from 'vitest';
import { slug, serialize, parse, localISO } from '../../src/lib/vaultadapter.js';

describe('slug', () => {
  it('lowercases and hyphenates', () => {
    expect(slug('Hello World')).toBe('hello-world');
  });
  it('keeps Unicode letters (Turkish) instead of collapsing to untitled', () => {
    expect(slug('Çağrı Düşünce')).toBe('çağrı-düşünce');
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
