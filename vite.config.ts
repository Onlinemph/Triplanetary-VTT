import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// `base` is overridable so the same build works on GitHub Pages
// (/<repo>/) and on a root-served host (/).
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
      '@render': fileURLToPath(new URL('./src/render', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
      '@scenarios': fileURLToPath(new URL('./src/scenarios', import.meta.url)),
      '@net': fileURLToPath(new URL('./src/net', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
