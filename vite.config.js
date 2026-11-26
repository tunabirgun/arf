import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The onnxruntime-web build that @huggingface/transformers actually resolves. Its WASM runtime is fetched
// from jsDelivr at this exact version when a model is first loaded, so it never ships in the installer.
function ortWebDir() {
  const req = createRequire(import.meta.url);
  const tfPkg = join(dirname(req.resolve('@huggingface/transformers')), '..', 'package.json');
  const declared = JSON.parse(readFileSync(tfPkg, 'utf8')).dependencies['onnxruntime-web'];
  let dir = dirname(createRequire(tfPkg).resolve('onnxruntime-web'));
  for (;;) {
    try { const p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')); if (p.name === 'onnxruntime-web') { if (p.version !== declared) throw new Error('onnxruntime-web ' + p.version + ' installed, transformers declares ' + declared); return { dir, version: p.version }; } } catch (e) { if (e.message.startsWith('onnxruntime-web ')) throw e; }
    const up = dirname(dir); if (up === dir) throw new Error('onnxruntime-web package.json not found'); dir = up;
  }
}

// SHA-384 (SRI form) of every WASM runtime variant Transformers.js may request (ort-wasm-simd-threaded[.variant].mjs/.wasm).
// The worker fetches these from jsDelivr at the version above and refuses any file whose bytes do not match.
function ortRuntime() {
  const { dir, version } = ortWebDir(), dist = join(dir, 'dist'), files = {};
  for (const f of readdirSync(dist).filter((f) => /^ort-wasm-simd-threaded(\.\w+)?\.(mjs|wasm)$/.test(f)).sort())
    files[f] = 'sha384-' + createHash('sha384').update(readFileSync(join(dist, f))).digest('base64');
  if (!Object.keys(files).length) throw new Error('no onnxruntime-web runtime files in ' + dist);
  return { version, files };
}
const ORT = ortRuntime();

// Arf is a native desktop app: this build is loaded by the Tauri v2 webview
// (tauri://localhost/, base '/'). `vite dev` remains for local development only.
export default defineConfig({
  base: '/',
  plugins: [svelte()],
  // the extern-wasm export of onnxruntime-web has no `new URL(*.wasm, import.meta.url)`, so Vite emits no 23 MB runtime
  resolve: { conditions: ['onnxruntime-web-use-extern-wasm'] },
  define: { __ORT_WEB_VERSION__: JSON.stringify(ORT.version), __ORT_RUNTIME__: JSON.stringify(ORT) },
  server: { port: 5175, strictPort: true }, // fail loudly on a busy port instead of drifting off the hardcoded devUrl
});
