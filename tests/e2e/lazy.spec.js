import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Editor, Library, Reader and KaTeX load on demand. Math must typeset once KaTeX arrives (never stay a
// placeholder), exports must never carry a placeholder, and the read-view task toggle must hit the
// right line even after a fenced task-like line.
test('lazy editor and math render, export typeset math, and the task toggle skips code fences', async ({ page }) => {
  const body = ['Euler $e^{i\\pi}+1=0$ inline.', '', '```', '- [ ] fenced, not a task', '```', '', '- [ ] real task', '', 'As in [@guth1981].'].join('\n');
  const note = { id: 'LAZY1', title: 'Lazy check', folder: '', tags: [], created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z', body };
  // planted through the legacy cache key (one-shot), so the body is exact rather than typed through the editor
  const ref = { id: 'r_guth1981', citekey: 'guth1981', title: 'Inflationary universe', type: 'article-journal', year: 1981, authors: [{ f: 'Guth', g: 'Alan' }] };
  await page.addInitScript(({ n, r }) => {
    if (sessionStorage.getItem('planted')) return; sessionStorage.setItem('planted', '1');
    localStorage.setItem('arf-vault-v0', JSON.stringify([n])); localStorage.setItem('arf-refs-v0', JSON.stringify([r]));
  }, { n: note, r: ref });
  const modules = [];
  page.on('request', (r) => modules.push(r.url()));
  await page.goto('/');
  await expect(page.locator('h1.title')).toContainText('Lazy check');
  await page.getByRole('button', { name: 'Write', exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('real task');
  expect(modules.some((u) => /Editor(-[\w-]+\.js|\.svelte)/.test(u))).toBe(true);   // the editor is its own module

  await page.getByRole('button', { name: 'Read', exact: true }).click();
  const read = page.locator('.read');
  await expect(read.locator('.katex').first()).toBeVisible();
  await expect(read.locator('.math-pending')).toHaveCount(0);

  // one rendered checkbox (the fenced line is code); toggling it edits the real task line only
  await expect(read.locator('input[data-task]')).toHaveCount(1);
  await read.locator('input[data-task]').click();
  await expect(read.locator('input[data-task]')).toBeChecked();
  await page.locator('button.expbtn').click();
  await page.getByRole('button', { name: 'Markdown', exact: true }).click();
  const [mdDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export as Markdown' }).click()]);
  const md = await readFile(await mdDownload.path(), 'utf8');
  expect(md).toContain('- [ ] fenced, not a task');
  expect(md).toContain('- [x] real task');

  await page.locator('button.expbtn').click();
  await page.getByRole('button', { name: 'HTML', exact: true }).click();
  const [htmlDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export as HTML' }).click()]);
  const html = await readFile(await htmlDownload.path(), 'utf8');
  expect(html).toContain('class="katex"');
  expect(html).not.toContain('math-pending');
  expect(html).toContain('.katex');   // the KaTeX stylesheet is inlined

  // lazy Library: a citation jumps to its reference (bound refs and jumpTo reach the dynamic component)
  await page.locator('.read a.cite').click();
  await expect(page.locator('.libview .refrow.on[data-ref="' + ref.id + '"]')).toBeVisible();

  // lazy Reader: open the note in the side reader; its Markdown (math included) renders there
  await page.locator('.viewtoggle').getByRole('button', { name: 'Notes', exact: true }).click();
  await page.locator('aside.list [data-nid="' + note.id + '"]').click({ button: 'right' });
  await page.locator('.ctxmenu').getByRole('menuitem', { name: 'Open in reader', exact: true }).click();   // menu items carry role=menuitem
  const pane = page.locator('.readerpane');
  await expect(pane).toContainText('real task');
  await expect(pane.locator('.katex').first()).toBeVisible();
});
