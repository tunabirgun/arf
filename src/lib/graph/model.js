import { canonFolder } from '../folders.js';

// Pure graph model for the knowledge-graph view: nodes/links from the note index, filters,
// local (BFS) neighbourhoods, label level-of-detail and keyboard neighbour picking. No DOM.

const idOf = (v) => (v && typeof v === 'object' ? v.id : v);
const linkKey = (a, b) => (a < b ? a + '\u0000' + b : b + '\u0000' + a);

// Pointer client coordinates -> canvas drawing units. Under a CSS zoom on an ancestor (Settings view
// zoom sets html { zoom }), clientX and getBoundingClientRect are zoomed px while the canvas draws in
// clientWidth/clientHeight units, so the offset is scaled per axis by drawing size / rendered size.
export function clientToCanvas(clientX, clientY, rect, drawW, drawH) {
  const fx = drawW > 0 && rect.width > 0 ? drawW / rect.width : 1;
  const fy = drawH > 0 && rect.height > 0 ? drawH / rect.height : 1;
  return { x: (clientX - rect.left) * fx, y: (clientY - rect.top) * fy };
}

export function folderMatches(folder, prefix) {
  if (!prefix) return true;
  const f = canonFolder(String(folder || ''));
  return f === prefix || f.startsWith(prefix + '/');
}

// every distinct folder and each of its ancestors ('A/B' also lists 'A'), sorted
export function listFolders(notes) {
  const out = new Set();
  for (const n of notes) {
    const parts = canonFolder(String(n.folder || '')).split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) out.add(parts.slice(0, i).join('/'));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

export function listTags(idx) {
  return Object.keys(idx.tagIndex || {}).sort((a, b) => a.localeCompare(b));
}

// undirected neighbour ids of a note in the whole vault (forward links plus backlinks)
function vaultNeighbours(idx, id) {
  const s = new Set(idx.fwd[id] || []);
  for (const b of idx.back[id] || []) s.add(b);
  s.delete(id);
  return s;
}

// opts: { tag, folder, hideOrphans, search, only:Set|Array, suggest:[{a,b,s}] }
// degree and orphan status are vault-wide (stable node size while filtering);
// links are deduped, undirected, and only between kept nodes.
export function buildGraph(notes, idx, opts = {}) {
  const { tag = '', folder = '', hideOrphans = false, search = '', suggest = null } = opts;
  const only = opts.only ? new Set(opts.only) : null;
  const q = String(search || '').trim().toLowerCase();
  const tagged = tag ? new Set((idx.tagIndex && idx.tagIndex[tag]) || []) : null;
  const source = only ? [...only].map((id) => idx.byId[id]).filter(Boolean) : notes;
  const nodes = [], keep = new Map();
  for (const n of source) {
    if (!n || n.id == null || keep.has(n.id)) continue;
    const degree = vaultNeighbours(idx, n.id).size;
    const orphan = degree === 0;
    if (hideOrphans && orphan) continue;
    if (tagged && !tagged.has(n.id)) continue;
    if (!folderMatches(n.folder, folder)) continue;
    const title = String(n.title == null || n.title === '' ? 'Untitled' : n.title);
    if (q && !title.toLowerCase().includes(q)) continue;
    const node = { id: n.id, title, degree, folder: canonFolder(String(n.folder || '')), tags: (idx.noteTags && idx.noteTags[n.id]) || [], orphan };
    keep.set(n.id, node); nodes.push(node);
  }
  const links = [], seen = new Set();
  for (const node of nodes) {
    for (const t of vaultNeighbours(idx, node.id)) {
      if (!keep.has(t)) continue;
      const k = linkKey(node.id, t);
      if (seen.has(k)) continue;
      seen.add(k); links.push({ source: node.id, target: t, kind: 'link' });
    }
  }
  if (Array.isArray(suggest)) {
    for (const p of suggest) {
      if (!p || p.a === p.b || !keep.has(p.a) || !keep.has(p.b)) continue;
      const k = linkKey(p.a, p.b);
      if (seen.has(k)) continue;
      seen.add(k); links.push({ source: p.a, target: p.b, kind: 'suggested', s: +p.s || 0 });
    }
  }
  return { nodes, links };
}

// ids within `depth` hops of centerId over real links (suggested edges are not paths)
export function bfs(nodes, links, centerId, depth) {
  const ids = new Set(nodes.map((n) => n.id));
  if (!ids.has(centerId)) return new Set();
  const adj = adjacency(links);
  const out = new Set([centerId]);
  let frontier = [centerId];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next = [];
    for (const id of frontier) for (const nb of adj.get(id) || []) if (ids.has(nb) && !out.has(nb)) { out.add(nb); next.push(nb); }
    frontier = next;
  }
  return out;
}

