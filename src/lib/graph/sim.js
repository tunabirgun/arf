// d3-force wrapper for the graph view. The simulation never runs its own timer: the renderer calls
// step(now) once per animation frame and at most one tick happens per frame at a fixed 60 Hz step.
import { forceSimulation, forceManyBody, forceLink, forceCollide, forceX, forceY } from 'd3-force';

export const DEFAULT_FORCES = { repel: 90, linkDistance: 55, linkForce: 1, center: 0.06 };
export const FORCE_RANGES = {
  repel: [10, 400, 5], linkDistance: [15, 200, 5], linkForce: [0.1, 2, 0.05], center: [0, 0.3, 0.01],
};
export const PIN_KEY = 'arf-graph-pins-v1';
export const PIN_CAP = 2000;          // bounded pin store: oldest pins drop first
export const CLICK_PX = 5;            // click-vs-drag tolerance in screen px (force-graph DRAG_CLICK_TOLERANCE_PX)
export const DRAG_ALPHA = 0.3;        // alphaTarget while dragging (d3 drag examples, force-graph)
export const ALPHA_MIN = 0.001;       // d3 default; the loop sleeps below it
const STEP = 1000 / 60;
const COLLIDE_MAX_NODES = 3000;
// Large graphs: Barnes-Hut theta 1.2 above 1000 nodes (ForceAtlas2's default) and 1.5 above 1500;
// collision every other tick, and none while a drag holds alphaTarget up (the settle after release
// clears transient overlap). Measured at 2000 nodes: charge ~9 ms/tick at theta 0.9, ~5 ms at 1.5.
const LARGE = 1000, HUGE = 1500;

export function nodeRadius(degree) { return 3 + Math.min(11, Math.sqrt(degree || 0) * 1.7); }

// deterministic per-id jitter so placement of new nodes is reproducible
function hash01(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10007) / 10007; }

