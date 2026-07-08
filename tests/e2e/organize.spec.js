import { test, expect } from '@playwright/test';

// Exercises the refactored move paths in the running app: moving a note into a folder,
// nesting one folder inside another (planFolderMove), and confirming both persist across a reload.
test('folders and moves persist across a reload', async ({ page }) => {
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

  // create a second folder and nest the first inside it via drag-and-drop (planFolderMove)
  await page.locator('button.mini').first().click();
  await page.locator('input.nfinput').fill('Ideas');
  await page.locator('input.nfinput').press('Enter');
  await expect(page.locator('[data-folder="Ideas"]')).toBeVisible();

  await page.locator('[data-folder="Research"]').dispatchEvent('dragstart');
  await page.locator('[data-folder="Ideas"]').dispatchEvent('dragover');
  await page.locator('[data-folder="Ideas"]').dispatchEvent('drop');
  await expect(page.locator('[data-folder="Ideas/Research"]')).toBeVisible();

  // the note came along with its folder, and the whole arrangement survives a reload
  await expect(page.locator('select.fmove')).toHaveValue('Ideas/Research');
  await page.reload();
  await expect(page.locator('[data-folder="Ideas/Research"]')).toBeVisible();
  await expect(page.locator('select.fmove')).toHaveValue('Ideas/Research');
});
