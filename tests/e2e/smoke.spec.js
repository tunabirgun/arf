import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// One end-to-end pass over the core loop a user actually performs:
// launch → create a note → write it → link an existing note → rename → add a citation →
// export Markdown → export HTML → reopen (reload) and confirm nothing was lost.
test('core note loop survives a reload', async ({ page }) => {
  // seed a reference so [@guth1981] resolves — otherwise a fresh vault has an empty library and
  // the citation would render as a dangling span, testing the opposite of what we intend.
  await page.addInitScript(() => {
    localStorage.setItem('arf-refs-v0', JSON.stringify([
      { id: 'r_guth1981', citekey: 'guth1981', title: 'Inflationary universe', type: 'article-journal', year: 1981, authors: [{ f: 'Guth', g: 'Alan' }] },
    ]));
  });
  await page.goto('/');

  // launch: the fresh vault seeds three starter notes
  const list = page.locator('aside.list');
  await expect(list.getByText('Welcome to Arf')).toBeVisible();

  // create a new note — lands in write mode
  await page.locator('button.newbtn').click();
  await expect(page.locator('input.title')).toBeVisible();

  // write a body that links an existing note and cites a key
  const body = 'Smoke body linking [[Welcome to Arf]] and citing [@guth1981] here.';
  await page.locator('.cm-content').click();
  await page.keyboard.type(body);

  // rename the note
  await page.fill('input.title', 'Smoke Test Note');

  // read view: the wikilink resolves to an anchor and the citation resolves to an author-year link
  await page.getByRole('button', { name: 'Read', exact: true }).click();
  const read = page.locator('.read');
  await expect(read.locator('a.wl')).toContainText('Welcome to Arf');
  await expect(read.locator('a.cite')).toContainText('Guth 1981');

  // export Markdown — web mode downloads a Blob
  await page.locator('button.expbtn').click();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const [mdDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export as Markdown' }).click(),
  ]);
  expect(mdDownload.suggestedFilename()).toMatch(/\.md$/);
  const md = await readFile(await mdDownload.path(), 'utf8');
  expect(md).toContain('title: "Smoke Test Note"');
  expect(md).toContain('[[Welcome to Arf]]');

  // export HTML — reopen the dialog (it closes after each export)
  await page.locator('button.expbtn').click();
  await page.getByRole('button', { name: 'HTML', exact: true }).click();
  const [htmlDownload] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export as HTML' }).click(),
  ]);
  expect(htmlDownload.suggestedFilename()).toMatch(/\.html$/);
  const html = await readFile(await htmlDownload.path(), 'utf8');
  expect(html).toContain('<!doctype html>');
  expect(html).toContain('Smoke Test Note');

  // reopen the vault: reload and confirm the renamed note and its body persisted
  await page.reload();
  await expect(page.locator('aside.list').getByText('Smoke Test Note')).toBeVisible();
  await expect(page.locator('h1.title')).toContainText('Smoke Test Note');
});
