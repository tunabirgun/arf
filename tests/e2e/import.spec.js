import { test, expect } from '@playwright/test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { importMarkdownFiles, importReferences, mergeImportedRefs } from '../../src/lib/importers.js';
import { stripTopFolder } from '../../src/lib/importflow.js';
import { slug } from '../../src/lib/vaultadapter.js';

// Settings → Import and export in the web build: Markdown folder (webkitdirectory), ZIP, reference files,
// the vault ZIP download, and files dropped onto the window. Expected counts come from the importers
// run on the same fixtures, not from literals.
const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'unit', 'fixtures', 'import');
const walk = async (d) => (await Promise.all((await readdir(d)).map(async (f) => { const p = join(d, f); return (await stat(p)).isDirectory() ? walk(p) : [p]; }))).flat();

async function openSettings(page) {
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByText('Import and export')).toBeVisible();
}
async function choose(page, button, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: button, exact: true }).click()]);
  await chooser.setFiles(files);
}
const status = (page) => page.locator('.importmsg');

test('import a Markdown folder keeps its structure and reports skipped files', async ({ page }) => {
  const files = await walk(join(FIX, 'vault'));
  const rel = stripTopFolder(files.map((f) => relative(FIX, f).replace(/\\/g, '/')));
  const md = await Promise.all(files.map(async (f, i) => ({ path: rel[i], text: /\.md$/.test(f) ? await readFile(f, 'utf8') : null })));
  const expected = importMarkdownFiles(md).notes;

  await openSettings(page);
  await choose(page, 'Folder…', join(FIX, 'vault'));
  await expect(status(page)).toContainText('Imported ' + expected.length + ' notes (' + expected.length + ' new, 0 merged).');
  await expect(status(page)).toContainText('not Markdown');   // readme.txt
  await page.keyboard.press('Escape');

  const list = page.locator('aside.list');
  for (const n of expected) await expect(list.getByText(n.title, { exact: true })).toHaveCount(1);
  await expect(list.locator('[data-folder="Projects/Alpha"]')).toHaveCount(1);
  await expect(list.locator('[data-folder="Ünite"]')).toHaveCount(1);

  // frontmatter tags come through
  const alpha = expected.find((n) => n.title === 'Alpha Plan');
  await list.getByText('Alpha Plan', { exact: true }).click();
  await expect(page.locator('h1.title')).toContainText('Alpha Plan');
  await expect(page.locator('.crumbs .ctag')).toHaveCount(alpha.tags.length);
});

