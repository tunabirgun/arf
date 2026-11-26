// Canvas 2D drawing for the graph view: theme colours resolved from CSS custom properties, viewport
// culling, edges batched per style, nodes batched per fill, rings drawn as shapes (pinned, selected,
// current, keyboard focus) and screen-space LOD labels. The same frame description exports to SVG.
import { nodeRadius } from './sim.js';
import { selectLabels } from './model.js';

const TOKENS = { canvas: '--canvas', fg: '--fg', fgBright: '--fg-bright', fgMuted: '--fg-muted', fgFaint: '--fg-faint', line: '--line', lineStrong: '--line-strong', accent: '--accent' };
const FALLBACK = { canvas: '#f6f1e6', fg: '#2a2622', fgBright: '#12100c', fgMuted: '#5b544c', fgFaint: '#7a736a', line: '#e5ded1', lineStrong: '#d3cabb', accent: '#2c4a6e' };

// Resolve each token to rgb() through a probe element: tokens may be color-mix() expressions that a
// canvas cannot parse everywhere. The probe opts out of the app's theme cross-fade transition.
export function readTheme(host) {
  const probe = document.createElement('span');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;transition:none !important;';
  host.appendChild(probe);
  const th = {};
  for (const [k, v] of Object.entries(TOKENS)) {
    probe.style.color = FALLBACK[k];
    probe.style.color = 'var(' + v + ', ' + FALLBACK[k] + ')';
    th[k] = getComputedStyle(probe).color || FALLBACK[k];
  }
  // the surface the graph sits on (the rail is --surface-0, the overlay --canvas): first opaque ancestor
  th.bg = th.canvas;
  for (let el = host; el && el.nodeType === 1; el = el.parentElement) {
    const b = getComputedStyle(el).backgroundColor;
    if (b && b !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(b)) { th.bg = b; break; }
  }
  // contrast-derived alphas (WCAG 2.2): links are graphical objects (1.4.11, 3:1), labels are text
  // (1.4.3, 4.5:1). Each is the least alpha of --fg-muted over the resolved surface that clears the
  // target with a margin for 8-bit compositing and line antialiasing.
  const muted = rgbOf(th.fgMuted), bg = rgbOf(th.bg);
  th.edgeA = minAlpha(muted, bg, EDGE_CR);
  th.labelMinA = minAlpha(muted, bg, LABEL_CR);
  const cs = getComputedStyle(host);
  th.serif = cs.getPropertyValue('--serif').trim() || 'Georgia, serif';
  th.sans = cs.getPropertyValue('--sans').trim() || 'system-ui, sans-serif';
  probe.remove();
  return th;
}

const DIM_NODE = 0.15, DIM_EDGE = 0.1;
export const EDGE_CR = 3 * 1.1, LABEL_CR = 4.5 * 1.05;   // WCAG minimums plus 10 % / 5 % margin

// ---- colour maths (WCAG 2.2 relative luminance and contrast ratio) ----
let parseCtx = null;
// any CSS colour (rgb(), color(srgb ...), hex) -> [r, g, b] 0-255, via a 1x1 canvas
export function rgbOf(css) {
  if (!parseCtx) { const c = document.createElement('canvas'); c.width = c.height = 1; parseCtx = c.getContext('2d', { willReadFrequently: true }); }
  parseCtx.clearRect(0, 0, 1, 1); parseCtx.fillStyle = '#000'; parseCtx.fillStyle = css; parseCtx.fillRect(0, 0, 1, 1);
  const d = parseCtx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}
