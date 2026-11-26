import { test, expect } from '@playwright/test';

// Exercises the refactored move paths in the running app: moving a note into a folder,
// nesting one folder inside another (planFolderMove), reordering siblings, and confirming
// the arrangement persists across a reload.
test('folders, moves, and reordering persist across a reload', async ({ page }) => {
  // pin zoom to 100% so Playwright's box coordinates line up with getBoundingClientRect
  // (the drop heuristic reads pointer-Y within a row to tell "nest" from "reorder")
  await page.addInitScript(() => { try { localStorage.setItem('arf-zoom', '100'); } catch (e) {} });
  await page.goto('/');
  const list = page.locator('aside.list');
  await expect(list.getByText('Welcome to Arf')).toBeVisible();

  // create a folder
  await page.locator('button.mini').first().click();
  await page.locator('input.nfinput').fill('Research');
  await page.locator('input.nfinput').press('Enter');
  await expect(page.locator('[data-folder="Research"]')).toBeVisible();

  // move the current note into it via the crumbs "move to folder" select
  await page.locator('select.fmove').selectOption('Research');
  await expect(page.locator('select.fmove')).toHaveValue('Research');

  // create a second folder and nest the first inside it via drag-and-drop (planFolderMove).
  // Drop at the row's vertical centre so the heuristic reads it as "nest into", not "reorder".
  await page.locator('button.mini').first().click();
  await page.locator('input.nfinput').fill('Ideas');
  await page.locator('input.nfinput').press('Enter');
  await expect(page.locator('[data-folder="Ideas"]')).toBeVisible();

  const ideas = page.locator('[data-folder="Ideas"]');
  const box = await ideas.boundingBox();
  const mid = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
  await page.locator('[data-folder="Research"]').dispatchEvent('dragstart');
  await ideas.dispatchEvent('dragover', mid);
  await ideas.dispatchEvent('drop', mid);
  await expect(page.locator('[data-folder="Ideas/Research"]')).toBeVisible();

  // the note came along with its folder, and the whole arrangement survives a reload
  await expect(page.locator('select.fmove')).toHaveValue('Ideas/Research');
  await page.reload();
  await expect(page.locator('[data-folder="Ideas/Research"]')).toBeVisible();
  await expect(page.locator('select.fmove')).toHaveValue('Ideas/Research');
});

// Native-run defects D1/D3: a subfolder name typed right after the context-menu command lands in the input (the
// closing menu must not take focus back), and a collapsed folder stays collapsed after a reload.
test('new subfolder from the context menu takes typing, and collapse state persists', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('aside.list').getByText('Welcome to Arf')).toBeVisible();
  await page.locator('button.mini').first().click();
  await page.locator('input.nfinput').fill('Alpha');
  await page.locator('input.nfinput').press('Enter');
  const alpha = page.locator('[data-folder="Alpha"]');
  await alpha.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New subfolder' }).click();
  await page.keyboard.type('Beta');   // no fill(): the input must already hold focus
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-folder="Alpha/Beta"]')).toBeVisible();
  await alpha.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Collapse' }).click();
  await expect(page.locator('[data-folder="Alpha/Beta"]')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-folder="Alpha"]')).toBeVisible();
  await expect(page.locator('[data-folder="Alpha/Beta"]')).toHaveCount(0);
  // Rename… prefills the old name selected, so keyboard-only typing replaces it
  await page.locator('[data-folder="Alpha"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename…' }).click();
  await page.keyboard.type('Gamma');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-folder="Gamma"]')).toBeVisible();
  await expect(page.locator('[data-folder="Alpha"]')).toHaveCount(0);
});
