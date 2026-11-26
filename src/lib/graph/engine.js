// Imperative graph engine: owns the simulation, camera (d3-zoom), pointer interaction and the
// dirty-flag render loop. GraphView.svelte owns only the chrome and passes data in.
import { select } from 'd3-selection';
import { zoom as d3zoom, zoomIdentity } from 'd3-zoom';
import { quadtree } from 'd3-quadtree';
import { createSim, createPinStore, CLICK_PX } from './sim.js';
import { adjacency, nearestInDirection, clientToCanvas } from './model.js';
import { readTheme, buildFrame, drawScene, frameToSVG, hitRadius } from './render.js';
import { DUR } from '../motion.svelte.js';

const WHEEL = Math.log2(1.5) / 120;      // a 120 px wheel notch zooms x1.5
const SCALE = [0.1, 8];
const PAN_DECAY_MS = 200;                // inertia: v *= exp(-dt / 200 ms)
const memory = new Map();                // scope -> { pos: Map(id -> {x, y}), t } for the session

const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);   // cubic in-out
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// opts: { mode:'ego'|'full', host, storage, reduced:()=>bool, onopen, onselect, onhover, onfocus, probe }
export function createEngine(canvas, opts) {
  const ego = opts.mode === 'ego';
  const scope = ego ? 'ego' : 'full';
  const reduced = () => !!(opts.reduced && opts.reduced());
  const mem = memory.get(scope) || { pos: new Map(), t: null };
  memory.set(scope, mem);
  const sim = createSim({ local: ego, reduced: reduced(), pins: ego ? null : createPinStore(opts.storage) });
  const ctx = canvas.getContext('2d');
  const host = opts.host || canvas.parentElement;

  const S = {
    w: 0, h: 0, dpr: 1, t: { k: 1, x: 0, y: 0 }, theme: readTheme(host),
    nodes: [], links: [], suggested: [], byDegree: [], byId: new Map(), adj: new Map(),
    showSuggested: true, centerId: null, hovered: null, emph: null, fade: 0,
    selected: new Set(), focusId: null, matches: null, interacting: false, ego, labelPx: ego ? 11 : 12,
  };
  let fadeTarget = 0, lastFrame = null, frame = null;
  let raf = 0, dirty = true, destroyed = false, qt = null, qtDirty = true, fitPending = false;
  let tween = null, inertia = null, samples = [], panning = false, bgPress = null;
  let autoFit = false;   // camera follows the settling layout until the user takes the camera
  const stats = opts.probe ? { frames: [], tick: [], draw: [], firstFrameAt: 0, t0: performance.now(), ticks: 0 } : null;

  // ---------- loop ----------
  const wake = () => { if (!raf && !destroyed) raf = requestAnimationFrame(loop); };
  const invalidate = () => { dirty = true; wake(); };
  function loop(now) {
    raf = 0;
    if (destroyed || !S.w || !S.h) return;          // hidden (collapsed rail): sleep until resized
    const t0 = performance.now();
    const dt = lastFrame == null ? 16 : Math.min(64, now - lastFrame);
    lastFrame = now;
    let active = false;
    if (sim.running) {
      active = true;
      const ts = stats ? performance.now() : 0;
      if (sim.step(now)) { dirty = qtDirty = true; if (stats) { stats.ticks++; stats.tick.push(performance.now() - ts); } }
    } else if (!sim.running && mem.dirty) { saveMemory(); }
    if (S.fade !== fadeTarget) {
      const step = reduced() ? 1 : dt / DUR.fast;
      S.fade = fadeTarget > S.fade ? Math.min(fadeTarget, S.fade + step) : Math.max(fadeTarget, S.fade - step);
      if (S.fade === 0) S.emph = null;
      dirty = active = true;
    }
    if (autoFit && !tween) {
      if (!sim.running) { autoFit = false; setTransform(fitTransform()); }
      else {
        const f = fitTransform(), c = S.t, a = 0.18;
        const k = Math.exp(Math.log(c.k) + (Math.log(f.k) - Math.log(c.k)) * a);
        setTransform({ k, x: c.x + (f.x - c.x) * a, y: c.y + (f.y - c.y) * a });
      }
    }
    if (tween) { active = true; runTween(now); }
    if (inertia) { active = true; runInertia(now, dt); }
    if (dirty) {
      S.interacting = sim.drag.state === 'dragging' || panning || !!tween || !!inertia;
      const td = stats ? performance.now() : 0;
      frame = buildFrame(S);
      drawScene(ctx, S, frame);
      dirty = false;
      if (stats) {
        stats.draw.push(performance.now() - td);
        if (!stats.firstFrameAt) stats.firstFrameAt = performance.now();
        stats.frames.push(performance.now() - t0);
        for (const a of [stats.frames, stats.tick, stats.draw]) if (a.length > 2000) a.shift();
      }
    }
    if (active) wake(); else lastFrame = null;
  }

  // ---------- camera ----------
  const zb = ego ? null : d3zoom().scaleExtent(SCALE).clickDistance(CLICK_PX)
    .wheelDelta((ev) => -ev.deltaY * (ev.deltaMode === 1 ? 40 : ev.deltaMode ? 800 : 1) * WHEEL * (ev.ctrlKey ? 10 : 1))
    .filter((ev) => {
      if (ev.type === 'wheel') return true;
      if (ev.button || (ev.ctrlKey && ev.type !== 'wheel') || ev.metaKey) return false;
      const src = ev.touches ? ev.touches[0] : ev;
      if (!src) return true;
      const p = pos(src);
      return !hit(p.x, p.y, !!ev.touches);   // node presses never pan
    })
    .on('start', (ev) => {
      if (ev.sourceEvent) { tween = null; inertia = null; autoFit = false; panning = ev.sourceEvent.type !== 'wheel'; samples = []; }
    })
    .on('zoom', (ev) => {
      // d3-zoom reads pointers as client px minus the bounding rect (zoomed px): its translate is in
      // zoomed px, so divide by zf to get drawing units. k is shared, which keeps pan and wheel anchors exact.
      S.t = { k: ev.transform.k, x: ev.transform.x / zf, y: ev.transform.y / zf };
      const se = ev.sourceEvent;
      if (se && (se.type === 'mousemove' || se.type === 'touchmove')) {
        const now = performance.now();
        samples.push([now, S.t.x, S.t.y]);
        while (samples.length && now - samples[0][0] > 100) samples.shift();
      }
      invalidate();
    })
    .on('end', (ev) => {
      const wasPan = panning; panning = false;
      if (!ev.sourceEvent || !wasPan || reduced() || samples.length < 2) { invalidate(); return; }
      const now = performance.now(), a = samples[0], b = samples[samples.length - 1];
      if (now - b[0] > 50) { invalidate(); return; }                 // released after a pause: no throw
      const dtv = Math.max(8, b[0] - a[0]);
      const vx = (b[1] - a[1]) / dtv, vy = (b[2] - a[2]) / dtv;
      if (Math.hypot(vx, vy) > 0.05) { inertia = { vx, vy, last: null }; wake(); }
    });
  const zsel = zb ? select(canvas).call(zb).on('dblclick.zoom', null) : null;
  // rendered px per drawing unit: the root CSS zoom (Settings view zoom, 70-160 %), 1 when unzoomed
  let zf = 1;
  function measureZf() {
    const r = canvas.getBoundingClientRect();
    return S.w > 0 && r.width > 0 ? r.width / S.w : 1;
  }

  function setTransform(t) {
    const k = clamp(t.k, SCALE[0], SCALE[1]);
    if (zb) zb.transform(zsel, zoomIdentity.translate(t.x * zf, t.y * zf).scale(k));
    else { S.t = { k, x: t.x, y: t.y }; }
    invalidate();
  }
  // follow: a node the camera keeps centred while it moves (the layout may still be settling)
  function cameraTo(t, ms = DUR.slow, follow = null) {
    inertia = null; autoFit = false;
    if (reduced() || ms <= 0) { tween = null; setTransform(t); return; }
    const from = S.t;
    const c0 = { x: (S.w / 2 - from.x) / from.k, y: (S.h / 2 - from.y) / from.k };
    const c1 = { x: (S.w / 2 - t.x) / t.k, y: (S.h / 2 - t.y) / t.k };
    tween = { start: null, ms, from, c0, c1, follow, k0: Math.log(from.k), k1: Math.log(clamp(t.k, SCALE[0], SCALE[1])) };
    wake();
  }
  function runTween(now) {
    if (tween.start == null) tween.start = now;
    const p = Math.min(1, (now - tween.start) / tween.ms), e = ease(p);
    if (tween.follow) tween.c1 = { x: tween.follow.x, y: tween.follow.y };
    const k = Math.exp(tween.k0 + (tween.k1 - tween.k0) * e);
    const cx = tween.c0.x + (tween.c1.x - tween.c0.x) * e, cy = tween.c0.y + (tween.c1.y - tween.c0.y) * e;
    const done = p >= 1;
    if (done) tween = null;
    setTransform({ k, x: S.w / 2 - cx * k, y: S.h / 2 - cy * k });
  }
  function runInertia(now, dt) {
    const v = inertia;
    if (v.last == null) { v.last = now; return; }
    const d = Math.exp(-dt / PAN_DECAY_MS);
    v.vx *= d; v.vy *= d;
    if (Math.hypot(v.vx, v.vy) < 0.02) { inertia = null; invalidate(); return; }
    setTransform({ k: S.t.k, x: S.t.x + v.vx * dt, y: S.t.y + v.vy * dt });
  }
  function fitTransform(list = S.nodes, maxK = ego ? 1 : 2.5) {
    const pts = list.filter((n) => Number.isFinite(n.x));
    if (!pts.length || !S.w || !S.h) return { k: 1, x: S.w / 2, y: S.h / 2 };
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of pts) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
    const padX = ego ? 34 : 40, padY = ego ? 26 : 40;   // room for labels under nodes
    const k = clamp(Math.min((S.w - 2 * padX) / Math.max(1, x1 - x0), (S.h - 2 * padY) / Math.max(1, y1 - y0)), SCALE[0], maxK);
    return { k, x: S.w / 2 - ((x0 + x1) / 2) * k, y: S.h / 2 - ((y0 + y1) / 2) * k - (ego ? 6 : 0) };
  }

  // ---------- hit testing ----------
  function hit(px, py, touch = false) {
    if (!S.nodes.length) return null;
    if (qtDirty || !qt) { qt = quadtree(S.nodes, (d) => d.x, (d) => d.y); qtDirty = false; }
    const k = S.t.k, gx = (px - S.t.x) / k, gy = (py - S.t.y) / k;
    // search radius covers the largest node; then accept only within that node's own hit radius
    const n = qt.find(gx, gy, Math.max(14, (touch ? 22 : 10) / k));
    if (!n) return null;
    return Math.hypot(n.x - gx, n.y - gy) <= hitRadius(n, k, touch) ? n : null;
  }
  const pos = (ev) => clientToCanvas(ev.clientX, ev.clientY, canvas.getBoundingClientRect(), S.w, S.h);
  const toGraph = (p) => ({ x: (p.x - S.t.x) / S.t.k, y: (p.y - S.t.y) / S.t.k });

  function setHover(n) {
    if (S.hovered === n) return;
    S.hovered = n;
    if (n) {
      S.emph = new Set([n.id, ...(S.adj.get(n.id) || [])]);
      fadeTarget = 1;
    } else if (S.matches && S.matches.size) { S.emph = S.matches; fadeTarget = 1; }
    else fadeTarget = 0;
    canvas.style.cursor = n ? 'pointer' : '';
    if (opts.onhover) opts.onhover(n ? n.id : null);
    invalidate();
  }

  // ---------- pointer ----------
  function onDown(ev) {
    if (ev.button !== 0) return;
    const p = pos(ev);
    const n = hit(p.x, p.y, ev.pointerType === 'touch');
    tween = null; inertia = null;
    if (!n) { bgPress = { x: p.x, y: p.y, mod: ev.ctrlKey || ev.metaKey || ev.shiftKey }; return; }
    ev.preventDefault();
    try { canvas.setPointerCapture(ev.pointerId); } catch (e) {}
    if (!ego && (ev.ctrlKey || ev.metaKey)) { toggleSelect(n); return; }
    const group = S.selected.has(n.id) ? [...S.selected].map((id) => S.byId.get(id)).filter(Boolean) : [n];
    const g = toGraph(p);
    autoFit = false;
    sim.drag.press(n, p.x, p.y, g.x, g.y, group);
    setHover(n);
  }
  function onMove(ev) {
    const p = pos(ev);
    if (sim.drag.state !== 'idle') {
      const g = toGraph(p);
      if (sim.drag.move(p.x, p.y, g.x, g.y, reduced()) === 'dragging') {
        canvas.style.cursor = 'grabbing';
        qtDirty = true; invalidate();
      }
      return;
    }
    if (ev.buttons) return;                            // background pan in progress
    setHover(hit(p.x, p.y, ev.pointerType === 'touch'));
  }
  function onUp(ev) {
    if (sim.drag.state !== 'idle') {
      const r = sim.drag.release({ shift: ev.shiftKey });
      canvas.style.cursor = S.hovered ? 'pointer' : '';
      if (r && r.type === 'click' && opts.onopen) opts.onopen(r.node.id);
      if (r && r.type === 'drag') mem.dirty = true;
      invalidate();
    } else if (bgPress) {
      const p = pos(ev);
      if (!bgPress.mod && Math.hypot(p.x - bgPress.x, p.y - bgPress.y) < CLICK_PX && S.selected.size) clearSelection();
    }
    bgPress = null;
  }
  function onCancel() { if (sim.drag.cancel()) invalidate(); bgPress = null; }
  function onLeave() { if (sim.drag.state === 'idle') setHover(null); }
  function onDbl(ev) {
    const p = pos(ev), n = hit(p.x, p.y);
    if (n) { ev.preventDefault(); sim.togglePin(n); mem.dirty = true; invalidate(); if (opts.onpin) opts.onpin(n.id, n.pinned); }
  }
  function onBlur() { inertia = null; if (sim.drag.state !== 'idle') { sim.drag.cancel(); invalidate(); } else sim.drag.cancel(); }
  const onContext = (ev) => { const p = pos(ev); if (hit(p.x, p.y)) ev.preventDefault(); };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('dblclick', onDbl);
  canvas.addEventListener('contextmenu', onContext);
  window.addEventListener('blur', onBlur);

  // ---------- selection ----------
  function emitSelect() { if (opts.onselect) opts.onselect([...S.selected]); }
  function toggleSelect(n) { if (S.selected.has(n.id)) S.selected.delete(n.id); else S.selected.add(n.id); emitSelect(); invalidate(); }
  function clearSelection() { if (!S.selected.size) return false; S.selected.clear(); emitSelect(); invalidate(); return true; }

  // ---------- size / theme ----------
  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === S.w && h === S.h && dpr === S.dpr) return;
    const had = S.w && S.h;
    S.w = w; S.h = h; S.dpr = dpr;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    syncZoom();
    if (w && h && fitPending && S.nodes.length) { fitPending = false; setTransform(fitTransform()); if (sim.running && !reduced()) autoFit = true; }
    invalidate();
  }
  // a view-zoom change resizes the canvas: re-seat d3-zoom's zoomed-px transform so the view holds still
  function syncZoom() {
    const z = measureZf();
    if (Math.abs(z - zf) < 1e-4) return;
    zf = z;
    if (zb && !tween && !inertia) zb.transform(zsel, zoomIdentity.translate(S.t.x * zf, S.t.y * zf).scale(S.t.k));
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  // App cross-fades background colours for --dur-base after a theme switch: read now, and again after
  // the fade so the surface colour (canvas fill, label halos) is the settled one
  let themeTimer = 0;
  const mo = new MutationObserver(() => {
    S.theme = readTheme(host); invalidate();
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => { if (!destroyed) { S.theme = readTheme(host); invalidate(); } }, DUR.base + 150);
  });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const onFonts = () => { for (const n of S.nodes) n._lf = null; invalidate(); };
  if (document.fonts) { document.fonts.ready.then(onFonts); document.fonts.addEventListener('loadingdone', onFonts); }

  function saveMemory() {
    for (const n of S.nodes) mem.pos.set(n.id, { x: n.x, y: n.y });
    if (!ego) mem.t = { ...S.t };
    mem.dirty = false;
  }

  // ---------- public API ----------
  const api = {
    // graph from model.buildGraph (already filtered). Positions persist by node id.
    setData(graph, { centerId = S.centerId, refit = false } = {}) {
      const first = !S.nodes.length;
      if (!first) for (const n of S.nodes) mem.pos.set(n.id, { x: n.x, y: n.y });
      const known = graph.nodes.length && graph.nodes.every((n) => mem.pos.has(n.id));
      const res = sim.setData(graph, { positions: mem.pos });
      S.nodes = sim.nodes; S.links = sim.links; S.suggested = sim.suggested;
      S.byId = new Map(S.nodes.map((n) => [n.id, n]));
      S.byDegree = [...S.nodes].sort((a, b) => b.degree - a.degree);
      S.adj = adjacency(S.links);
      S.centerId = centerId;
      for (const id of [...S.selected]) if (!S.byId.has(id)) S.selected.delete(id);
      if (S.focusId && !S.byId.has(S.focusId)) S.focusId = null;
      if (S.hovered && !S.byId.has(S.hovered.id)) setHover(null);
      if (first && known) sim.sim.alpha(0.05);           // restored layout: polish, do not reshuffle
      sim.setReduced(reduced());
      if (res.changed || first) {
        if (reduced()) { sim.warm(400, 600); sim.sim.alpha(0); }   // pre-settled; nothing animates
        else if (first && !known) sim.warm(150, ego ? 60 : 150);
        else if (ego) sim.warm(120, 30);
      }
      qtDirty = true; mem.dirty = true;
      if (first && !ego && known && mem.t) setTransform(mem.t);              // reopen where the user left it
      else if (first || refit || (ego && res.changed)) {
        if (!S.w || !S.h) fitPending = true;   // hidden or zero-height stage: resize() fits later
        else cameraTo(fitTransform(), first || ego || !refit || refit === 'instant' ? 0 : DUR.slow);
        if ((first || ego) && sim.running && !reduced()) autoFit = true;
      }
      invalidate();
      return res;
    },
    setCenter(id) { if (S.centerId !== id) { S.centerId = id; invalidate(); } },
    setShowSuggested(v) { S.showSuggested = !!v; invalidate(); },
    setForces(f) { sim.setForces(f); invalidate(); },
    get forces() { return { ...sim.forces }; },
    setMatches(ids) {
      S.matches = ids && ids.length ? new Set(ids) : null;
      if (!S.hovered) { if (S.matches) { S.emph = S.matches; fadeTarget = 1; } else fadeTarget = 0; }
      invalidate();
    },
    zoomBy(f) { const k = clamp(S.t.k * f, SCALE[0], SCALE[1]), cx = S.w / 2, cy = S.h / 2; cameraTo({ k, x: cx - (cx - S.t.x) * (k / S.t.k), y: cy - (cy - S.t.y) * (k / S.t.k) }, DUR.base); },
    fit(animate = true) { cameraTo(fitTransform(), animate ? DUR.slow : 0); },
    zoomToNode(id, k = Math.max(S.t.k, 1.6)) { const n = S.byId.get(id); if (n) cameraTo({ k, x: S.w / 2 - n.x * k, y: S.h / 2 - n.y * k }, DUR.slow, n); },
    // keep a keyboard-focused node on screen without moving the camera more than needed
    reveal(id) {
      const n = S.byId.get(id); if (!n) return;
      const x = n.x * S.t.k + S.t.x, y = n.y * S.t.k + S.t.y, m = 60;
      if (x < m || y < m || x > S.w - m || y > S.h - m) cameraTo({ k: S.t.k, x: S.w / 2 - n.x * S.t.k, y: S.h / 2 - n.y * S.t.k }, DUR.slow);
    },
    setFocus(id) { S.focusId = id; if (id && !ego) api.reveal(id); invalidate(); },
    neighbourInDirection(id, dx, dy) {
      const n = S.byId.get(id); if (!n) return null;
      const nb = [...(S.adj.get(id) || [])].map((i) => S.byId.get(i)).filter(Boolean);
      const best = nearestInDirection(n, nb, dx, dy) || nearestInDirection(n, S.nodes, dx, dy);
      return best ? best.id : null;
    },
    info(id) { const n = S.byId.get(id); return n ? { id, title: n.title, links: (S.adj.get(id) || new Set()).size, pinned: !!n.pinned } : null; },
    togglePin(id) { const n = S.byId.get(id); if (n) { sim.togglePin(n); mem.dirty = true; invalidate(); return n.pinned; } return false; },
    unpinAll() { const c = sim.unpinAll(); invalidate(); return c; },
    clearSelection,
    get selected() { return [...S.selected]; },
    get nodeCount() { return S.nodes.length; },
    exportPNG() { return new Promise((res) => canvas.toBlob((b) => res(b), 'image/png')); },
    exportSVG() { if (!frame) frame = buildFrame(S); return frameToSVG(S, frame); },
    redraw: invalidate,
    stats,
    probe: opts.probe ? {
      screen: (id) => { const n = S.byId.get(id); return n ? { x: n.x * S.t.k + S.t.x, y: n.y * S.t.k + S.t.y } : null; },
      graph: (id) => { const n = S.byId.get(id); return n ? { x: n.x, y: n.y, pinned: !!n.pinned } : null; },
      neighbours: (id) => [...(S.adj.get(id) || [])],
      hub: () => (S.byDegree[0] || {}).id,
      transform: () => ({ ...S.t }),
      running: () => sim.running,
      zf: () => zf,
      theme: () => ({ bg: S.theme.bg, fgMuted: S.theme.fgMuted, accent: S.theme.accent, edgeA: S.theme.edgeA, labelMinA: S.theme.labelMinA }),
      labels: () => (frame && frame.drawnLabels ? frame.drawnLabels.map((L) => ({ id: L.n.id, text: L.text, x: L.x, y: L.y, w: L.w, h: L.h, alpha: L.alpha })) : []),
      nodes: () => S.nodes.map((n) => n.id),
    } : null,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      sim.drag.cancel(); sim.stop();
      saveMemory();
      ro.disconnect(); mo.disconnect(); clearTimeout(themeTimer);
      if (document.fonts) document.fonts.removeEventListener('loadingdone', onFonts);
      if (zsel) zsel.on('.zoom', null);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('dblclick', onDbl);
      canvas.removeEventListener('contextmenu', onContext);
      window.removeEventListener('blur', onBlur);
    },
  };
  resize();
  return api;
}