export function luminance([r, g, b]) {
  const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
export const over = (fg, bg, a) => fg.map((v, i) => v * a + bg[i] * (1 - a));
// least alpha (to 0.01) at which fg composited over bg reaches the target ratio against bg; 1 if unreachable
export function minAlpha(fg, bg, target) {
  let lo = 0, hi = 1;
  if (contrast(fg, bg) < target) return 1;
  while (hi - lo > 0.005) { const m = (lo + hi) / 2; if (contrast(over(fg, bg, m), bg) >= target) hi = m; else lo = m; }
  return Math.ceil(hi * 100) / 100;
}
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// Builds the frame description (what is visible, how each item is styled) from engine state.
// S: { w, h, t:{k,x,y}, theme, nodes, links, suggested, byDegree, adj, showSuggested, centerId,
//      hovered, emph:Set|null, fade, selected:Set, focusId, matches:Set|null, interacting, ego, labelPx }
export function buildFrame(S) {
  const { w, h, t } = S, k = t.k;
  const pad = 40 / k;
  const x0 = -t.x / k - pad, x1 = (w - t.x) / k + pad, y0 = -t.y / k - pad, y1 = (h - t.y) / k + pad;
  const inView = (n) => n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1;
  const f = S.fade, emph = f > 0 ? S.emph : null;
  const hid = S.hovered ? S.hovered.id : null;
  const edges = { normal: [], dim: [], hi: [], sug: [], sugDim: [] };
  for (const l of S.links) {
    const a = l.source, b = l.target;
    if ((a.x < x0 && b.x < x0) || (a.x > x1 && b.x > x1) || (a.y < y0 && b.y < y0) || (a.y > y1 && b.y > y1)) continue;
    if (!emph) edges.normal.push(l);
    else if (hid && (a.id === hid || b.id === hid)) edges.hi.push(l);
    else if (emph.has(a.id) && emph.has(b.id)) edges.normal.push(l);
    else edges.dim.push(l);
  }
  if (S.showSuggested) for (const l of S.suggested) {
    const a = l.source, b = l.target;
    if ((a.x < x0 && b.x < x0) || (a.x > x1 && b.x > x1) || (a.y < y0 && b.y < y0) || (a.y > y1 && b.y > y1)) continue;
    (emph && !(emph.has(a.id) && emph.has(b.id)) && !(hid && (a.id === hid || b.id === hid)) ? edges.sugDim : edges.sug).push(l);
  }
  const nodes = [];
  for (const n of S.nodes) if (inView(n)) nodes.push(n);
  // labels: hovered, selection, focus, current note, hovered neighbours, search hits; then by degree
  const forced = [];
  if (S.hovered) forced.push(S.hovered);
  const node = (id) => S.byId.get(id);
  for (const id of S.selected) forced.push(node(id));
  if (S.focusId) forced.push(node(S.focusId));
  if (S.centerId) forced.push(node(S.centerId));
  if (S.hovered && S.adj.get(S.hovered.id)) {
    const nb = [...S.adj.get(S.hovered.id)].map(node).filter(Boolean).sort((a, b) => b.degree - a.degree);
    forced.push(...nb);
  }
  if (S.matches && S.matches.size) { let i = 0; for (const id of S.matches) { if (i++ >= 60) break; forced.push(node(id)); } }
  const sx = (n) => n.x * k + t.x, sy = (n) => n.y * k + t.y;
  const visible = (n) => { const X = sx(n), Y = sy(n); return X > -20 && X < w + 20 && Y > -20 && Y < h + 20; };
  const labels = selectLabels(S.byDegree, {
    k: S.ego ? Math.max(k, 3) : k, forced, cap: S.interacting ? 280 : 600, visible,
  });
  return { k, edges, nodes, labels, emph, f, sx, sy };
}

function nodeStyle(S, n, th) {
  if (n.id === S.centerId || (S.hovered && n.id === S.hovered.id)) return { fill: th.fgBright };
  if (S.matches && S.matches.has(n.id)) return { fill: th.fg };
  if (n.orphan) return { fill: th.bg, stroke: th.fgFaint };
  return { fill: th.fgMuted };
}

export function drawScene(ctx, S, F) {
  const { w, h, t, dpr, theme: th } = S, k = t.k;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.fillStyle = th.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * t.x, dpr * t.y);
  ctx.lineCap = 'round';
  const dimN = 1 - (1 - DIM_NODE) * F.f, dimE = 1 - (1 - DIM_EDGE) * F.f;
  const stroke = (list, color, width, alpha, dash) => {
    if (!list.length || alpha <= 0) return;
    ctx.beginPath();
    for (const l of list) { ctx.moveTo(l.source.x, l.source.y); ctx.lineTo(l.target.x, l.target.y); }
    ctx.strokeStyle = color; ctx.lineWidth = width / k; ctx.globalAlpha = alpha;
    ctx.setLineDash(dash ? dash.map((d) => d / k) : []);
    ctx.stroke();
  };
  const thin = k < 0.4 ? 0.7 : 1;
  const edgeA = th.edgeA || 0.7;
  stroke(F.edges.dim, th.fgMuted, thin, edgeA * dimE);
  stroke(F.edges.normal, th.fgMuted, thin, edgeA);
  stroke(F.edges.sugDim, th.accent, 1.1, 0.55 * dimE, [4, 4]);
  stroke(F.edges.sug, th.accent, 1.1, 0.7, [4, 4]);
  stroke(F.edges.hi, th.accent, 1.8, 1);
  ctx.setLineDash([]);

  // nodes batched by (fill, stroke, dimmed)
  const minR = 2.5 / k;
  const rOf = (n) => Math.max(nodeRadius(n.degree), minR);
  const buckets = new Map();
  for (const n of F.nodes) {
    const st = nodeStyle(S, n, th);
    const dim = F.emph && !F.emph.has(n.id);
    const key = st.fill + '|' + (st.stroke || '') + '|' + (dim ? 1 : 0);
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { st, dim, list: [] }));
    b.list.push(n);
  }
  for (const { st, dim, list } of buckets.values()) {
    ctx.beginPath();
    for (const n of list) { const r = rOf(n); ctx.moveTo(n.x + r, n.y); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); }
    ctx.globalAlpha = dim ? dimN : 1;
    ctx.fillStyle = st.fill; ctx.fill();
    if (st.stroke) { ctx.strokeStyle = st.stroke; ctx.lineWidth = 1.2 / k; ctx.stroke(); }
  }
  // rings: shape encodes state (pinned thin ring, selected heavy ring, current note double ring, focus dashed)
  const ring = (n, gap, width, color, dash) => {
    const r = rOf(n) + gap / k;
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.setLineDash(dash ? dash.map((d) => d / k) : []);
    ctx.strokeStyle = color; ctx.lineWidth = width / k; ctx.stroke();
  };
  for (const n of F.nodes) {
    const dim = F.emph && !F.emph.has(n.id);
    ctx.globalAlpha = dim ? dimN : 1;
    if (n.pinned) ring(n, 2.2, 1, th.fgMuted);
    if (n.id === S.centerId) ring(n, 3.4, 1, th.fgBright);
    if (S.selected.has(n.id)) ring(n, n.pinned ? 4.6 : 3, 2, th.fgBright);
  }
  if (S.focusId) {
    const n = S.byId.get(S.focusId);
    if (n) { ctx.globalAlpha = 1; ring(n, 7, 3.5, th.bg); ring(n, 7, 1.8, th.fgBright, [3, 2.5]); }
  }
  ctx.setLineDash([]);
  drawLabels(ctx, S, F);
  ctx.globalAlpha = 1;
}

