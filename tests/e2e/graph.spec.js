import { test, expect } from '@playwright/test';

// the layout settles on a fixed 60 Hz step, so under parallel-worker CPU load it needs more wall time
test.describe.configure({ timeout: 120_000 });

// Canvas knowledge graph: rail (ego) view, full overlay toolbar, keyboard list, empty-state copy.
// Pixel checks read the canvas back, since nodes are not DOM elements.
const inked = (sel) => (page) => page.locator(sel).evaluate((c) => {
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  const r0 = d[0], g0 = d[1], b0 = d[2];
  let n = 0;
  for (let i = 0; i < d.length; i += 16) if (Math.abs(d[i] - r0) + Math.abs(d[i + 1] - g0) + Math.abs(d[i + 2] - b0) > 60) n++;
  return n;
});

test('graph: rail and full view render, search, keyboard and Escape', async ({ page }) => {
  await page.goto('/');
  const list = page.locator('aside.list');
  await expect(list.getByText('Welcome to Arf')).toBeVisible();
  await list.getByText('Welcome to Arf').first().click();

  // rail: canvas with ink and a screen-reader list of the local notes
  const rail = page.locator('.gv.ego');
  await expect(rail.locator('canvas')).toBeVisible();
  await expect.poll(() => rail.locator('.gsr button').count()).toBeGreaterThan(0);
  await expect.poll(() => inked('.gv.ego canvas')(page)).toBeGreaterThan(10);

  // full view
  await page.locator('button.tbtn', { hasText: 'Graph' }).click();
  const full = page.locator('.gv.full');
  await expect(full.locator('canvas')).toBeVisible();
  await expect(full.getByRole('toolbar', { name: 'Graph controls' })).toBeVisible();
  await expect.poll(() => inked('.gv.full canvas')(page)).toBeGreaterThan(10);

  // search highlights and reports matches
  const search = full.getByRole('searchbox', { name: 'Find a note in the graph' });
  await search.fill('welcome');
  await expect(full.locator('.gcount')).toHaveText(/^[1-9]\d*$/);
  await search.press('Enter');
  await search.fill('');

  // forces disclosure
  await full.getByRole('button', { name: 'Forces' }).click();
  await expect(full.getByRole('group', { name: 'Forces' })).toBeVisible();

  // keyboard: the hidden list is focusable, arrows move, live region announces
  const first = full.locator('.gsr button[tabindex="0"]');
  await first.focus();
  await expect(full.locator('div.gsr[aria-live]')).toHaveText(/, \d+ links?/);

  // Escape with nothing selected falls through to App and closes the overlay
  await page.keyboard.press('Escape');   // clears the keyboard focus marker
  await page.keyboard.press('Escape');
  await expect(full).toHaveCount(0);
});

test('graph: canvas follows the theme after App’s cross-fade', async ({ page }) => {
  // the rail graph stays mounted while the top-bar Theme control flips data-theme with a colour fade
  await page.goto('/');
  const list = page.locator('aside.list');
  await expect(list.getByText('Welcome to Arf')).toBeVisible();
  await list.getByText('Welcome to Arf').first().click();
  const rail = page.locator('.gv.ego');
  await expect(rail.locator('canvas')).toBeVisible();
  const corner = () => rail.locator('canvas').evaluate((c) => Array.from(c.getContext('2d').getImageData(1, 1, 1, 1).data).slice(0, 3).join(','));
  // computed colour may be color(srgb …) after color-mix(): resolve it through a 1 px canvas
  const railBg = () => rail.evaluate((el) => {
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const x = c.getContext('2d'); x.fillStyle = getComputedStyle(el.closest('.rail')).backgroundColor; x.fillRect(0, 0, 1, 1);
    return Array.from(x.getImageData(0, 0, 1, 1).data).slice(0, 3).join(',');
  });
  await expect.poll(corner).toBe(await railBg());
  const before = await corner();
  await page.locator('button.tbtn', { hasText: 'Theme' }).click();
  await page.waitForTimeout(600);
  expect(await corner()).toBe(await railBg());
  expect(await corner()).not.toBe(before);
});

