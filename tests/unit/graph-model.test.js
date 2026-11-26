import { describe, it, expect } from 'vitest';
import { buildIndex } from '../../src/lib/graphindex.js';
import { buildGraph, bfs, subgraph, adjacency, selectLabels, searchNodes, nearestInDirection, listFolders, listTags, folderMatches, smoothstep } from '../../src/lib/graph/model.js';

const note = (id, title, body = '', extra = {}) => ({ id, title, body, folder: '', tags: [], ...extra });
// A <-> B (both directions, must dedupe), A -> C, C -> C (self), D orphan, E -> F in folder Lab/Sub
const notes = [
  note('a', 'Alpha', '[[Beta]] [[Gamma]] [[Beta]] #method'),
  note('b', 'Beta', '[[Alpha]]'),
  note('c', 'Gamma', '[[Gamma]] [[Missing]]', { folder: 'Lab' }),
  note('d', 'Delta'),
  note('e', 'Epsilon', '[[Zeta]] #method', { folder: 'Lab/Sub' }),
  note('f', 'Zeta', '', { folder: 'Labour' }),
];
const idx = buildIndex(notes);
const keys = (g) => g.links.map((l) => [l.source, l.target].sort().join('-') + ':' + l.kind).sort();

describe('buildGraph', () => {
  it('dedupes undirected links and drops self-links', () => {
    const g = buildGraph(notes, idx);
    expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(keys(g)).toEqual(['a-b:link', 'a-c:link', 'e-f:link']);
    expect(g.links.some((l) => l.source === l.target)).toBe(false);
  });
  it('computes vault-wide degree and orphan status', () => {
    const g = buildGraph(notes, idx, { folder: 'Lab' });
    const c = g.nodes.find((n) => n.id === 'c');
    expect(c.degree).toBe(1);
    expect(buildGraph(notes, idx).nodes.find((n) => n.id === 'd').orphan).toBe(true);
    expect(buildGraph(notes, idx).nodes.find((n) => n.id === 'a').degree).toBe(2);
  });
  it('filters by folder prefix without matching sibling names', () => {
    const g = buildGraph(notes, idx, { folder: 'Lab' });
    expect(g.nodes.map((n) => n.id).sort()).toEqual(['c', 'e']);
    expect(g.links).toEqual([]);   // e-f crosses the filter boundary
    expect(folderMatches('Labour', 'Lab')).toBe(false);
    expect(folderMatches('Lab/Sub', 'Lab')).toBe(true);
  });
  it('canonicalises folder paths the way the sidebar does', () => {
    const odd = [note('p', 'P', '', { folder: 'Lab\\Sub/' }), note('q', 'Q', '', { folder: './Lab' })];
    const oi = buildIndex(odd);
    expect(buildGraph(odd, oi, { folder: 'Lab/Sub' }).nodes.map((n) => n.id)).toEqual(['p']);
    expect(buildGraph(odd, oi, { folder: 'Lab' }).nodes.map((n) => n.id)).toEqual(['p', 'q']);
    expect(listFolders(odd)).toEqual(['Lab', 'Lab/Sub']);
  });
  it('filters by tag, orphans and search text', () => {
    expect(buildGraph(notes, idx, { tag: 'method' }).nodes.map((n) => n.id)).toEqual(['a', 'e']);
    expect(buildGraph(notes, idx, { hideOrphans: true }).nodes.map((n) => n.id)).not.toContain('d');
    expect(buildGraph(notes, idx, { search: 'ta' }).nodes.map((n) => n.id)).toEqual(['b', 'd', 'f']);
  });
  it('adds suggested edges only between kept, unlinked nodes', () => {
    const suggest = [{ a: 'a', b: 'b', s: 0.9 }, { a: 'b', b: 'd', s: 0.5 }, { a: 'd', b: 'd', s: 1 }, { a: 'b', b: 'nope', s: 1 }];
    const g = buildGraph(notes, idx, { suggest });
    expect(keys(g)).toEqual(['a-b:link', 'a-c:link', 'b-d:suggested', 'e-f:link']);
    expect(g.links.find((l) => l.kind === 'suggested').s).toBe(0.5);
    expect(adjacency(g.links).get('d')).toBeUndefined();   // suggestions are not adjacency
  });
  it('restricts to `only` ids and survives untitled notes', () => {
    const local = [note('x', ''), note('y', 'Y', '[[]]')];
    const g = buildGraph(local, buildIndex(local));
    expect(g.nodes[0].title).toBe('Untitled');
    expect(buildGraph(notes, idx, { only: ['a', 'b', 'zz'] }).nodes.map((n) => n.id)).toEqual(['a', 'b']);
  });
  it('lists folders with ancestors and tags', () => {
    expect(listFolders(notes)).toEqual(['Lab', 'Lab/Sub', 'Labour']);
    expect(listTags(idx)).toEqual(['method']);
  });
});

