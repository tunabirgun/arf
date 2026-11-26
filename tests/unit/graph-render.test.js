import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { clientToCanvas } from '../../src/lib/graph/model.js';
import { buildFrame, drawScene, labelSlots, contrast, over, minAlpha, EDGE_CR, LABEL_CR } from '../../src/lib/graph/render.js';

describe('clientToCanvas', () => {
  it('maps zoomed client px to canvas drawing units per axis', () => {
    // 108 % root zoom: a 948 x 700 canvas renders as 1023.84 x 756
    const rect = { left: 10, top: 20, width: 948 * 1.08, height: 700 * 1.08 };
    const p = clientToCanvas(10 + 474 * 1.08, 20 + 350 * 1.08, rect, 948, 700);
    expect(p.x).toBeCloseTo(474, 6);
    expect(p.y).toBeCloseTo(350, 6);
  });
  it('is the plain offset at 100 % and while the canvas has no size', () => {
    expect(clientToCanvas(110, 70, { left: 10, top: 20, width: 300, height: 200 }, 300, 200)).toEqual({ x: 100, y: 50 });
    expect(clientToCanvas(110, 70, { left: 10, top: 20, width: 0, height: 0 }, 0, 0)).toEqual({ x: 100, y: 50 });
  });
});

// theme tokens straight from app.css, so a token change that breaks contrast fails here
const css = readFileSync(new URL('../../src/app.css', import.meta.url), 'utf8');
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function tokens(selector) {
  const block = css.slice(css.indexOf(selector + ' {')).match(/\{([^}]*)\}/)[1];
  const get = (name) => hex(block.match(new RegExp('--' + name + ':\\s*(#[0-9a-f]{6})', 'i'))[1]);
  return { canvas: get('canvas'), surface: get('surface'), muted: get('fg-muted') };
}
const THEMES = { light: tokens(':root'), dark: tokens('html[data-theme="dark"]') };
const q8 = (c) => c.map((v) => Math.round(v));   // what an 8-bit canvas stores

describe('graph contrast (WCAG 1.4.11 links, 1.4.3 labels)', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    // the overlay sits on --canvas, the rail on --surface-0 = color-mix(canvas 55 %, surface)
    const surfaces = { canvas: t.canvas, 'surface-0': over(t.canvas, t.surface, 0.55) };
    for (const [sname, bg] of Object.entries(surfaces)) {
      it(`${name} on ${sname}: links >= 3:1 and the faintest drawn label >= 4.5:1`, () => {
        const ea = minAlpha(t.muted, bg, EDGE_CR), la = minAlpha(t.muted, bg, LABEL_CR);
        expect(contrast(q8(over(t.muted, q8(bg), ea)), q8(bg))).toBeGreaterThanOrEqual(3);
        expect(contrast(q8(over(t.muted, q8(bg), la)), q8(bg))).toBeGreaterThanOrEqual(4.5);
        expect(ea).toBeLessThan(1);   // a link still reads quieter than a node
      });
    }
  }
  it('minAlpha is the least sufficient alpha', () => {
    const fg = [0, 0, 0], bg = [255, 255, 255];
    const a = minAlpha(fg, bg, 3);
    expect(contrast(over(fg, bg, a), bg)).toBeGreaterThanOrEqual(3);
    expect(contrast(over(fg, bg, a - 0.02), bg)).toBeLessThan(3);
    expect(minAlpha([200, 200, 200], bg, 4.5)).toBe(1);   // unreachable: full ink
  });
});

describe('labelSlots', () => {
  it('stays inside the canvas and prefers below, then above', () => {
    const s = labelSlots(5, 5, 4, 80, 11, 290, 220);
    for (const r of s) { expect(r[0]).toBeGreaterThanOrEqual(0); expect(r[2]).toBeLessThanOrEqual(290); expect(r[1]).toBeGreaterThanOrEqual(0); expect(r[3]).toBeLessThanOrEqual(220); }
    const mid = labelSlots(145, 110, 4, 60, 11, 290, 220);
    expect(mid[0][1]).toBeGreaterThan(110);
    expect(mid[1][3]).toBeLessThan(110);
  });
});

