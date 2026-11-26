import { test, expect } from '@playwright/test';
import { previewText, linkContext } from '../../src/lib/linkcontext.js';

// Link preview (hover a [[wikilink]] or a rail entry) and backlink context in "Referenced in".
const T0 = '2026-01-01T00:00:00.000Z';
const ALPHA = { id: 'PVA', title: 'Alpha', folder: '', tags: [], created: T0, updated: '2026-01-03T00:00:00.000Z', body: 'Intro line. We study [[Beta]] in depth here. Also [[Gamma]] later.' };
const DELTA = { id: 'PVD', title: 'Delta', folder: '', tags: [], created: T0, updated: T0, body: 'Delta also looks at entropy and order, entropy in every order of body.' };
const BETA = { id: 'PVB', title: 'Beta', folder: '', tags: [], created: T0, updated: '2026-01-02T00:00:00.000Z', body: 'Beta body about **entropy** and order.\n\n![figure](x.png)\n\nSee [[Alpha]].' };

test.beforeEach(async ({ page }) => {
  // planted through the legacy cache key (one-shot), like lazy.spec, so the bodies are exact
  await page.addInitScript((ns) => {
    if (sessionStorage.getItem('planted')) return; sessionStorage.setItem('planted', '1');
    localStorage.setItem('arf-vault-v0', JSON.stringify(ns));
  }, [ALPHA, BETA, DELTA]);
  await page.goto('/');
  await expect(page.locator('h1.title')).toContainText('Alpha');
});

test('hovering a wikilink shows a preview card that opens the note', async ({ page }) => {
  const card = page.locator('.lpv');
  const link = page.locator('.read a.wl', { hasText: 'Beta' });
  await link.hover();
  await expect(card).toBeVisible();
  await expect(card.locator('.lpv-t')).toHaveText('Beta');
  await expect(card.locator('.lpv-x')).toHaveText(previewText(BETA.body));
  await expect(card.locator('.lpv-m')).toHaveText('Links to 1 note, linked from 1.');
  await expect(card).toHaveAttribute('role', 'tooltip');
  await expect(link).toHaveAttribute('aria-describedby', 'arf-lpv');

  // the pointer can cross onto the card; clicking it opens the note
  const box = await card.boundingBox();
  await page.mouse.move(box.x + 20, box.y + 12, { steps: 4 });
  await expect(card).toBeVisible();
  await card.click();
  await expect(page.locator('h1.title')).toContainText('Beta');
  await expect(card).toHaveCount(0);
});

test('a dangling link previews as not created; Escape and leaving dismiss', async ({ page }) => {
  const card = page.locator('.lpv');
  await page.locator('.read a.wl.dangling', { hasText: 'Gamma' }).hover();
  await expect(card.locator('.lpv-x')).toHaveText('Not created yet; open the link to create it');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);

  await page.locator('.read a.wl', { hasText: 'Beta' }).hover();
  await expect(card).toBeVisible();
  await page.mouse.move(5, 5);
  await expect(card).toHaveCount(0);

  // clicking a dangling preview creates the note
  await page.locator('.read a.wl.dangling', { hasText: 'Gamma' }).hover();
  await card.click();
  await expect(page.locator('input.title')).toHaveValue('Gamma');
});

test('backlinks show the linking sentence, and rail entries preview too', async ({ page }) => {
  await page.locator('aside.list').getByText('Beta', { exact: true }).click();
  await expect(page.locator('h1.title')).toContainText('Beta');
  const ctx = linkContext(ALPHA.body, 'Beta');
  const bl = page.locator('.rail .bl');
  await expect(bl).toHaveCount(1);
  await expect(bl.locator('.ref')).toHaveText('Alpha');
  await expect(bl.locator('.bctx')).toHaveText(ctx.before + ctx.match + ctx.after);
  await expect(bl.locator('.bctx strong')).toHaveText('Beta');

  // a backlink already shows its context, so it gets no card
  await bl.locator('.ref').hover();
  await page.waitForTimeout(600);
  await expect(page.locator('.lpv')).toHaveCount(0);

  // a Resonance row does, placed left of the rail so it never covers the rail
  const row = page.locator('.rail .ref.ml', { hasText: 'Delta' });
  await row.hover();
  const card = page.locator('.lpv');
  await expect(card.locator('.lpv-t')).toHaveText('Delta');
  const [cb, rb] = [await card.boundingBox(), await page.locator('.rail').boundingBox()];
  expect(cb.x + cb.width).toBeLessThanOrEqual(rb.x + 1);
});

test('keyboard focus on a link shows the card without moving focus', async ({ page }) => {
  const link = page.locator('.read a.wl', { hasText: 'Beta' });
  await link.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');   // keyboard-driven focus, so :focus-visible matches
  await expect(link).toBeFocused();
  await expect(page.locator('.lpv .lpv-t')).toHaveText('Beta');
  await expect(link).toBeFocused();
  await page.keyboard.press('Tab');   // focus leaves the link: the card goes
  await expect(page.locator('.lpv')).toHaveCount(0);
});

test('the card never shows over an overlay', async ({ page }) => {
  await page.locator('.read a.wl', { hasText: 'Beta' }).hover();
  await expect(page.locator('.lpv')).toBeVisible();
  await page.keyboard.press('Control+g');
  await expect(page.locator('.gv.full')).toBeVisible();
  await expect(page.locator('.lpv')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.gv.full')).toHaveCount(0);
});

// Enter on a keyboard-focused link, Ctrl+E and Ctrl+N tear the link down while its card is pending or shown; the
// focusout that follows must not write Svelte state during the teardown (state_unsafe_mutation)
for (const [label, key, after] of [['Enter', 'Enter', 'h1.title'], ['Ctrl+E', 'Control+e', '.cm-editor'], ['Ctrl+N', 'Control+n', '.cm-editor']]) {
  for (const wait of [100, 600]) {
    test(`no page error when ${label} tears down a focused link (${wait} ms)`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const link = page.locator('.read a.wl', { hasText: 'Beta' });
      await link.focus();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');   // keyboard focus, so :focus-visible matches and the card schedules
      await expect(link).toBeFocused();
      await page.waitForTimeout(wait);    // 100: card pending; 600: card shown
      await page.keyboard.press(key);
      await expect(page.locator(after).first()).toBeVisible();
      await page.waitForTimeout(200);
      expect(errors).toEqual([]);
      await expect(page.locator('.lpv')).toHaveCount(0);
    });
  }
}