describe('bfs', () => {
  const chain = [note('1', 'One', '[[Two]]'), note('2', 'Two', '[[Three]]'), note('3', 'Three', '[[Four]]'), note('4', 'Four')];
  const ci = buildIndex(chain);
  const g = buildGraph(chain, ci, { suggest: [{ a: '1', b: '4', s: 1 }] });
  it('respects depth and ignores suggested edges', () => {
    expect([...bfs(g.nodes, g.links, '1', 0)]).toEqual(['1']);
    expect([...bfs(g.nodes, g.links, '1', 1)].sort()).toEqual(['1', '2']);
    expect([...bfs(g.nodes, g.links, '1', 2)].sort()).toEqual(['1', '2', '3']);
    expect([...bfs(g.nodes, g.links, '2', 1)].sort()).toEqual(['1', '2', '3']);
    expect(bfs(g.nodes, g.links, 'missing', 2).size).toBe(0);
  });
  it('works on links already resolved to node objects', () => {
    const byId = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
    const resolved = g.links.map((l) => ({ ...l, source: byId[l.source], target: byId[l.target] }));
    expect([...bfs(g.nodes, resolved, '1', 3)].sort()).toEqual(['1', '2', '3', '4']);
    const sub = subgraph({ nodes: g.nodes, links: resolved }, new Set(['1', '2']));
    expect(sub.links.length).toBe(1);
  });
});

describe('selectLabels', () => {
  const mk = (id, degree) => ({ id, degree });
  const byDegree = [mk('h', 40), mk('m', 8), mk('l', 1), mk('z', 0)];
  it('labels forced nodes first at full opacity, in priority order, without duplicates', () => {
    const out = selectLabels(byDegree, { k: 0.1, forced: [byDegree[3], byDegree[2], byDegree[3]] });
    expect(out.map(([n, a]) => n.id + a)).toEqual(['z1', 'l1']);
  });
  it('fades in by zoom x degree with smoothstep and stops at the cap', () => {
    const far = selectLabels(byDegree, { k: 0.3 });
    expect(far.map(([n]) => n.id)).toEqual(['h']);
    const near = selectLabels(byDegree, { k: 3 });
    expect(near.map(([n]) => n.id)).toEqual(['h', 'm', 'l', 'z']);
    expect(near.every(([, a]) => a > 0 && a <= 1)).toBe(true);
    expect(selectLabels(byDegree, { k: 3, cap: 2 }).length).toBe(2);
    expect(selectLabels(byDegree, { k: 3, cap: 1, forced: [byDegree[3]] }).map(([n]) => n.id)).toEqual(['z']);
  });
  it('skips invisible nodes', () => {
    expect(selectLabels(byDegree, { k: 3, visible: (n) => n.id !== 'h' }).map(([n]) => n.id)).toEqual(['m', 'l', 'z']);
  });
  it('smoothstep is clamped and monotone', () => {
    expect(smoothstep(1, 2, 0)).toBe(0);
    expect(smoothstep(1, 2, 3)).toBe(1);
    expect(smoothstep(1, 2, 1.5)).toBeCloseTo(0.5);
  });
});

describe('searchNodes and nearestInDirection', () => {
  it('ranks exact, prefix, word-start, substring', () => {
    const ns = [{ title: 'Kinase assay', degree: 1 }, { title: 'Assay', degree: 0 }, { title: 'Assays of x', degree: 0 }, { title: 'Reassay', degree: 9 }];
    expect(searchNodes(ns, 'assay').map((n) => n.title)).toEqual(['Assay', 'Assays of x', 'Kinase assay', 'Reassay']);
    expect(searchNodes(ns, '  ')).toEqual([]);
  });
  it('picks the neighbour aligned with the arrow', () => {
    const o = { x: 0, y: 0 }, right = { x: 10, y: 1 }, farRight = { x: 30, y: 0 }, up = { x: 0, y: -5 }, left = { x: -5, y: 0 };
    expect(nearestInDirection(o, [right, farRight, up, left], 1, 0)).toBe(right);
    expect(nearestInDirection(o, [right, up], 0, -1)).toBe(up);
    expect(nearestInDirection(o, [right], -1, 0)).toBe(null);
  });
});
