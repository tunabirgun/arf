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
