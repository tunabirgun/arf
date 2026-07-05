import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';

// Arf web build. The same build will later be wrapped by Tauri v2 (see
// ARF-IMPLEMENTATION-PLAN.md) for real-filesystem vault access; the PWA config
// makes the web version installable and offline-capable (plan Phase 5).
// base is '/' for local dev and Tauri; set DEPLOY_BASE=/arf-app/ for GitHub Pages.
// Tauri serves from tauri://localhost/ (base '/') and the PWA service worker must
// be off there or it white-screens the webview.
const isTauri = !!process.env.TAURI_ENV_PLATFORM;
const base = isTauri ? '/' : (process.env.DEPLOY_BASE || '/');

export default defineConfig({
  base,
  plugins: [
    svelte(),
    !isTauri && VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'fonts/*.woff2'],
      manifest: {
        name: 'Arf — a second brain for scientists',
        short_name: 'Arf',
        description: 'Notes, links, a knowledge graph, and a private on-device machine that suggests connections.',
        theme_color: '#0a0a0a',
        background_color: '#faf9f7',
        display: 'standalone',
        start_url: '.',
        scope: base,
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: { globPatterns: ['**/*.{js,css,html,woff2,svg}'], maximumFileSizeToCacheInBytes: 3000000 },
    }),
  ].filter(Boolean),
  server: { port: 5175 },
});
