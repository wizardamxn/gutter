import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The side panel (React). Background + content scripts are built by scripts/build.mjs.
export default defineConfig({
  root: here('./panel'),
  base: './',
  plugins: [react()],
  define: {
    __API_URL__: JSON.stringify(process.env.GUTTER_API_URL ?? 'http://localhost:4000')
  },
  build: {
    outDir: here('./dist/panel'),
    emptyOutDir: true,
    target: 'chrome120'
  }
});
