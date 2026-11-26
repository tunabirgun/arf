import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// the registry's recommended entry, read from models.js itself (its JSON import needs a bundler, so the calibration
// file is inlined before loading the module); the Recommended badge must follow it, not a hardcoded name
const LIB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib');
const modelsSrc = readFileSync(join(LIB, 'models.js'), 'utf8').replace(/^import calibrationFile from '\.\/model-thresholds\.json';$/m,
  () => 'const calibrationFile = ' + readFileSync(join(LIB, 'model-thresholds.json'), 'utf8') + ';');
const { RECOMMENDED_ID } = await import('data:text/javascript,' + encodeURIComponent(modelsSrc));

// Settings → Connection suggestions on a fresh profile. Hermetic: any Hugging Face or jsDelivr request fails the
// test, because opening Settings must not touch the network (the model list reads only the local cache).
test('a fresh profile lists both Arf models with Download buttons and no model active', async ({ page }) => {
  const external = [];
  await page.context().route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net/, (r) => { external.push(r.request().url()); r.abort(); });
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();

  // the rail says which method is active: word overlap until a model is in use
  await expect(page.locator('.rail .rh', { hasText: 'Resonance' })).toContainText('word overlap');
  await expect(page.locator('.rail .ref.ml .sim')).toHaveCount(0);   // TF-IDF scores stay in the title only

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dlg = page.getByRole('dialog');
  await expect(dlg.getByText('Connection suggestions', { exact: true })).toBeVisible();

  // suggestions are off by default
  const sw = dlg.getByRole('group', { name: 'Connection suggestions' });
  await expect(sw.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
  await expect(sw.getByRole('button', { name: 'On' })).toHaveAttribute('aria-pressed', 'false');

  for (const name of ['ArfLLM', 'ArfLLM_Multi']) {
    const row = dlg.locator(`li.mrow[data-model="tunabirgun/${name}"]`);
    await expect(row.locator('.mname')).toContainText(name);
    await expect(row.getByRole('button', { name: 'Download ' + name, exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Use ' + name, exact: true })).toBeEnabled();
    await expect(row.getByRole('button', { name: 'Remove ' + name, exact: true })).toBeDisabled();
    await expect(row.locator('.mstate')).toHaveText('Not downloaded');
    await expect(row).toContainText(/\d+(\.\d)? MB/);   // published sizes come from the registry (HF API bytes)
  }
  // the badge follows the registry's recommended entry (models.js RECOMMENDED_ID), and only that one
  await expect(dlg.locator(`li.mrow[data-model="${RECOMMENDED_ID}"] .mrec`)).toHaveText('Recommended');
  await expect(dlg.locator('.mrec')).toHaveCount(1);

  // no model is in use, and every icon button has an accessible name and a tooltip
  await expect(dlg.getByText('In use', { exact: true })).toHaveCount(0);
  const btns = dlg.locator('.mbtn');
  expect(await btns.count()).toBeGreaterThanOrEqual(12);
  for (const b of await btns.all()) {
    expect(await b.getAttribute('aria-label')).toBeTruthy();
    expect(await b.getAttribute('title')).toBeTruthy();
  }
  await expect(dlg.getByRole('textbox', { name: 'Hugging Face repo id' })).toBeVisible();

  // keyboard: Tab reaches the first Download button, focus ring visible
  const first = dlg.getByRole('button', { name: 'Download ArfLLM', exact: true });
  await sw.getByRole('button', { name: 'On' }).focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  expect(await first.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');

  expect(external).toEqual([]);
});

test('an upgraded install keeps its English model and its stored key migrates', async ({ page }) => {
  await page.context().route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net/, (r) => r.abort());
  await page.addInitScript(() => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('arf-mlmodel', 'en'); localStorage.setItem('arf-ml', '0'); sessionStorage.setItem('seeded', '1'); } });
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('arf-mlmodel'))).toBe('Xenova/all-MiniLM-L6-v2');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const row = page.locator('li.mrow[data-model="Xenova/all-MiniLM-L6-v2"]');
  await expect(row).toContainText('23.7 MB');
  await expect(row.locator('.mstate')).toHaveText('Not downloaded');
});

// Keyboard focus stays on the row's action button while a download starts and ends (here: fails offline), and
// on Use when Use is activated. The Download/Cancel button is one element whose label switches.
test('model picker keeps keyboard focus through download state changes', async ({ page }) => {
  await page.context().route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net/, (r) => r.abort());
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const row = page.locator('li.mrow[data-model="tunabirgun/ArfLLM"]');
  const fetchBtn = row.locator('[data-act="fetch"]');
  await expect(fetchBtn).toHaveAttribute('aria-label', 'Download ArfLLM');
  await fetchBtn.focus();
  await page.keyboard.press('Enter');
  await expect(row.locator('.mstate')).not.toHaveText('Not downloaded');   // checked, and failed offline
  await expect(fetchBtn).toBeFocused();
  await expect(fetchBtn).toHaveAttribute('aria-label', 'Download ArfLLM');
  const use = row.getByRole('button', { name: 'Use ArfLLM', exact: true });
  await use.focus();
  await page.keyboard.press('Enter');
  await expect(row.locator('.mstate')).not.toHaveText(/Downloading/);
  await expect(use).toBeFocused();
});
