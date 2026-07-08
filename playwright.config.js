import { defineConfig, devices } from '@playwright/test';

// E2E smoke runs against the Vite web build. Arf's web mode uses the same Svelte UI as the
// Tauri desktop app, backed by localStorage instead of the file vault, so a browser flow
// exercises note creation, linking, renaming, citations, and export end to end. PDF export
// goes through the OS print dialog (not automatable); the smoke asserts Markdown + HTML.
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5175',
    acceptDownloads: true,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5175',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