test('graph: Resonance pairs reach both graphs as suggested links', async ({ page }) => {
  // two unlinked notes sharing distinctive terms, and one unrelated, so word overlap finds one pair
  const T = '2026-01-01T00:00:00.000Z';
  const mk = (id, title, body) => ({ id, title, folder: '', tags: [], created: T, updated: T, body });
  const ns = [
    mk('SGA', 'Calorimetry A', 'Adiabatic calorimetry measures enthalpy of combustion; bomb calorimetry enthalpy entropy.'),
    mk('SGB', 'Calorimetry B', 'Bomb calorimetry and adiabatic enthalpy measurements of combustion entropy.'),
    mk('SGC', 'Gardening', 'Tomatoes need sunlight, compost and regular watering in summer.'),
  ];
  await page.addInitScript((list) => {
    if (sessionStorage.getItem('planted')) return; sessionStorage.setItem('planted', '1');
    localStorage.setItem('arf-vault-v0', JSON.stringify(list));
  }, ns);
  await page.goto('/');
  await page.locator('aside.list').getByText('Calorimetry A', { exact: true }).click();
  await expect(page.locator('.rail .mlrow .ref')).toContainText(['Calorimetry B']);
  await page.locator('button.tbtn', { hasText: 'Graph' }).click();
  await expect(page.locator('.ovhead .ghint')).toHaveCount(0);
  const sug = page.locator('.gv.full label.gchk', { hasText: 'Suggested links' });
  await expect(sug).toBeVisible();
  await expect(sug).not.toHaveClass(/\boff\b/);
});

// ---------- pointer, labels, contrast, hint, focus (review loop 2) ----------
// A hub note linked to ten spokes, two spokes linked to each other, and one note alone in a folder.
const T0 = '2026-01-01T00:00:00.000Z';
const mkNote = (id, title, body, folder = '') => ({ id, title, folder, tags: [], created: T0, updated: T0, body });
const SPOKES = ['Kinase assay protocol', 'Beta methods', 'Membrane entropy notes', 'Gradient descent review', 'Signal transduction',
  'Reading list 2026', 'Lab meeting minutes', 'Western blot tips', 'Grant draft aims', 'Cell culture log'];
const VAULT = [
  mkNote('HUB', 'Hub note', SPOKES.map((t) => '[[' + t + ']]').join(' ')),
  ...SPOKES.map((t, i) => mkNote('S' + i, t, i === 0 ? 'See [[Beta methods]].' : 'Spoke ' + i + '.')),
  mkNote('SOLO', 'Solo note', 'Alone in its folder.', 'Solo'),
];
// plant the vault and the view zoom; GraphView hands each engine to window.__arfGraphProbe
async function setup(page, zoom) {
  await page.addInitScript(({ list, zoom }) => {
    window.__arfGraphProbe = (e, mode) => { (window.__graphs ||= {})[mode] = e; };
    if (sessionStorage.getItem('planted')) return; sessionStorage.setItem('planted', '1');
    localStorage.setItem('arf-vault-v0', JSON.stringify(list));
    localStorage.setItem('arf-zoom', String(zoom));
  }, { list: VAULT, zoom });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => document.documentElement.style.zoom)).toBe(String(zoom / 100));
  await page.locator('aside.list').getByText('Hub note', { exact: true }).click();
}
const settled = (page, mode) => expect.poll(() => page.evaluate((m) => {
  const g = window.__graphs && window.__graphs[m];
  return !!g && g.nodeCount > 0 && !g.probe.running();
}, mode), { timeout: 60_000 }).toBe(true);   // fixed-step physics settles slower when parallel workers share the CPU
// canvas geometry, the measured zoom factor, and each node's viewport position
const geometry = (page, mode) => page.evaluate((m) => {
  const g = window.__graphs[m], c = document.querySelector(m === 'full' ? '.gv.full canvas' : '.gv.ego canvas');
  const r = c.getBoundingClientRect(), zx = r.width / c.clientWidth, zy = r.height / c.clientHeight;
  const nodes = g.probe.nodes().map((id) => { const s = g.probe.screen(id); return { id, title: g.info(id).title, x: r.x + s.x * zx, y: r.y + s.y * zy }; });
  return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, zx, zy, nodes };
}, mode);
const cursor = (page, sel) => page.locator(sel).evaluate((c) => c.style.cursor);
// a node clear of its neighbours and of the canvas edge, as far from the canvas origin as possible
function pickNode(geo, exclude = []) {
  const ok = geo.nodes.filter((n) => !exclude.includes(n.id)
    && n.x > geo.rect.x + 40 && n.x < geo.rect.x + geo.rect.w - 120 && n.y > geo.rect.y + 40 && n.y < geo.rect.y + geo.rect.h - 120
    && geo.nodes.every((o) => o === n || Math.hypot(o.x - n.x, o.y - n.y) > 30 * geo.zx));
  ok.sort((a, b) => (b.x - geo.rect.x) + (b.y - geo.rect.y) - (a.x - geo.rect.x) - (a.y - geo.rect.y));
  return ok[0];
}
const transform = (page) => page.evaluate(() => window.__graphs.full.probe.transform());

