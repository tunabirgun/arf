import { test, expect } from '@playwright/test';

// The note cache moved from one whole-vault localStorage value (capped near 5 MB) to IndexedDB with
// per-note writes. These flows cover the migration of an existing localStorage vault, a vault larger
// than the old cap, and edits surviving a reload, including one inside the 400 ms save debounce.

const LEGACY_KEY = 'arf-vault-v0';
const T0 = '2026-01-01T00:00:00.000Z';
const idbCount = (page) => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('arf-cache');
  r.onsuccess = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('notes')) { db.close(); res(-1); return; }
    const q = db.transaction('notes', 'readonly').objectStore('notes').count();
    q.onsuccess = () => { db.close(); res(q.result); };
    q.onerror = () => { db.close(); res(-1); };
  };
  r.onerror = () => res(-1);
}));
// the sidebar header "Vault · N" (textContent: innerText would follow the CSS text-transform)
const vaultCount = async (page) => {
  const m = /Vault · (\d+)/.exec(await page.locator('aside.list .lh').first().textContent());
  if (!m) throw new Error('no vault count in the sidebar header');
  return +m[1];
};

test('a legacy localStorage vault migrates to IndexedDB on first boot and persists across reload', async ({ page }) => {
  const legacy = Array.from({ length: 5 }, (_, i) => ({ id: 'LEGACY' + i, title: 'Legacy note ' + i, folder: '', tags: [], created: T0, updated: T0, body: 'legacy body ' + i }));
  // one-shot: addInitScript runs again on reload, which must not put the legacy key back
  await page.addInitScript(({ key, data }) => {
    if (sessionStorage.getItem('legacy-planted')) return;
    sessionStorage.setItem('legacy-planted', '1');
    localStorage.setItem(key, JSON.stringify(data));
  }, { key: LEGACY_KEY, data: legacy });
  await page.goto('/');
  const list = page.locator('aside.list');
  await expect(list.getByText(legacy[0].title, { exact: true })).toBeVisible();
  await expect(page.locator('h1.title')).toContainText(legacy[0].title);   // the legacy order (first note selected) is kept
  expect(await vaultCount(page)).toBe(legacy.length);                      // no welcome notes seeded over the cache
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBeNull();
  await expect.poll(() => idbCount(page)).toBe(legacy.length);

  await page.reload();
  await expect(list.getByText(legacy[legacy.length - 1].title, { exact: true })).toBeVisible();
  await expect(page.locator('h1.title')).toContainText(legacy[0].title);
  expect(await vaultCount(page)).toBe(legacy.length);
  await expect(list.getByText('Welcome to Arf')).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), LEGACY_KEY)).toBeNull();
});

test('a 2000-note vault imported via .arf persists without the save-error banner', async ({ page }) => {
  test.setTimeout(120_000);
  const N = 2000;
  // ~3 kB per note: about 6 MB of notes, above the ~5 MB localStorage cap that broke 2.0.0
  const para = 'Entropy production in open systems couples to transport coefficients and boundary fluxes. ';
  const notes = Array.from({ length: N }, (_, i) => ({ id: 'IMP' + String(i).padStart(5, '0'), title: 'Imported note ' + i, folder: 'Bulk', tags: [], created: T0, updated: T0, body: ('Note ' + i + '. ' + para).repeat(30) }));
  const bundle = { arf: 1, app: 'Arf', version: '2.0.0', exported: T0, notes, folders: ['Bulk'], refs: [], libFolders: [], readerHls: {} };
  expect(JSON.stringify(notes).length).toBeGreaterThan(5.3e6);

  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  const before = await vaultCount(page);
  const banner = page.locator('.savebanner', { hasText: 'Couldn’t save' });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles({ name: 'big.arf', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
  await expect(page.getByText('Imported ' + N + ' notes')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect.poll(() => vaultCount(page)).toBe(before + N);
  await expect.poll(() => idbCount(page), { timeout: 30_000 }).toBe(before + N);
  await expect(banner).toHaveCount(0);

  // an edit in the large vault saves cleanly (2.0.0 showed the banner on every save from here on)
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' edited after import');
  await expect(page.locator('.crumbs .saved')).toHaveText('saved');
  await expect(banner).toHaveCount(0);

  await page.reload();
  await expect.poll(() => vaultCount(page)).toBe(before + N);
  await expect(page.locator('.read')).toContainText('edited after import');
  await expect(banner).toHaveCount(0);
});

test('reload keeps edits, including a reload inside the save debounce', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();

  // settled edit: a new note, saved
  await page.locator('button.newbtn').click();
  await page.fill('input.title', 'Settled note');
  await page.locator('.cm-content').click();
  await page.keyboard.type('settled body text');
  await expect(page.locator('.crumbs .saved')).toHaveText('saved');

  // immediate edit: a second note, reloaded straight after the last keystroke (no debounce wait)
  await page.locator('button.newbtn').click();
  await page.fill('input.title', 'Quick reload note');
  await page.locator('.cm-content').click();
  await page.keyboard.type('typed then reloaded at once');
  await page.reload();

  const list = page.locator('aside.list');
  await expect(list.getByText('Quick reload note', { exact: true })).toBeVisible();
  await expect(list.getByText('Settled note', { exact: true })).toBeVisible();
  await expect(page.locator('h1.title')).toContainText('Quick reload note');   // newest note still first
  await expect(page.locator('.read')).toContainText('typed then reloaded at once');
  await list.getByText('Settled note', { exact: true }).click();
  await expect(page.locator('.read')).toContainText('settled body text');

  // and a second reload, once the journal has been committed into IndexedDB
  await page.reload();
  await expect(page.locator('h1.title')).toContainText('Quick reload note');
  await expect(page.locator('.read')).toContainText('typed then reloaded at once');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('arf-cache-journal'))).toBeNull();
});

test('web build: a failed cache write shows the save banner, and the next good write clears it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  const banner = page.locator('.savebanner', { hasText: 'Couldn’t save' });
  // no vault folder in the web build, so a failed cache write leaves the edit persisted nowhere
  await page.evaluate(() => { window.__put = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function () { throw new DOMException('simulated', 'QuotaExceededError'); }; });
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' while the cache fails');
  await expect(banner).toBeVisible();
  await page.evaluate(() => { IDBObjectStore.prototype.put = window.__put; });
  await page.keyboard.type(' and after');
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.read')).toContainText('while the cache fails and after');
});

test('a cache that cannot be read is never seeded over', async ({ page }) => {
  await page.addInitScript(() => { IDBObjectStore.prototype.getAll = function () { throw new DOMException('simulated', 'UnknownError'); }; });
  await page.goto('/');
  await expect(page.locator('aside.list')).toBeVisible();
  await page.waitForTimeout(1000);   // seeding, if it wrongly happened, follows the async vault check
  expect(await vaultCount(page)).toBe(0);
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toHaveCount(0);
});