function drawLabels(ctx, S, F) {
  const { dpr, theme: th, w } = S;
  const px = S.labelPx || 12;
  const font = px + 'px ' + th.serif;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.lineJoin = 'round'; ctx.lineWidth = 3; ctx.strokeStyle = th.bg;
  const grid = new Map(), CW = 96, CH = px + 4;
  const hitsGrid = (x0, y0, x1, y1) => {
    for (let gx = Math.floor(x0 / CW); gx <= Math.floor(x1 / CW); gx++) for (let gy = Math.floor(y0 / CH); gy <= Math.floor(y1 / CH); gy++) {
      const cell = grid.get(gx + ',' + gy); if (!cell) continue;
      for (const r of cell) if (r[0] < x1 && r[2] > x0 && r[1] < y1 && r[3] > y0) return true;
    }
    return false;
  };
  const occupy = (r) => {
    for (let gx = Math.floor(r[0] / CW); gx <= Math.floor(r[2] / CW); gx++) for (let gy = Math.floor(r[1] / CH); gy <= Math.floor(r[3] / CH); gy++) {
      const key = gx + ',' + gy; let cell = grid.get(key); if (!cell) grid.set(key, (cell = [])); cell.push(r);
    }
  };
  const drawn = [];
  const forcedIds = new Set();
  if (S.hovered) forcedIds.add(S.hovered.id);
  if (S.focusId) forcedIds.add(S.focusId);
  for (const id of S.selected) forcedIds.add(id);
  if (S.centerId) forcedIds.add(S.centerId);
  const maxChars = S.ego ? 22 : 32;
  const minA = th.labelMinA || 0;
  for (const [n, a] of F.labels) {
    const strong = forcedIds.has(n.id);
    const dim = F.emph && !F.emph.has(n.id);
    const alpha = a * (dim ? 1 - (1 - DIM_NODE) * F.f : 1);
    if (alpha < minA || alpha <= 0.02) continue;   // a label too faint to read (LOD or hover dim) is not drawn
    const text = strong && S.hovered && n.id === S.hovered.id ? truncate(n.title, 80) : truncate(n.title, maxChars);
    if (n._lf !== font || n._lt !== text) { n._lf = font; n._lt = text; n._lw = ctx.measureText(text).width; }
    const x = F.sx(n), r = Math.max(nodeRadius(n.degree) * F.k, 2.5);
    let place = null;
    if (!S.ego) {
      const rect = [x - n._lw / 2 - 2, F.sy(n) + r + 3, x + n._lw / 2 + 2, F.sy(n) + r + 3 + px + 2];
      if (!strong && hitsGrid(rect[0], rect[1], rect[2], rect[3])) continue;
      place = { text, rect };
    } else {
      // rail: every note gets a label. Try the slots around the node, then shorter text, before overlapping.
      const texts = [text, truncate(n.title, 14), truncate(n.title, 10)].filter((t, i, l) => l.indexOf(t) === i);
      for (const tx of texts) {
        const tw = tx === text ? n._lw : ctx.measureText(tx).width;
        for (const rect of labelSlots(x, F.sy(n), r, tw, px, w, S.h)) {
          if (!hitsGrid(rect[0], rect[1], rect[2], rect[3])) { place = { text: tx, rect }; break; }
        }
        if (place) break;
      }
      if (!place) { const tx = texts[texts.length - 1]; place = { text: tx, rect: labelSlots(x, F.sy(n), r, ctx.measureText(tx).width, px, w, S.h)[0] }; }
    }
    const rect = place.rect;
    occupy(rect);
    const lx = (rect[0] + rect[2]) / 2, y = rect[1];
    ctx.globalAlpha = alpha;
    ctx.strokeText(place.text, lx, y);
    ctx.fillStyle = strong || (F.emph && F.emph.has(n.id) && F.f > 0) ? th.fgBright : th.fgMuted;
    ctx.fillText(place.text, lx, y);
    drawn.push({ n, text: place.text, x: lx, y, w: rect[2] - rect[0], h: rect[3] - rect[1], alpha, strong });
  }
  F.drawnLabels = drawn;
}

