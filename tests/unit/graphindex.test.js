import { describe, it, expect } from 'vitest';
import {
  parseWikilinks, parseInlineTags, buildIndex, buildVectorizer,
  cosine, related, sharedTerms, digestPairs, parseCacheStats, clearParseCache,
} from '../../src/lib/graphindex.js';
import * as ref from './fixtures/graphindex-reference.js';

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

// --- memoized parse products: the cached build must equal the original uncached algorithm exactly ---
// seeded PRNG (mulberry32) so a failure is reproducible
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const WORDS = 'protein kinase receptor ligand assay expression transcript chromatin düşünce proteine ğüşiöç neuron synapse the and constructor __proto__ toString'.split(' ');
function synth(count, seed = 7) {
  const r = rng(seed), pick = (a) => a[Math.floor(r() * a.length)];
  const titles = Array.from({ length: count }, (_, i) => (r() < 0.05 ? 'Dup title' : pick(WORDS) + ' ' + pick(WORDS) + ' ' + i));
  return titles.map((title, i) => {
    const parts = [];
    for (let p = 0; p < 2 + Math.floor(r() * 4); p++) {
      const w = Array.from({ length: 20 + Math.floor(r() * 40) }, () => pick(WORDS));
      if (r() < 0.6) w.splice(Math.floor(r() * w.length), 0, '[[' + pick(titles) + (r() < 0.2 ? '|alias' : '') + ']]');
      if (r() < 0.3) w.splice(Math.floor(r() * w.length), 0, '#' + pick(['Methods', 'idea', 'düşünce', 'a/b']));
      if (r() < 0.1) w.push('C# not#tag `[[in code]] #incode`');
      parts.push(w.join(' '));
    }
    if (r() < 0.15) parts.push('```py\n[[Hidden]] #hidden\n```');
    return { id: 'n' + String(i).padStart(4, '0'), title, tags: r() < 0.4 ? [pick(['Methods', 'review', 7, null])] : [], body: parts.join('\n\n') };
  });
}
// null-proto objects and key order both matter (cosine sums in key order), so compare JSON text as well as deep equality
function same(a, b) { expect(a).toEqual(b); expect(JSON.stringify(a)).toBe(JSON.stringify(b)); }
function expectIdentical(notes, probe = 'protein kinase of the synapse') {
  const i1 = buildIndex(notes), i0 = ref.buildIndex(notes);
  for (const k of ['byId', 'byTitle', 'fwd', 'back', 'tagIndex', 'noteTags']) same(i1[k], i0[k]);
  const v1 = buildVectorizer(notes), v0 = ref.buildVectorizer(notes);
  same(v1.vecs, v0.vecs);
  same(v1.vectorize(probe), v0.vectorize(probe));
  for (const t of ['protein', 'synapse', 'nonexistentterm']) expect(v1.idf(t)).toBe(v0.idf(t));
}

describe('memoized parse cache', () => {
  it('matches the uncached algorithm across edits, renames, deletes, re-adds and reorders (300 notes)', () => {
    clearParseCache();
    const notes = synth(300);
    expectIdentical(notes);
    const afterFirst = parseCacheStats();
    expect(afterFirst.size).toBe(300);

    // unchanged vault: every lookup is a hit
    expectIdentical(notes);
    expect(parseCacheStats().misses).toBe(afterFirst.misses); // the reference build never touches the cache

    // in-place edits: body only, title only (rename changes link resolution), tags only, both
    notes[3].body += '\n\nnew [[' + notes[10].title + ']] #fresh';
    notes[4].title = 'Renamed four';
    notes[20].body = notes[20].body.replace(/\[\[[^\]]+\]\]/, '[[Renamed four]]');
    notes[5].tags = ['frontmatter-only'];
    notes[6].title += ' x'; notes[6].body = 'only ' + notes[6].body;
    notes[7].body = ''; notes[8].title = ''; notes[9].title = undefined; notes[9].body = null;
    expectIdentical(notes);

    // deletions evict; a deleted id that comes back with different text must not see stale products
    const gone = notes.splice(50, 40);
    expectIdentical(notes);
    expect(parseCacheStats().size).toBe(notes.length);
    const back = { ...gone[0], body: 'completely different body about synapse and neuron [[Renamed four]]' };
    notes.push(back);
    expectIdentical(notes);

    // reorder + duplicate ids (cache thrashes but output stays correct)
    notes.reverse();
    notes.push({ ...notes[0], body: 'dup id other body #dupid' });
    expectIdentical(notes);
  });
  it('actually reuses products: an unchanged note is a hit, an edited one a miss', () => {
    clearParseCache();
    const notes = synth(20);
    buildIndex(notes); buildVectorizer(notes);
    const s0 = parseCacheStats();
    buildIndex(notes); buildVectorizer(notes);
    const s1 = parseCacheStats();
    expect(s1.misses).toBe(s0.misses);
    notes[0].body += ' edited';
    buildVectorizer(notes);
    expect(parseCacheStats().misses).toBe(s1.misses + 1);
  });
  it('a subset build with { evict: false } (resembleParagraph) keeps the left-out note memoized', () => {
    clearParseCache();
    const notes = synth(20), cur = notes[7], others = notes.filter((n) => n !== cur);
    buildIndex(notes); buildVectorizer(notes);
    const sub = buildVectorizer(others, { evict: false });
    same(sub.vecs, ref.buildVectorizer(others).vecs);
    same(sub.vecs, buildVectorizer(others).vecs);   // same output as the evicting build
    expect(sub.vectorize('synapse neuron')).toEqual(ref.buildVectorizer(others).vectorize('synapse neuron'));
    buildVectorizer(notes, { evict: false });
    const before = parseCacheStats();
    buildVectorizer(others, { evict: false });
    buildVectorizer(notes);                         // the next debounced full build
    expect(parseCacheStats().misses).toBe(before.misses);   // the current note was not re-parsed
    expect(parseCacheStats().size).toBe(20);
  });
  it('evicts ids absent from the build input and never stores tampered non-string fields', () => {
    clearParseCache();
    buildIndex([{ id: 'a', title: 'A', body: 'x' }, { id: 'b', title: 'B', body: 'y' }]);
    expect(parseCacheStats().size).toBe(2);
    buildVectorizer([{ id: 'a', title: 'A', body: 'x' }, { id: 'c', title: 5, body: 42 }]);
    expect(parseCacheStats().size).toBe(1); // only 'a' remains; the tampered note is parsed fresh, not stored
    same(buildVectorizer([{ id: 'c', title: 5, body: 42 }]).vecs, ref.buildVectorizer([{ id: 'c', title: 5, body: 42 }]).vecs);
  });
});
