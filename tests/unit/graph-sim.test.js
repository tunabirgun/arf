import { describe, it, expect } from 'vitest';
import { createSim, createPinStore, PIN_KEY, DRAG_ALPHA, ALPHA_MIN } from '../../src/lib/graph/sim.js';

const memStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m }; };
// star: hub h linked to a..d, plus orphan o
const star = () => ({
  nodes: ['h', 'a', 'b', 'c', 'd', 'o'].map((id) => ({ id, title: id.toUpperCase(), degree: id === 'h' ? 4 : id === 'o' ? 0 : 1, orphan: id === 'o', folder: '', tags: [] })),
  links: ['a', 'b', 'c', 'd'].map((t) => ({ source: 'h', target: t, kind: 'link' })),
});
const settle = (s) => { let n = 0; while (s.running && n < 2000) { s.sim.tick(); n++; } return n; };

describe('simulation lifecycle', () => {
  it('never runs its own timer and stops at alphaMin', () => {
    const s = createSim();
    s.setData(star());
    expect(s.alpha()).toBe(1);
    const n = settle(s);
    expect(n).toBeGreaterThan(50);
    expect(s.running).toBe(false);
    expect(s.alpha()).toBeLessThan(ALPHA_MIN);
  });
  it('fixed step: at most one tick per frame, 60 Hz on fast displays', () => {
    const s = createSim();
    s.setData(star());
    let ticks = 0, t = 1000;
    for (let i = 0; i < 144; i++) { t += 1000 / 144; if (s.step(t)) ticks++; }
    expect(ticks).toBeGreaterThanOrEqual(58);
    expect(ticks).toBeLessThanOrEqual(61);
    let t2 = 5000, ticks2 = 0;
    for (let i = 0; i < 10; i++) { t2 += 50; if (s.step(t2)) ticks2++; }   // slow frames never catch up
    expect(ticks2).toBe(10);
  });
  it('warm start is bounded by ticks and by the clock', () => {
    const s = createSim();
    s.setData(star());
    let now = 0;
    expect(s.warm(1000, 30, () => (now += 1))).toBeLessThanOrEqual(30);
    const s2 = createSim(); s2.setData(star());
    expect(s2.warm(20, 1e9)).toBe(20);
  });
  it('preserves node identity and positions across updates; new nodes appear near a linked neighbour', () => {
    const s = createSim();
    s.setData(star()); settle(s);
    const h = s.node('h'), hx = h.x;
    const g = star();
    g.nodes.push({ id: 'n', title: 'N', degree: 1, orphan: false, folder: '', tags: [] });
    g.links.push({ source: 'd', target: 'n', kind: 'link' });
    const res = s.setData(g);
    expect(res.changed).toBe(true);
    expect(s.node('h')).toBe(h);
    expect(h.x).toBe(hx);
    const d = s.node('d'), n = s.node('n');
    expect(Math.hypot(n.x - d.x, n.y - d.y)).toBeLessThan(60);
    expect(s.alpha()).toBeGreaterThanOrEqual(0.3);
    expect(s.setData(g).changed).toBe(false);
  });
  it('restores saved positions on a fresh mount', () => {
    const s = createSim(); s.setData(star());
    const s2 = createSim(); s2.setData(star(), { positions: new Map([['h', { x: 5, y: 6 }]]) });
    expect([s2.node('h').x, s2.node('h').y]).toEqual([5, 6]);
  });
  it('suggested edges resolve to nodes but do not enter the physics', () => {
    const g = star(); g.links.push({ source: 'a', target: 'o', kind: 'suggested', s: 0.7 });
    const s = createSim(); s.setData(g);
    expect(s.links.length).toBe(4);
    expect(s.suggested[0].source).toBe(s.node('a'));
  });
});