test.describe('graph pointer at view zoom', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  for (const zoom of [100, 108, 140]) {
    test(`hover, drag, pan, wheel anchor and click at ${zoom}%`, async ({ page }) => {
      await setup(page, zoom);
      await page.locator('button.tbtn', { hasText: 'Graph' }).click();
      const sel = '.gv.full canvas';
      await settled(page, 'full');
      let geo = await geometry(page, 'full');
      expect(geo.zx).toBeCloseTo(zoom / 100, 2);
      const n = pickNode(geo, ['HUB']);
      expect(n, 'a node clear of its neighbours').toBeTruthy();

      // hover: the drawn node takes the pointer cursor
      await page.mouse.move(n.x + 40 * geo.zx, n.y + 40 * geo.zy);
      await page.mouse.move(n.x, n.y, { steps: 4 });
      await expect.poll(() => cursor(page, sel)).toBe('pointer');

      // drag: the node follows the cursor within 3 px while held
      await page.mouse.down();
      const end = { x: n.x + 70, y: n.y + 45 };
      for (let i = 1; i <= 10; i++) await page.mouse.move(n.x + (end.x - n.x) * i / 10, n.y + (end.y - n.y) * i / 10);
      await expect.poll(() => cursor(page, sel)).toBe('grabbing');
      const held = (await geometry(page, 'full')).nodes.find((m) => m.id === n.id);
      expect(Math.hypot(held.x - end.x, held.y - end.y)).toBeLessThanOrEqual(3);
      await page.mouse.up();
      await settled(page, 'full');

      // pan from empty canvas: the view tracks the pointer 1:1 in screen px
      geo = await geometry(page, 'full');
      const corner = { x: geo.rect.x + 12, y: geo.rect.y + geo.rect.h - 12 };
      await page.mouse.move(corner.x, corner.y);
      await expect.poll(() => cursor(page, sel)).toBe('');
      const t0 = await transform(page);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++) await page.mouse.move(corner.x + 10 * i, corner.y - 5 * i);
      const t1 = await transform(page);
      expect(Math.abs((t1.x - t0.x) * geo.zx - 80)).toBeLessThanOrEqual(3);
      expect(Math.abs((t1.y - t0.y) * geo.zy + 40)).toBeLessThanOrEqual(3);
      await page.waitForTimeout(120);   // a pause before release: no inertial throw
      await page.mouse.up();

      // wheel: the graph point under the cursor stays under it
      geo = await geometry(page, 'full');
      const P = { x: geo.rect.x + geo.rect.w * 0.7, y: geo.rect.y + geo.rect.h * 0.65 };
      await page.mouse.move(P.x, P.y);
      const before = await transform(page);
      const g = { x: ((P.x - geo.rect.x) / geo.zx - before.x) / before.k, y: ((P.y - geo.rect.y) / geo.zy - before.y) / before.k };
      await page.mouse.wheel(0, -120);
      await expect.poll(async () => (await transform(page)).k).toBeGreaterThan(before.k * 1.2);
      const after = await transform(page);
      expect(Math.abs(geo.rect.x + (g.x * after.k + after.x) * geo.zx - P.x)).toBeLessThanOrEqual(3);
      expect(Math.abs(geo.rect.y + (g.y * after.k + after.y) * geo.zy - P.y)).toBeLessThanOrEqual(3);

      // click: the note opens and the overlay closes
      await settled(page, 'full');
      geo = await geometry(page, 'full');
      const target = pickNode(geo, ['HUB']) || geo.nodes.find((m) => m.id !== 'HUB');
      await page.mouse.move(target.x, target.y, { steps: 3 });
      await expect.poll(() => cursor(page, sel)).toBe('pointer');
      await page.mouse.down(); await page.mouse.up();
      await expect(page.locator('.gv.full')).toHaveCount(0);
      await expect(page.locator('.titlebar .title').first()).toContainText(target.title);
    });
  }

  test('rail graph: every node hits at 108% and every neighbour is labelled', async ({ page }) => {
    await setup(page, 108);
    await settled(page, 'ego');
    const geo = await geometry(page, 'ego');
    expect(geo.nodes.length).toBe(SPOKES.length + 1);
    for (const n of geo.nodes) {
      await page.mouse.move(5, 5);
      await page.mouse.move(n.x, n.y, { steps: 2 });
      await expect.poll(() => cursor(page, '.gv.ego canvas'), { message: n.title }).toBe('pointer');
    }
    await page.mouse.move(5, 5);
    await expect.poll(() => page.evaluate(() => window.__graphs.ego.probe.labels().length)).toBe(geo.nodes.length);
    const labels = await page.evaluate(() => window.__graphs.ego.probe.labels());
    let overlaps = 0;
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = labels[i], b = labels[j];
      if (a.x - a.w / 2 < b.x + b.w / 2 && b.x - b.w / 2 < a.x + a.w / 2 && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
    expect(overlaps).toBe(0);
  });
});