// a 2D context stand-in: records nothing, measures text at 6 px per character
function fakeCtx() {
  const target = { measureText: (t) => ({ width: t.length * 6 }) };
  return new Proxy(target, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
}

describe('full graph label floor', () => {
  it('draws no label fainter than the contrast floor; level-of-detail labels below it are skipped', () => {
    // zoomed out (k 0.5): hubs score a = 1, mid-degree nodes fall inside the fade window, leaves score 0
    const degrees = [40, 30, 12, 8, 6, 5, 4, 3, 2, 1, 1, 0];
    const nodes = degrees.map((degree, i) => ({ id: 'n' + i, title: 'Note ' + i, degree, x: (i % 4) * 300 - 450, y: Math.floor(i / 4) * 200 - 200 }));
    const S = {
      w: 800, h: 600, dpr: 1, t: { k: 0.5, x: 400, y: 300 }, ego: false, labelPx: 12,
      theme: { bg: '#fff', fgMuted: '#555', fgBright: '#111', fgFaint: '#777', fg: '#222', accent: '#246', serif: 'serif', edgeA: 0.7, labelMinA: 0.86 },
      nodes, links: [], suggested: [], byDegree: [...nodes].sort((a, b) => b.degree - a.degree), byId: new Map(nodes.map((n) => [n.id, n])), adj: new Map(),
      showSuggested: false, centerId: null, hovered: null, emph: null, fade: 0, selected: new Set(), focusId: null, matches: null, interacting: false,
    };
    const F = buildFrame(S);
    const faded = F.labels.filter(([, a]) => a < S.theme.labelMinA).map(([n]) => n.id);
    expect(faded.length).toBeGreaterThan(0);   // the fixture does exercise the fade window
    drawScene(fakeCtx(), S, F);
    expect(F.drawnLabels.length).toBeGreaterThan(0);
    for (const L of F.drawnLabels) expect(L.alpha).toBeGreaterThanOrEqual(S.theme.labelMinA);
    for (const id of faded) expect(F.drawnLabels.some((L) => L.n.id === id)).toBe(false);
  });
});

describe('ego graph labels', () => {
  it('labels every neighbour of the centre note in a crowded rail', () => {
    const titles = ['Kinase assay protocol', 'Beta methods', 'Membrane entropy notes', 'Gradient descent review', 'Alpha review note',
      'Signal transduction', 'Reading list 2026', 'Lab meeting minutes', 'Western blot tips', 'Grant draft aims', 'Cell culture log'];
    const W = 290, H = 220;
    const nodes = titles.map((title, i) => {
      const a = (i - 1) / 10 * Math.PI * 2;
      return i === 0 ? { id: 'c', title, degree: 10, x: 0, y: 0 } : { id: 'n' + i, title, degree: 1, x: Math.cos(a) * 70, y: Math.sin(a) * 55 };
    });
    const links = nodes.slice(1).map((n) => ({ source: nodes[0], target: n }));
    const adj = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const l of links) { adj.get(l.source.id).add(l.target.id); adj.get(l.target.id).add(l.source.id); }
    const S = {
      w: W, h: H, dpr: 1, t: { k: 1, x: W / 2, y: H / 2 }, ego: true, labelPx: 11,
      theme: { bg: '#fff', fgMuted: '#555', fgBright: '#111', fgFaint: '#777', fg: '#222', accent: '#246', serif: 'serif', edgeA: 0.7, labelMinA: 0.85 },
      nodes, links, suggested: [], byDegree: [...nodes].sort((a, b) => b.degree - a.degree), byId: new Map(nodes.map((n) => [n.id, n])), adj,
      showSuggested: false, centerId: 'c', hovered: null, emph: null, fade: 0, selected: new Set(), focusId: null, matches: null, interacting: false,
    };
    const F = buildFrame(S);
    drawScene(fakeCtx(), S, F);
    const ids = new Set(F.drawnLabels.map((L) => L.n.id));
    expect([...ids].sort()).toEqual(nodes.map((n) => n.id).sort());
    let overlaps = 0;
    const L = F.drawnLabels;
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
      const a = L[i], b = L[j];
      if (a.x - a.w / 2 < b.x + b.w / 2 && b.x - b.w / 2 < a.x + a.w / 2 && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
    expect(overlaps).toBe(0);
    // the layout is crowded enough that some labels had to leave the default slot (below, full length)
    const moved = L.filter((x) => x.text !== x.n.title.slice(0, 22) && x.n.title.length <= 22 || x.y < F.sy(x.n)).length;
    expect(moved).toBeGreaterThan(0);
  });
});
