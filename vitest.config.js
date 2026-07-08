import { defineConfig } from 'vitest/config';

// Unit tests exercise the pure logic modules in src/lib (no Svelte components), so no
// plugins are needed. Node is the default env; specs that touch localStorage, crypto, or
// DOMPurify opt into jsdom with a `// @vitest-environment jsdom` line at the top of the file.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.js'],
    environment: 'node',
  },
});
