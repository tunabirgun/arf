<script>
  import { hasLinks } from './graphindex.js';
  let { notes, idx, centerId, mode = 'ego', onopen } = $props();
  let host;

  function esc(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function egoModel() {
    const center = idx.byId[centerId]; if (!center) return null;
    const seen = {}, neigh = [];
    (idx.fwd[centerId] || []).forEach((id) => { if (!seen[id]) { seen[id] = 1; neigh.push(id); } });
    (idx.back[centerId] || []).forEach((id) => { if (!seen[id]) { seen[id] = 1; neigh.push(id); } });
    const ids = neigh.slice(0, 9);
    const W = 268, H = Math.max(170, 150 + ids.length * 6), cx = W / 2, cy = H / 2, R = Math.min(cx, cy) - 40;
    const nodes = [{ id: centerId, x: cx, y: cy, center: true }];
    const edges = [];
    ids.forEach((id, k) => {
      const a = -Math.PI / 2 + (2 * Math.PI * k) / Math.max(1, ids.length);
      nodes.push({ id, x: cx + R * Math.cos(a), y: cy + R * Math.sin(a), center: false });
      edges.push({ from: 0, to: nodes.length - 1 });
    });
    return { W, H, nodes, edges };
  }

  function fullModel(W, H) {
    const index = {}; const nodes = notes.map((n, i) => { index[n.id] = i; return { id: n.id, x: 0, y: 0 }; });
    const edges = [], seen = {};
    notes.forEach((n) => (idx.fwd[n.id] || []).forEach((t) => {
      const k = n.id < t ? n.id + t : t + n.id;
      if (!seen[k] && index[t] != null) { seen[k] = 1; edges.push({ from: index[n.id], to: index[t] }); }
    }));
    layoutForce(nodes, edges, W, H, 160);
    return { W, H, nodes, edges, index };
  }

  function layoutForce(nodes, edges, W, H, iters) {
    const n = nodes.length, cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.32;
    nodes.forEach((nd, i) => { const a = (2 * Math.PI * i) / n; nd.x = cx + R * Math.cos(a); nd.y = cy + R * Math.sin(a); });
    for (let it = 0; it < iters; it++) {
      nodes.forEach((nd) => { nd.fx = 0; nd.fy = 0; });
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = nodes[i], b = nodes[j], dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy + 0.01, d = Math.sqrt(d2), rep = 9000 / d2, ux = dx / d, uy = dy / d;
        a.fx += ux * rep; a.fy += uy * rep; b.fx -= ux * rep; b.fy -= uy * rep;
      }
      edges.forEach((e) => { const a = nodes[e.from], b = nodes[e.to], dx = b.x - a.x, dy = b.y - a.y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, sp = (d - 120) * 0.03, ux = dx / d, uy = dy / d; a.fx += ux * sp; a.fy += uy * sp; b.fx -= ux * sp; b.fy -= uy * sp; });
      nodes.forEach((nd) => { nd.fx += (cx - nd.x) * 0.006; nd.fy += (cy - nd.y) * 0.006; nd.x += Math.max(-14, Math.min(14, nd.fx)); nd.y += Math.max(-14, Math.min(14, nd.fy)); nd.x = Math.max(30, Math.min(W - 30, nd.x)); nd.y = Math.max(30, Math.min(H - 30, nd.y)); });
    }
  }

  function nodeSVG(nd, i, r) {
    const orphan = !hasLinks(nd.id, idx);
    const cls = nd.center ? 'eg-center' : 'eg-node' + (orphan ? ' orphan' : '');
    let s = '<g class="eg-node-g' + (nd.center ? ' c' : '') + '" data-i="' + i + '" transform="translate(' + nd.x.toFixed(1) + ',' + nd.y.toFixed(1) + ')">';
    if (nd.center) s += '<circle class="eg-ring" r="' + (r + 5) + '"/>';
    s += '<circle class="' + cls + '" r="' + r + '"><title>' + esc(idx.byId[nd.id].title) + '</title></circle>';
    s += '<text class="eg-label' + (nd.center ? ' c' : '') + '" y="' + (r + 12) + '">' + esc(idx.byId[nd.id].title.slice(0, mode === 'full' ? 24 : 15)) + '</text></g>';
    return s;
  }

  function render() {
    if (!host) return;
    if (mode === 'ego') { renderEgo(); } else { renderFull(); }
  }

  function renderEgo() {
    const M = egoModel();
    if (!M) { host.innerHTML = '<div class="gempty">No note.</div>'; return; }
    let svg = '<svg viewBox="0 0 ' + M.W + ' ' + M.H + '" class="egograph">';
    M.edges.forEach((e) => { const a = M.nodes[e.from], b = M.nodes[e.to]; svg += '<line class="eg-edge" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"/>'; });
    M.nodes.forEach((nd, i) => (svg += nodeSVG(nd, i, nd.center ? 8 : (hasLinks(nd.id, idx) ? 5 : 4))));
    host.innerHTML = svg + '</svg>';
    host.querySelectorAll('[data-i]').forEach((g) => {
      const i = +g.getAttribute('data-i');
      g.addEventListener('click', () => onopen && onopen(M.nodes[i].id));
    });
  }

  function renderFull() {
    const W = host.clientWidth || 900, H = host.clientHeight || 560;
    const M = fullModel(W, H);
    const adjN = {}, adjE = {}; M.nodes.forEach((_, i) => { adjN[i] = []; adjE[i] = []; });
    M.edges.forEach((e, i) => { adjN[e.from].push(e.to); adjN[e.to].push(e.from); adjE[e.from].push(i); adjE[e.to].push(i); });
    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="fullgraph"><g class="vp">';
    M.edges.forEach((e, i) => { const a = M.nodes[e.from], b = M.nodes[e.to]; svg += '<line class="eg-edge" data-e="' + i + '" x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) + '" y2="' + b.y.toFixed(1) + '"/>'; });
    M.nodes.forEach((nd, i) => { nd.center = nd.id === centerId; svg += nodeSVG(nd, i, nd.id === centerId ? 9 : (hasLinks(nd.id, idx) ? 7 : 5)); });
    host.innerHTML = svg + '</g></svg>';
    const svgEl = host.querySelector('svg'), vp = host.querySelector('.vp');
    const nodeEls = [...host.querySelectorAll('[data-i]')], edgeEls = [...host.querySelectorAll('[data-e]')];
    const view = { k: 1, tx: 0, ty: 0 };
    const applyVP = () => vp.setAttribute('transform', 'translate(' + view.tx + ',' + view.ty + ') scale(' + view.k + ')');
    const paint = () => {
      M.nodes.forEach((nd, i) => nodeEls[i].setAttribute('transform', 'translate(' + nd.x.toFixed(1) + ',' + nd.y.toFixed(1) + ')'));
      M.edges.forEach((e, i) => { const a = M.nodes[e.from], b = M.nodes[e.to], L = edgeEls[i]; L.setAttribute('x1', a.x.toFixed(1)); L.setAttribute('y1', a.y.toFixed(1)); L.setAttribute('x2', b.x.toFixed(1)); L.setAttribute('y2', b.y.toFixed(1)); });
    };
    const toGraph = (ev) => { const m = vp.getScreenCTM(); if (!m) return null; const p = svgEl.createSVGPoint(); p.x = ev.clientX; p.y = ev.clientY; return p.matrixTransform(m.inverse()); };
    svgEl.addEventListener('wheel', (ev) => { ev.preventDefault(); const rect = svgEl.getBoundingClientRect(); const sx = (ev.clientX - rect.left) / rect.width * W, sy = (ev.clientY - rect.top) / rect.height * H; const f = ev.deltaY < 0 ? 1.12 : 1 / 1.12; const nk = Math.max(0.4, Math.min(4, view.k * f)); view.tx = sx - (sx - view.tx) * (nk / view.k); view.ty = sy - (sy - view.ty) * (nk / view.k); view.k = nk; applyVP(); }, { passive: false });
    const setHi = (i) => { if (i == null) { svgEl.classList.remove('dim'); nodeEls.forEach((g) => g.classList.remove('hi')); edgeEls.forEach((l) => l.classList.remove('hi')); return; } svgEl.classList.add('dim'); nodeEls.forEach((g, j) => g.classList.toggle('hi', j === i || adjN[i].includes(j))); edgeEls.forEach((l, j) => l.classList.toggle('hi', adjE[i].includes(j))); };
    const sel = {};
    let drag = null, pan = null;
    const endPan = () => { pan = null; svgEl.style.cursor = 'grab'; };
    svgEl.addEventListener('pointerdown', (ev) => { if (ev.button !== 0 || ev.target.closest('[data-i]')) return; pan = { x: ev.clientX, y: ev.clientY, tx: view.tx, ty: view.ty }; svgEl.style.cursor = 'grabbing'; try { svgEl.setPointerCapture(ev.pointerId); } catch (e) {} });
    svgEl.addEventListener('pointermove', (ev) => { if (!pan) return; const rect = svgEl.getBoundingClientRect(); view.tx = pan.tx + (ev.clientX - pan.x) / rect.width * W; view.ty = pan.ty + (ev.clientY - pan.y) / rect.height * H; applyVP(); });
    svgEl.addEventListener('pointerup', endPan);
    svgEl.addEventListener('pointercancel', endPan);
    nodeEls.forEach((g, i) => {
      g.addEventListener('mouseenter', () => { if (!drag && !pan) setHi(i); });
      g.addEventListener('mouseleave', () => { if (!drag) setHi(null); });
      g.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return; ev.stopPropagation();
        if (ev.ctrlKey || ev.metaKey) { // Ctrl/Cmd + left-click toggles selection
          if (sel[i]) { delete sel[i]; g.classList.remove('sel'); } else { sel[i] = 1; g.classList.add('sel'); } return;
        }
        drag = { i, moved: false }; try { g.setPointerCapture(ev.pointerId); } catch (e) {}
      });
      g.addEventListener('pointermove', (ev) => { if (!drag || drag.i !== i) return; const p = toGraph(ev); if (!p) return; drag.moved = true; M.nodes[i].x = p.x; M.nodes[i].y = p.y; paint(); });
      g.addEventListener('pointerup', () => { if (!drag) return; const mv = drag.moved; drag = null; if (!mv && onopen) onopen(M.nodes[i].id); });
      g.addEventListener('pointercancel', () => { drag = null; setHi(null); });
      g.addEventListener('contextmenu', (ev) => ev.preventDefault());
    });
    applyVP();
  }

  $effect(() => { centerId; notes.length; mode; if (host) render(); });
</script>

<div class="ghost" class:full={mode === 'full'} bind:this={host}></div>

<style>
  .ghost { margin-top: .3rem; }
  .ghost.full { flex: 1; height: 100%; margin: 0; }
  .ghost :global(svg.egograph) { width: 100%; height: auto; display: block; }
  .ghost.full :global(svg.fullgraph) { width: 100%; height: 100%; cursor: grab; touch-action: none; }
  .gempty { font-size: 13px; color: var(--fg-faint); font-style: italic; }
</style>