describe('drag and pin state machine', () => {
  const setup = (storage = memStorage()) => {
    const s = createSim({ pins: createPinStore(storage) });
    s.setData(star()); settle(s);
    return { s, storage };
  };
  it('a press that moves less than 5 px is a click and never reheats', () => {
    const { s } = setup();
    const a = s.node('a');
    s.drag.press(a, 100, 100, a.x, a.y);
    expect(s.drag.move(103, 103, a.x + 3, a.y + 3)).toBe('pressed');
    expect(s.sim.alphaTarget()).toBe(0);
    expect(a.fx == null).toBe(true);
    expect(s.drag.release()).toEqual({ type: 'click', node: a });
  });
  it('dragging pins with fx/fy, reheats, divides by zoom via graph deltas, and pulls neighbours', () => {
    const { s } = setup();
    const h = s.node('h'), a = s.node('a'), x0 = h.x, ax0 = a.x;
    s.drag.press(h, 100, 100, x0, h.y);
    expect(s.drag.move(110, 100, x0 + 5, h.y)).toBe('dragging');
    expect(s.sim.alphaTarget()).toBe(DRAG_ALPHA);
    s.drag.move(400, 100, x0 + 150, h.y);
    expect(h.fx).toBeCloseTo(x0 + 150);
    expect(h.x).toBeCloseTo(x0 + 150);
    let t = 0; for (let i = 0; i < 120; i++) s.step((t += 1000 / 60));
    expect(a.x - ax0).toBeGreaterThan(40);      // neighbour followed the pull
    const r = s.drag.release();
    expect(r.type).toBe('drag');
    expect(s.sim.alphaTarget()).toBe(0);
    expect(h.fx).toBe(null);
    expect(h.pinned).toBe(false);
  });
  it('shift-release pins persistently; dragging a pinned node keeps it pinned; shift-release again unpins', () => {
    const { s, storage } = setup();
    const b = s.node('b');
    s.drag.press(b, 0, 0, b.x, b.y); s.drag.move(20, 0, b.x + 20, b.y);
    s.drag.release({ shift: true });
    expect(b.pinned).toBe(true);
    expect(JSON.parse(storage.getItem(PIN_KEY)).b).toEqual([Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10]);
    s.drag.press(b, 0, 0, b.x, b.y); s.drag.move(0, 30, b.x, b.y + 30);
    s.drag.release();
    expect(b.pinned).toBe(true);
    expect(b.fy).toBeCloseTo(b.y);
    s.drag.press(b, 0, 0, b.x, b.y); s.drag.move(0, 30, b.x, b.y + 30);
    s.drag.release({ shift: true });
    expect(b.pinned).toBe(false);
    expect(JSON.parse(storage.getItem(PIN_KEY)).b).toBeUndefined();
  });
  it('pins survive a remount through the store, and unpinAll clears them', () => {
    const storage = memStorage();
    const { s } = setup(storage);
    s.togglePin(s.node('c'));
    const s2 = createSim({ pins: createPinStore(storage) }); s2.setData(star());
    expect(s2.node('c').pinned).toBe(true);
    expect(s2.node('c').fx).toBeCloseTo(s.node('c').x, 0);
    expect(s2.unpinAll()).toBe(1);
    expect(JSON.parse(storage.getItem(PIN_KEY))).toEqual({});
  });
  it('multi-select drag moves the whole group by the same delta', () => {
    const { s } = setup();
    const a = s.node('a'), b = s.node('b'), ax = a.x, bx = b.x;
    s.drag.press(a, 0, 0, a.x, a.y, [a, b]);
    s.drag.move(50, 0, a.x + 25, a.y);
    expect(a.x - ax).toBeCloseTo(25);
    expect(b.x - bx).toBeCloseTo(25);
    s.drag.release();
    expect(a.fx).toBe(null); expect(b.fx).toBe(null);
  });
  it('cancel (blur/unmount) clears alphaTarget and restores prior pins', () => {
    const { s } = setup();
    const a = s.node('a'), d = s.node('d');
    s.pin(d);
    s.drag.press(a, 0, 0, a.x, a.y, [a, d]); s.drag.move(40, 0, a.x + 20, a.y);
    expect(s.sim.alphaTarget()).toBe(DRAG_ALPHA);
    s.drag.cancel();
    expect(s.sim.alphaTarget()).toBe(0);
    expect(a.fx).toBe(null);
    expect(d.pinned).toBe(true);
    expect(s.drag.state).toBe('idle');
    expect(s.drag.cancel()).toBe(null);
  });
  it('reduced motion: drag moves the node directly without reheating', () => {
    const { s } = setup();
    const a = s.node('a');
    s.drag.press(a, 0, 0, a.x, a.y); s.drag.move(40, 0, a.x + 20, a.y, true);
    expect(s.sim.alphaTarget()).toBe(0);
    s.drag.release();
  });
  it('the pin store is bounded and drops the oldest entries first', () => {
    const storage = memStorage();
    const p = createPinStore(storage, PIN_KEY, 3);
    p.set([['1', 0, 0], ['2', 0, 0], ['3', 0, 0]]);
    p.set([['4', 1, 1]]);
    expect(Object.keys(p.all())).toEqual(['2', '3', '4']);
    storage.setItem(PIN_KEY, 'not json');
    expect(p.all()).toEqual({});
  });
});
