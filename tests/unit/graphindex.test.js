import { describe, it, expect } from 'vitest';
import {
  parseWikilinks, parseInlineTags, buildIndex, buildVectorizer,
  cosine, related, sharedTerms, digestPairs,
} from '../../src/lib/graphindex.js';

describe('parseWikilinks', () => {
  it('extracts targets and resolves the alias form to the target', () => {
    expect(parseWikilinks('see [[Foo]] and [[Bar|baz]]')).toEqual(['Foo', 'Bar']);
  });
  it('ignores links inside fenced code', () => {
    expect(parseWikilinks('```\n[[Skip]]\n```\n[[Keep]]')).toEqual(['Keep']);
  });
});

describe('parseInlineTags', () => {
  it('finds tags at a boundary, keeps Unicode, and skips mid-word #', () => {
    const tags = parseInlineTags('#foo #bar not#baz #Düşünce');
    expect(tags).toContain('foo');
    expect(tags).toContain('bar');
    expect(tags).toContain('düşünce');
    expect(tags).not.toContain('baz');
  });
  it('indexes a tag adjacent to markup, matching how the renderer makes it clickable', () => {
    expect(parseInlineTags('Status: **#project** now')).toContain('project');
    expect(parseInlineTags('see [#linked] and (#paren)')).toEqual(expect.arrayContaining(['linked', 'paren']));
  });
});

describe('buildIndex', () => {
  it('builds forward links and backlinks by resolved title', () => {
    const notes = [
      { id: 'a', title: 'Alpha', body: 'links to [[Beta]]' },
      { id: 'b', title: 'Beta', body: '' },
    ];
    const idx = buildIndex(notes);
    expect(idx.fwd['a']).toEqual(['b']);
    expect(idx.back['b']).toEqual(['a']);
    expect(idx.byTitle['beta'].id).toBe('b');
  });
  it('resolves a duplicate title deterministically to the lowest id', () => {
    const idx = buildIndex([
      { id: 'b', title: 'Dup', body: '' },
      { id: 'a', title: 'Dup', body: '' },
    ]);
    expect(idx.byTitle['dup'].id).toBe('a');
  });
  it('does not follow a self-link', () => {
    const idx = buildIndex([{ id: 'a', title: 'Self', body: '[[Self]]' }]);
    expect(idx.fwd['a']).toEqual([]);
  });
  it('handles a note titled __proto__ without crashing', () => {
    expect(() => buildIndex([{ id: 'a', title: '__proto__', body: '[[constructor]]' }])).not.toThrow();
  });
  it('does not throw on a tampered cache with non-string title/tags/body', () => {
    expect(() => buildIndex([{ id: 'a', title: 5, tags: [null, 7], body: 42 }])).not.toThrow();
  });
  it('collects tags from frontmatter and inline body', () => {
    const idx = buildIndex([{ id: 'a', title: 'T', tags: ['fm'], body: 'text #inline' }]);
    expect(idx.noteTags['a']).toEqual(expect.arrayContaining(['fm', 'inline']));
  });
});

describe('cosine', () => {
  it('is 0 for a null vector and for disjoint vectors', () => {
    expect(cosine(null, { x: 1 })).toBe(0);
    expect(cosine({ x: 1 }, { y: 1 })).toBe(0);
  });
  it('multiplies shared dimensions', () => {
    expect(cosine({ x: 1 }, { x: 1 })).toBe(1);
  });
});

describe('related / sharedTerms / digestPairs', () => {
  const notes = [
    { id: 'a', title: 'Quantum decoherence', body: 'decoherence in quantum systems and environments' },
    { id: 'b', title: 'Decoherence theory', body: 'quantum decoherence explained for physical systems' },
    { id: 'c', title: 'Cooking', body: 'a recipe for bread with flour and yeast' },
  ];
  const { vecs, idf } = buildVectorizer(notes);

  it('surfaces the topically similar note, not the unrelated one', () => {
    const r = related('a', vecs, notes, { min: 0.01, max: 5 });
    expect(r[0].id).toBe('b');
  });
  it('reports the distinctive words two notes share', () => {
    const shared = sharedTerms(notes[0], notes[1], 5, idf);
    expect(shared).toContain('decoherence');
    expect(shared).toContain('quantum');
  });
  it('pairs unlinked but similar notes for the digest', () => {
    const idx = buildIndex(notes);
    const pairs = digestPairs(notes, vecs, idx, { min: 0.01, max: 5 });
    const top = pairs[0];
    expect([top.a, top.b].sort()).toEqual(['a', 'b']);
  });
});