export function subgraph(graph, keepIds) {
  return {
    nodes: graph.nodes.filter((n) => keepIds.has(n.id)),
    links: graph.links.filter((l) => keepIds.has(idOf(l.source)) && keepIds.has(idOf(l.target))),
  };
}

// id -> Set of linked ids, real links only
export function adjacency(links) {
  const adj = new Map();
  const add = (a, b) => { let s = adj.get(a); if (!s) adj.set(a, (s = new Set())); s.add(b); };
  for (const l of links) {
    if (l.kind === 'suggested') continue;
    const a = idOf(l.source), b = idOf(l.target);
    if (a === b) continue;
    add(a, b); add(b, a);
  }
  return adj;
}

export function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// Label level-of-detail. `byDegree` is sorted by degree, descending. `forced` (hovered, selected,
// neighbours, search hits, in priority order) is always labelled at full opacity; the rest fade in
// with smoothstep as zoom × degree weight passes [t0, t1]. At most `cap` labels; off-screen nodes
// are skipped through `visible`. Returns [node, alpha] pairs in draw-priority order.
export function selectLabels(byDegree, { k, forced = [], cap = 600, visible = () => true, t0 = 1.5, t1 = 2.4 } = {}) {
  const out = [], taken = new Set();
  for (const n of forced) {
    if (out.length >= cap) return out;
    if (!n || taken.has(n.id) || !visible(n)) continue;
    taken.add(n.id); out.push([n, 1]);
  }
  for (const n of byDegree) {
    if (out.length >= cap) break;
    const a = smoothstep(t0, t1, k * (1 + Math.log2(1 + n.degree)));
    if (a <= 0) break;   // sorted by degree: every later node scores lower
    if (taken.has(n.id) || !visible(n)) continue;
    taken.add(n.id); out.push([n, a]);
  }
  return out;
}

// title search ranked: exact, prefix, word-start, substring; ties by degree then title
export function searchNodes(nodes, query, limit = 200) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const n of nodes) {
    const t = n.title.toLowerCase();
    const i = t.indexOf(q);
    if (i < 0) continue;
    const rank = t === q ? 0 : i === 0 ? 1 : /[\s\-_/([]/.test(t[i - 1]) ? 2 : 3;
    scored.push([rank, n]);
  }
  scored.sort((a, b) => a[0] - b[0] || b[1].degree - a[1].degree || a[1].title.localeCompare(b[1].title));
  return scored.slice(0, limit).map((x) => x[1]);
}

// keyboard arrows: the linked neighbour best aligned with (dx, dy); falls back to any candidate.
// Score favours direction over distance; candidates behind the arrow are rejected.
export function nearestInDirection(from, candidates, dx, dy) {
  let best = null, bestScore = Infinity;
  for (const c of candidates) {
    if (c === from) continue;
    const vx = c.x - from.x, vy = c.y - from.y;
    const d = Math.hypot(vx, vy);
    if (d === 0) continue;
    const cos = (vx * dx + vy * dy) / d;
    if (cos <= 0.2) continue;
    const score = d * (2 - cos);
    if (score < bestScore) { bestScore = score; best = c; }
  }
  return best;
}
