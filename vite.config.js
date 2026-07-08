import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Arf is a native desktop app: this build is loaded by the Tauri v2 webview
// (tauri://localhost/, base '/'). `vite dev` remains for local development only.
export default defineConfig({
  base: '/',
  plugins: [svelte()],
  server: { port: 5175, strictPort: true }, // fail loudly on a busy port instead of drifting off the hardcoded devUrl
});