// pin store over a localStorage-like object; always read-modify-write so two views never clobber
export function createPinStore(storage, key = PIN_KEY, cap = PIN_CAP) {
  const read = () => { try { const v = JSON.parse((storage && storage.getItem(key)) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (e) { return {}; } };
  const write = (obj) => {
    const ids = Object.keys(obj);
    if (ids.length > cap) for (const id of ids.slice(0, ids.length - cap)) delete obj[id];
    try { storage && storage.setItem(key, JSON.stringify(obj)); } catch (e) {}
  };
  return {
    all: read,
    set(entries) { const o = read(); for (const [id, x, y] of entries) { delete o[id]; o[id] = [Math.round(x * 10) / 10, Math.round(y * 10) / 10]; } write(o); },
    remove(ids) { const o = read(); let hit = false; for (const id of ids) if (id in o) { delete o[id]; hit = true; } if (hit) write(o); },
  };
}

// opts: { forces, pins (store or null = in-memory pins only), local, reduced, positions: Map id->{x,y} }
export function createSim(opts = {}) {
  const forces = { ...DEFAULT_FORCES, ...(opts.forces || {}) };
  const pins = opts.pins || null;
  const local = !!opts.local;
  let reduced = !!opts.reduced;
  let nodes = [], links = [], suggested = [];
  const byId = new Map();
  let deg = new Map();
  let linkSig = '';

  const charge = forceManyBody().theta(0.9).distanceMax(local ? 260 : 400);
  const link = forceLink([]).id((d) => d.id);
  const collide = forceCollide((d) => nodeRadius(d.degree) + 2).strength(0.7).iterations(1);
  let tickNo = 0;
  const halfCollide = (a) => { if ((tickNo & 1) === 0 && sim.alphaTarget() === 0) collide(a); };
  halfCollide.initialize = (n, r) => collide.initialize(n, r);
  const fx = forceX(0), fy = forceY(0);
  const sim = forceSimulation([]).stop()
    .alphaMin(ALPHA_MIN).velocityDecay(0.3).alphaDecay(local ? 0.04 : reduced ? 0.05 : 0.0228)
    .force('x', fx).force('y', fy).force('link', link).force('charge', charge).force('collide', collide);

  function applyForces() {
    charge.strength(-forces.repel);
    // d3's default strength is 1/min(degree); scaled by the user multiplier, capped at 1 for stability
    link.distance(forces.linkDistance).strength((l) => Math.min(1, forces.linkForce / Math.max(1, Math.min(deg.get(l.source.id) || 1, deg.get(l.target.id) || 1))));
    fx.strength(forces.center); fy.strength(forces.center);
  }

  let last = null, acc = 0;
  const api = {
    sim, forces,
    get nodes() { return nodes; },
    get links() { return links; },
    get suggested() { return suggested; },
    node: (id) => byId.get(id),
    get running() { return sim.alpha() >= ALPHA_MIN || sim.alphaTarget() > 0; },
    alpha: () => sim.alpha(),
    setReduced(v) { reduced = !!v; if (!local) sim.alphaDecay(reduced ? 0.05 : 0.0228); },

    // graph: { nodes:[{id,title,degree,...}], links:[{source,target,kind}] } from model.buildGraph.
    // Node objects are kept by id so positions, velocities and pins survive data updates.
    setData(graph, { positions } = {}) {
      const prevIds = new Set(byId.keys());
      const next = [];
      const stored = pins ? pins.all() : {};
      const fresh = [];
      for (const g of graph.nodes) {
        let n = byId.get(g.id);
        if (!n) {
          n = { id: g.id, pinned: false };
          const p = positions && positions.get(g.id);
          if (p) { n.x = p.x; n.y = p.y; }
          const s = stored[g.id];
          if (Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1])) { n.x = n.fx = s[0]; n.y = n.fy = s[1]; n.pinned = true; }
          if (n.x == null) fresh.push(n);
        }
        n.title = g.title; n.degree = g.degree; n.orphan = g.orphan; n.folder = g.folder; n.tags = g.tags;
        next.push(n);
      }
      byId.clear();
      for (const n of next) byId.set(n.id, n);
      const real = graph.links.filter((l) => l.kind !== 'suggested');
      deg = new Map();
      for (const l of real) { const a = l.source.id ?? l.source, b = l.target.id ?? l.target; deg.set(a, (deg.get(a) || 0) + 1); deg.set(b, (deg.get(b) || 0) + 1); }
      // new nodes appear beside an already-placed linked neighbour; on a first build they are left
      // unplaced so d3 seeds its compact phyllotaxis spiral
      if (fresh.length && fresh.length < next.length) {
        const placed = next.filter((n) => n.x != null);
        let cx = 0, cy = 0; for (const p of placed) { cx += p.x; cy += p.y; } cx /= placed.length || 1; cy /= placed.length || 1;
        const nb = new Map();
        for (const l of real) { const a = l.source.id ?? l.source, b = l.target.id ?? l.target; if (!nb.has(a)) nb.set(a, []); if (!nb.has(b)) nb.set(b, []); nb.get(a).push(b); nb.get(b).push(a); }
        for (const n of fresh) {
          const anchor = (nb.get(n.id) || []).map((id) => byId.get(id)).find((m) => m && m.x != null);
          const a = hash01(n.id) * Math.PI * 2, r = anchor ? forces.linkDistance * 0.6 : 40 + hash01(n.id + '#') * 80;
          const o = anchor || { x: cx, y: cy };
          n.x = o.x + Math.cos(a) * r; n.y = o.y + Math.sin(a) * r; n.vx = 0; n.vy = 0;
        }
      }
      nodes = next;
      links = real.map((l) => ({ source: l.source.id ?? l.source, target: l.target.id ?? l.target }));
      suggested = graph.links.filter((l) => l.kind === 'suggested').map((l) => ({ source: l.source.id ?? l.source, target: l.target.id ?? l.target, s: l.s }));
      sim.nodes(nodes);
      collide.radius((d) => nodeRadius(d.degree) + 2);
      const large = nodes.length > LARGE;
      charge.theta(nodes.length > HUGE ? 1.5 : large ? 1.2 : 0.9);
      sim.force('collide', nodes.length > COLLIDE_MAX_NODES ? null : large ? halfCollide : collide);
      link.links(links);
      applyForces();
      for (const s of suggested) { s.source = byId.get(s.source); s.target = byId.get(s.target); }
      const sameNodes = prevIds.size === next.length && next.every((n) => prevIds.has(n.id));
      const sig = links.map((l) => l.source.id + '>' + l.target.id).join('|');
      const changed = !sameNodes || sig !== linkSig;
      linkSig = sig;
      if (changed && prevIds.size) sim.alpha(Math.max(sim.alpha(), 0.3));
      if (!prevIds.size) sim.alpha(1);
      return { changed, fresh: fresh.length };
    },

    setForces(f) { Object.assign(forces, f); applyForces(); api.reheat(0.3); },
    reheat(a = 0.3) { sim.alpha(Math.max(sim.alpha(), a)); last = null; },

    // synchronous warm start bounded by tick count and wall time
    warm(maxTicks = 150, budgetMs = 150, clock = () => performance.now()) {
      const t0 = clock(); let n = 0;
      while (n < maxTicks && sim.alpha() >= ALPHA_MIN && clock() - t0 < budgetMs) { tickNo++; sim.tick(); n++; }
      return n;
    },

    // fixed-step advance: at most one tick per call, 60 Hz regardless of display rate
    step(now) {
      if (!api.running) { last = null; return false; }
      if (last == null || now - last > 100) { last = now - STEP; acc = 0; }
      acc += now - last; last = now;
      if (acc < STEP - 1) return false;
      acc = Math.max(0, Math.min(STEP, acc - STEP));
      tickNo++;
      sim.tick();
      return true;
    },

    pinNodes(list) {
      const ok = list.filter(Boolean);
      for (const n of ok) { n.fx = n.x; n.fy = n.y; n.pinned = true; }
      if (pins && ok.length) pins.set(ok.map((n) => [n.id, n.x, n.y]));
    },
    unpinNodes(list, reheat = 0.1) {
      const ok = list.filter(Boolean);
      for (const n of ok) { n.fx = n.fy = null; n.pinned = false; }
      if (pins && ok.length) pins.remove(ok.map((n) => n.id));
      if (reheat && ok.length) api.reheat(reheat);
    },
    pin(n) { api.pinNodes([n]); },
    unpin(n) { api.unpinNodes([n]); },
    togglePin(n) { if (n) (n.pinned ? api.unpin(n) : api.pin(n)); },
    unpinAll() {
      const ids = [];
      for (const n of nodes) if (n.pinned) { n.fx = n.fy = null; n.pinned = false; ids.push(n.id); }
      if (pins) pins.remove(Object.keys(pins.all()));
      if (ids.length) api.reheat(0.3);
      return ids.length;
    },

    positions() { const m = new Map(); for (const n of nodes) m.set(n.id, { x: n.x, y: n.y }); return m; },
    stop() { sim.alphaTarget(0); sim.stop(); },
  };
  api.drag = createDrag(api);
  return api;
}