// Candidate label rectangles [x0, y0, x1, y1] around a node at screen (x, y) with screen radius r, in
// preference order: below, above, a second row below/above, then beside it. Each is kept inside w x h.
export function labelSlots(x, y, r, tw, px, w, h) {
  const half = tw / 2 + 2, lh = px + 2;
  const box = (cx, top) => {
    const c = Math.max(half, Math.min(w - half, cx)), t = Math.max(0, Math.min(h - lh, top));
    return [c - half, t, c + half, t + lh];
  };
  const below = y + r + 3, above = y - r - 3 - lh, mid = y - lh / 2;
  return [box(x, below), box(x, above), box(x, below + lh), box(x, above - lh),
    box(x + r + 4 + half, mid), box(x - r - 4 - half, mid)];
}

// quadtree hit radius: max(node radius, 10 CSS px; 22 px for touch) in graph units
export function hitRadius(n, k, touch) { return Math.max(nodeRadius(n ? n.degree : 0) * k, touch ? 22 : 10) / k; }

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (v) => Math.round(v * 10) / 10;

// SVG of the current view: same culling, styles and labels as the last drawn frame
export function frameToSVG(S, F) {
  const { w, h, t, theme: th } = S, k = t.k;
  const dimN = f1(1 - (1 - DIM_NODE) * F.f), dimE = f1(1 - (1 - DIM_EDGE) * F.f);
  const out = ['<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">',
    '<rect width="100%" height="100%" fill="' + th.bg + '"/>',
    '<g transform="translate(' + f1(t.x) + ' ' + f1(t.y) + ') scale(' + k.toFixed(4) + ')" stroke-linecap="round">'];
  const path = (list, color, width, alpha, dash) => {
    if (!list.length) return;
    const d = list.map((l) => 'M' + f1(l.source.x) + ' ' + f1(l.source.y) + 'L' + f1(l.target.x) + ' ' + f1(l.target.y)).join('');
    out.push('<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="' + f1(width / k * 100) / 100 + '" opacity="' + alpha + '"' + (dash ? ' stroke-dasharray="' + dash.map((x) => f1(x / k)).join(' ') + '"' : '') + '/>');
  };
  const thin = k < 0.4 ? 0.7 : 1;
  const edgeA = th.edgeA || 0.7;
  path(F.edges.dim, th.fgMuted, thin, f1(edgeA * dimE * 100) / 100);
  path(F.edges.normal, th.fgMuted, thin, edgeA);
  path(F.edges.sugDim, th.accent, 1.1, f1(0.55 * dimE), [4, 4]);
  path(F.edges.sug, th.accent, 1.1, 0.7, [4, 4]);
  path(F.edges.hi, th.accent, 1.8, 1);
  const minR = 2.5 / k;
  for (const n of F.nodes) {
    const st = nodeStyle(S, n, th), r = f1(Math.max(nodeRadius(n.degree), minR) * 10) / 10;
    const dim = F.emph && !F.emph.has(n.id);
    out.push('<circle cx="' + f1(n.x) + '" cy="' + f1(n.y) + '" r="' + r + '" fill="' + st.fill + '"' + (st.stroke ? ' stroke="' + st.stroke + '" stroke-width="' + f1(1.2 / k * 100) / 100 + '"' : '') + (dim ? ' opacity="' + dimN + '"' : '') + '/>');
    if (n.pinned) out.push('<circle cx="' + f1(n.x) + '" cy="' + f1(n.y) + '" r="' + f1(r + 2.2 / k) + '" fill="none" stroke="' + th.fgMuted + '" stroke-width="' + f1(1 / k * 100) / 100 + '"/>');
  }
  out.push('</g><g font-family="' + xmlEsc(th.serif) + '" font-size="' + (S.labelPx || 12) + '" text-anchor="middle" dominant-baseline="hanging">');
  for (const L of F.drawnLabels || []) {
    out.push('<text x="' + f1(L.x) + '" y="' + f1(L.y) + '" fill="' + (L.strong ? th.fgBright : th.fgMuted) + '"' + (L.alpha < 1 ? ' opacity="' + f1(L.alpha * 100) / 100 + '"' : '') + ' stroke="' + th.bg + '" stroke-width="3" paint-order="stroke" stroke-linejoin="round">' + xmlEsc(L.text) + '</text>');
  }
  out.push('</g></svg>');
  return out.join('');
}