test.describe('graph touch at view zoom', () => {
  test.use({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  test('a tap on a drawn node opens it at 108%', async ({ page }) => {
    await setup(page, 108);
    await page.locator('button.tbtn', { hasText: 'Graph' }).click();
    await settled(page, 'full');
    const geo = await geometry(page, 'full');
    const n = pickNode(geo, ['HUB']);
    expect(n, 'a node clear of its neighbours').toBeTruthy();
    await page.touchscreen.tap(n.x, n.y);
    await expect(page.locator('.gv.full')).toHaveCount(0);
    await expect(page.locator('.titlebar .title').first()).toContainText(n.title);
  });
});

test('graph: links reach 3:1 and drawn labels 4.5:1 in both themes', async ({ page }) => {
  await setup(page, 100);
  const ratios = {};
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') { await page.locator('button.tbtn', { hasText: 'Theme' }).click(); await page.waitForTimeout(600); }
    await page.locator('button.tbtn', { hasText: 'Graph' }).click();
    await settled(page, 'full');
    for (const mode of ['full', 'ego']) {
      ratios[theme + ':' + mode] = await page.evaluate((m) => {
        const g = window.__graphs[m], th = g.probe.theme();
        const cv = document.createElement('canvas'); cv.width = cv.height = 1; const x = cv.getContext('2d', { willReadFrequently: true });
        // composite through a real canvas, as the graph draws it
        const px = (fill, a = 1) => { x.globalAlpha = 1; x.fillStyle = th.bg; x.fillRect(0, 0, 1, 1); x.globalAlpha = a; x.fillStyle = fill; x.fillRect(0, 0, 1, 1); return [...x.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const L = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
        const R = (a, b) => { const p = L(a), q = L(b); return Math.round((Math.max(p, q) + 0.05) / (Math.min(p, q) + 0.05) * 100) / 100; };
        const bg = px(th.bg, 0);
        const drawn = g.probe.labels();
        const faintest = drawn.length ? Math.min(...drawn.map((l) => l.alpha)) : 1;
        return { edgeA: th.edgeA, edge: R(px(th.fgMuted, th.edgeA), bg), labelMinA: th.labelMinA, faintestLabel: R(px(th.fgMuted, faintest), bg),
          suggested: R(px(th.accent, 0.7), bg), highlighted: R(px(th.accent, 1), bg) };
      }, mode);
    }
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
    await expect(page.locator('.gv.full')).toHaveCount(0);
  }
  console.log('graph contrast', JSON.stringify(ratios));
  for (const r of Object.values(ratios)) { expect(r.edge).toBeGreaterThanOrEqual(3); expect(r.faintestLabel).toBeGreaterThanOrEqual(4.5); }
});

test('graph: hint sits below the canvas, leaves after the first interaction, and fits reduced motion', async ({ page }) => {
  await setup(page, 108);
  await page.locator('button.tbtn', { hasText: 'Graph' }).click();
  const help = page.locator('.gv.full .ghelp');
  await expect(help).toContainText('Drag a note to pull its links');
  const [h, c] = await Promise.all([help.boundingBox(), page.locator('.gv.full canvas').boundingBox()]);
  expect(h.y).toBeGreaterThanOrEqual(c.y + c.height - 1);
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.wheel(0, -60);
  await expect(help).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(page.locator('.gv.full')).toHaveCount(0);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('button.tbtn', { hasText: 'Graph' }).click();
  await expect(help).toContainText('Drag a note to move it');
  await expect(help).not.toContainText('pull its links');
});

test('graph: counter pluralises and Tab past the last node wraps inside the overlay', async ({ page }) => {
  await setup(page, 100);
  await page.locator('button.tbtn', { hasText: 'Graph' }).click();
  const full = page.locator('.gv.full');
  await expect(full.locator('.gstat')).toHaveText(`${VAULT.length} notes · ${SPOKES.length + 1} links`);
  await full.getByRole('combobox', { name: 'Filter by folder' }).selectOption('Solo');
  await expect(full.locator('.gstat')).toHaveText('1 note · 0 links');
  await full.getByRole('combobox', { name: 'Filter by folder' }).selectOption('');
  const last = full.locator('.gsr button[tabindex="0"]');
  await expect(last).toHaveCount(1);
  await last.focus();
  await page.keyboard.press('Tab');
  const active = await page.evaluate(() => ({ tag: document.activeElement.tagName, cls: String(document.activeElement.className), inOverlay: !!document.activeElement.closest('.overlay') }));
  expect(active.tag).not.toBe('BODY');
  expect(active.inOverlay).toBe(true);
  expect(active.cls).toContain('ovclose');
});
