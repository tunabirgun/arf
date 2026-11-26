import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

// The same e2e suite against the production build (lazy chunks, no dev-server module graph), served by
// `vite preview`. PREVIEW_OUT_DIR overrides where the build goes; it defaults to the 2026-11 optimization
// workspace beside the repo. Never reuses a running server: a dev server on the same port would pass falsely.
const outDir = process.env.PREVIEW_OUT_DIR || '../research/optimize-2026-11/wave1-preview';

export default defineConfig({
  ...base,
  webServer: {
    command: `npx vite build --outDir "${outDir}" --emptyOutDir && npx vite preview --outDir "${outDir}" --port 5175 --strictPort`,
    url: 'http://localhost:5175',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
