import { test, expect } from '@playwright/test';

// Keyboard paths and overlay behaviour from the design pass: palette selection, leaving Write with Ctrl+E,
// the context menu, folder rows, Library row selection, the Library export dialog, and exit fades under
// reduced motion. The vault is planted through the legacy cache key (one-shot), so titles are exact.
const T = '2026-01-01T00:00:00.000Z';
const mk = (id, title, folder = '', body = 'Plain text.') => ({ id, title, folder, tags: [], created: T, updated: T, body });
const NOTES = [
  mk('K1', 'Alpha lattice'), mk('K2', 'Beta lattice'), mk('K3', 'Gamma lattice'),
  mk('K4', 'Delta note', 'Lab'), mk('K5', 'Epsilon note', 'Lab'),
];
const REFS = [0, 1, 2].map((i) => ({ id: 'R' + i, type: 'article-journal', citekey: 'kb' + i, title: 'Keyboard reference ' + i, authors: [{ f: 'Example', g: 'A.' }], year: '2020', sources: ['Crossref'] }));

async function plant(page, { refs = REFS } = {}) {
  await page.addInitScript(({ notes, refs }) => {
    if (sessionStorage.getItem('planted')) return; sessionStorage.setItem('planted', '1');
    localStorage.setItem('arf-vault-v0', JSON.stringify(notes)); localStorage.setItem('arf-refs-v0', JSON.stringify(refs));
    localStorage.setItem('arf-seedfolders-cleaned', '1');
  }, { notes: NOTES, refs });
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Alpha lattice', { exact: true })).toBeVisible();
}
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const title = (page) => page.locator('h1.title');

test('palette: arrows move the active row and Enter opens it', async ({ page }) => {
  await plant(page);
  await page.keyboard.press(mod + '+k');
  const input = page.getByRole('combobox', { name: /Search notes/ });
  await input.fill('lattice');
  const rows = page.locator('.presults [role="option"]');
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  const third = (await rows.nth(2).locator('.pt').textContent()).trim();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-activedescendant', 'pal-opt-2');
  await expect(rows.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(title(page)).toContainText(third);
});

test('write mode: Ctrl+E inside the editor returns to the read view', async ({ page }) => {
  await plant(page);
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press(mod + '+e');
  await expect(page.locator('.cm-content')).toHaveCount(0);
  await expect(page.locator('.read')).toBeVisible();
});

test('context menu: keyboard opens it, arrows move, Enter runs, Escape returns focus', async ({ page }) => {
  await plant(page);
  const row = page.locator('aside.list button.item', { hasText: 'Beta lattice' });
  await row.focus();
  await page.keyboard.press('Shift+F10');
  const items = page.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(2)).toBeFocused();   // Open, Open & edit, Open in reader
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctxmenu')).toHaveCount(0);
  await expect(row).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('End');
  await expect(items.last()).toHaveText('Delete');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');   // Open
  await expect(title(page)).toContainText('Beta lattice');
});

test('folder rows: ArrowLeft collapses, ArrowRight expands', async ({ page }) => {
  await plant(page);
  const lab = page.locator('aside.list .frow[data-folder="Lab"]');
  await expect(lab).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('aside.list').getByText('Delta note', { exact: true })).toBeVisible();
  await lab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(lab).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('aside.list').getByText('Delta note', { exact: true })).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(lab).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('aside.list').getByText('Delta note', { exact: true })).toBeVisible();
});

test('library: Space selects a row for export, the export dialog closes on Escape', async ({ page }) => {
  await plant(page);
  await page.keyboard.press(mod + '+b');
  const second = page.locator('.libcol.refs .refrow').nth(1);
  await second.focus();
  await page.keyboard.press('Space');
  await expect(second).toHaveAttribute('aria-pressed', 'true');
  await expect(second).not.toHaveClass(/\bon\b/);     // Space selects; it does not open the detail
  await page.keyboard.press('Enter');
  await expect(second).toHaveClass(/\bon\b/);
  const exp = page.getByRole('button', { name: '⇩ Export library' });
  await exp.focus();
  await page.keyboard.press('Enter');
  const dlg = page.getByRole('dialog', { name: 'Export references' });
  await expect(dlg).toBeVisible();
  await expect(page.locator('.libview')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(dlg).toHaveCount(0);
  await expect(exp).toBeFocused();
  await expect(page.locator('.libview')).not.toHaveAttribute('inert', '');
});

test('library: with no references the detail explains how to add one and export is off', async ({ page }) => {
  await plant(page, { refs: [] });
  await page.keyboard.press(mod + '+b');
  await expect(page.locator('.libcol.detail')).toContainText('Add a reference by DOI');
  await expect(page.getByRole('button', { name: '⇩ Export library' })).toBeDisabled();
});

test.describe('reduced motion', () => {
  test('overlays close without opacity or transform animation', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await plant(page);
    const moving = () => page.evaluate(() => document.getAnimations().filter((a) => a.animationName || !a.transitionProperty).map((a) => (a.effect?.target?.className || '?') + ':' + (a.animationName || 'js') + ':' + a.effect?.getTiming().duration + ':' + a.playState));
    await page.keyboard.press(mod + '+k');
    await expect(page.locator('.palette')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await moving()).toEqual([]);
    await expect(page.locator('.palette')).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator('.modal.settings')).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await moving()).toEqual([]);
    await expect(page.locator('.modal.settings')).toHaveCount(0);
  });
});

// Tab wraps inside an open dialog: going round from its first focusable, focus never lands on <body> or behind
// the dialog, and comes back to the first one (both directions). The graph overlay ends in hidden note buttons.
for (const [name, open, sel] of [['graph overlay', mod + '+g', '.gv.full'], ['Settings', null, '.modal.settings']]) {
  test(`Tab wraps inside the ${name}`, async ({ page }) => {
    await plant(page);
    if (open) await page.keyboard.press(open);
    else await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.locator(sel).first()).toBeVisible();
    const n = await page.locator(sel).first().evaluate((d) => {
      const root = d.closest('.overlay, .modal, .palette');
      root.setAttribute('data-dlg', '');
      const list = [...root.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter((el) => el.tabIndex >= 0 && !el.disabled && el.getClientRects().length > 0);
      list[0].setAttribute('data-first', ''); list[0].focus();
      return list.length;
    });
    for (const key of ['Tab', 'Shift+Tab']) {
      let back = false;
      for (let i = 0; i < n + 2; i++) {
        await page.keyboard.press(key);
        const where = await page.evaluate(() => { const a = document.activeElement; return { inside: !!(a && a.closest('[data-dlg]')), first: !!(a && a.hasAttribute('data-first')) }; });
        expect(where.inside, key + ' step ' + i).toBe(true);
        if (where.first) { back = true; break; }
      }
      expect(back, key + ' wraps back to the first control').toBe(true);
    }
  });
}