// Drag/pull state machine: idle -> pressed -> dragging -> idle. Coordinates: s* screen px, g* graph units.
export function createDrag(api, { threshold = CLICK_PX } = {}) {
  let st = null;
  const d = {
    get state() { return st ? st.phase : 'idle'; },
    get node() { return st ? st.node : null; },
    get group() { return st ? st.group.map((g) => g.n) : []; },
    // group: nodes moved together (the selection when the pressed node is selected)
    press(node, sx, sy, gx, gy, group) {
      const g = (group && group.length ? group : [node]);
      if (!g.includes(node)) g.push(node);
      st = { phase: 'pressed', node, sx, sy, gx, gy, group: g.map((n) => ({ n, ox: n.x, oy: n.y, wasPinned: !!n.pinned })) };
    },
    move(sx, sy, gx, gy, reduced = false) {
      if (!st) return 'idle';
      if (st.phase === 'pressed') {
        if (Math.hypot(sx - st.sx, sy - st.sy) < threshold) return 'pressed';
        st.phase = 'dragging';
        for (const g of st.group) { g.ox = g.n.x; g.oy = g.n.y; g.n.fx = g.n.x; g.n.fy = g.n.y; }
        if (!reduced) { api.sim.alphaTarget(DRAG_ALPHA); api.sim.alpha(Math.max(api.sim.alpha(), 0.1)); }
      }
      const dx = gx - st.gx, dy = gy - st.gy;
      for (const g of st.group) { g.n.fx = g.n.x = g.ox + dx; g.n.fy = g.n.y = g.oy + dy; g.n.vx = g.n.vy = 0; }
      return 'dragging';
    },
    // shift toggles a persistent pin on release; otherwise each node returns to its prior pin state
    release({ shift = false } = {}) {
      if (!st) return null;
      const s = st; st = null;
      if (s.phase === 'pressed') return { type: 'click', node: s.node };
      api.sim.alphaTarget(0);
      const keep = [], drop = [];
      for (const g of s.group) ((shift ? !g.wasPinned : g.wasPinned) ? keep : drop).push(g);
      api.pinNodes(keep.map((g) => g.n));
      for (const g of drop) { g.n.fx = g.n.fy = null; g.n.pinned = false; }
      // only a node that was pinned before needs its stored pin removed; alpha is already up from the drag
      api.unpinNodes(drop.filter((g) => g.wasPinned).map((g) => g.n), 0);
      return { type: 'drag', node: s.node, nodes: s.group.map((g) => g.n) };
    },
    // pointer cancel, window blur, unmount: never leave alphaTarget > 0 behind
    cancel() {
      if (!st) { api.sim.alphaTarget(0); return null; }
      const s = st; st = null;
      api.sim.alphaTarget(0);
      if (s.phase === 'dragging') {
        for (const g of s.group) if (!g.wasPinned) { g.n.fx = g.n.fy = null; g.n.pinned = false; }
        api.pinNodes(s.group.filter((g) => g.wasPinned).map((g) => g.n));   // a pinned node keeps its new place
      }
      return { type: 'cancel', node: s.node };
    },
  };
  return d;
}