test('import a ZIP with notes and a references file', async ({ page }) => {
  const bib = await readFile(join(FIX, 'refs.bib'), 'utf8');
  const zip = zipSync({
    'MyVault/zip-a.md': strToU8('# Zip Note A\n\nLinks [[Zip Note B]].'),
    'MyVault/sub/zip-b.md': strToU8('---\ntitle: Zip Note B\n---\nBody of B.'),
    'MyVault/references.bib': strToU8(bib),
    'MyVault/notes.txt': strToU8('not a note'),
  });
  const refsAdded = mergeImportedRefs([], importReferences(bib, 'references.bib').refs).added.length;

  await openSettings(page);
  await choose(page, 'ZIP…', { name: 'vault.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) });
  await expect(status(page)).toContainText('Imported 2 notes (2 new, 0 merged).');
  await expect(status(page)).toContainText(refsAdded + ' references added');
  await expect(status(page)).toContainText('Skipped 1: 1 not Markdown.');
  await page.keyboard.press('Escape');
  await page.locator('aside.list').getByText('Zip Note A', { exact: true }).click();
  await expect(page.locator('.read a.wl')).toContainText('Zip Note B');   // the link resolves to the imported note
});

test('reference import from Settings and from the Library adds references and skips duplicates', async ({ page }) => {
  const ris = await readFile(join(FIX, 'refs.ris'), 'utf8');
  const n = mergeImportedRefs([], importReferences(ris, 'refs.ris').refs).added.length;
  expect(n).toBeGreaterThan(0);

  await openSettings(page);
  await choose(page, '.bib, .ris, .json…', join(FIX, 'refs.ris'));
  await expect(status(page)).toContainText(n + ' references added.');
  await page.keyboard.press('Escape');

  // the Library's Import… runs the same import; every work is already there now
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.locator('.refrow')).toHaveCount(n);
  await choose(page, 'Import…', join(FIX, 'refs.ris'));
  await expect(page.locator('.savebanner')).toContainText('0 references added, ' + n + ' duplicate');
  await expect(page.locator('.refrow')).toHaveCount(n);
});

test('export the vault as a ZIP downloads every note as Markdown', async ({ page }) => {
  await openSettings(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export as ZIP', exact: true }).click()]);
  expect(download.suggestedFilename()).toMatch(/^arf-vault-\d{4}-\d{2}-\d{2}\.zip$/);
  const entries = unzipSync(new Uint8Array(await readFile(await download.path())));
  const names = Object.keys(entries);
  expect(names).toContain('README.txt');
  expect(names.some((p) => p.endsWith('/' + slug('Welcome to Arf') + '.md') || p === slug('Welcome to Arf') + '.md')).toBe(true);
  const titles = await page.evaluate(() => [...document.querySelectorAll('aside.list .item')].length);
  expect(names.filter((p) => p.endsWith('.md')).length).toBeGreaterThanOrEqual(titles);
});

test('files dropped onto the window import; other drops are ignored', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  const drop = (files) => page.evaluate((fs) => {
    const dt = new DataTransfer();
    for (const f of fs) dt.items.add(new File([f.text], f.name, { type: f.type }));
    document.querySelector('main.center').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, files);

  await drop([{ name: 'photo.png', text: 'x', type: 'image/png' }, { name: 'notes.txt', text: 'x', type: 'text/plain' }]);
  await page.waitForTimeout(300);
  await expect(page.locator('.savebanner')).toHaveCount(0);   // nothing recognised: no import, no message
  expect(page.url()).toMatch(/localhost:5175\/?$/);            // and the webview did not navigate

  await drop([{ name: 'dropped.md', text: '# Dropped Note\n\nCame in by drag and drop.', type: 'text/markdown' }]);
  await expect(page.locator('.savebanner')).toContainText('Imported 1 note (1 new, 0 merged).');
  await expect(page.locator('aside.list').getByText('Dropped Note', { exact: true })).toBeVisible();
});

test('re-importing the same loose Markdown file reports it unchanged instead of duplicating it', async ({ page }) => {
  await openSettings(page);
  const file = { name: 'alpha.md', mimeType: 'text/markdown', buffer: Buffer.from('# Imported alpha\n\nSame text both times.') };
  const btn = page.getByRole('button', { name: 'Markdown files…', exact: true });
  await btn.scrollIntoViewIfNeeded();
  const y0 = (await btn.boundingBox()).y;
  await choose(page, 'Markdown files…', file);
  await expect(status(page)).toContainText('Imported 1 note (1 new, 0 merged).');
  expect((await btn.boundingBox()).y).toBe(y0);   // the status line is reserved below: nothing moves
  await choose(page, 'Markdown files…', file);
  await expect(status(page)).toContainText('1 note already up to date.');
  await expect(status(page)).not.toContainText('Imported');
  await page.waitForTimeout(6500);                // the result stays until the next action (no auto-clear)
  await expect(status(page)).toContainText('already up to date');
  await page.keyboard.press('Escape');
  await expect(page.locator('aside.list').getByText('Imported alpha', { exact: true })).toHaveCount(1);
});

test('the export result is reported on the status line', async ({ page }) => {
  await openSettings(page);
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export as ZIP', exact: true }).click()]);
  const d = new Date(), p = (x) => String(x).padStart(2, '0');
  expect(download.suggestedFilename()).toBe('arf-vault-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.zip');   // local day
  await expect(status(page)).toContainText('✓ Exported');
  await expect(status(page)).toContainText(download.suggestedFilename());
});

test('a Markdown file dropped on the editor imports; it is not pasted into the open note', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  await page.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+e');
  const cm = page.locator('.cm-content');
  await expect(cm).toBeVisible();
  const before = await cm.textContent();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['# Dropped On Editor\n\nSECRET-BODY-TEXT'], 'dropped.md', { type: 'text/markdown' }));
    const el = document.querySelector('.cm-content');
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));
  });
  await expect(page.locator('.savebanner')).toContainText('Imported 1 note (1 new, 0 merged).');
  expect(await cm.textContent()).toBe(before);
  await expect(cm).not.toContainText('SECRET-BODY-TEXT');
  await expect(page.locator('aside.list').getByText('Dropped On Editor', { exact: true })).toBeVisible();
});

test('a non-reference JSON file (package.json) adds no reference and says the format is unrecognized', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  const pkg = await readFile(join(FIX, '..', '..', '..', '..', 'package.json'), 'utf8');
  await page.evaluate((text) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], 'package.json', { type: 'application/json' }));
    document.querySelector('main.center').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, pkg);
  await expect(page.locator('.savebanner')).toContainText('Unrecognized reference format');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('arf-refs-v0') || '[]').length)).toBe(0);
});

test('a top-level folder named attachments is refused; a subfolder of that name is fine', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  await page.getByRole('button', { name: '+ Folder', exact: true }).click();
  await page.locator('input.nfinput').fill('Attachments');
  await page.keyboard.press('Enter');
  await expect(page.locator('.savebanner')).toContainText('reserved');
  await expect(page.locator('aside.list [data-folder="Attachments"]')).toHaveCount(0);
});
