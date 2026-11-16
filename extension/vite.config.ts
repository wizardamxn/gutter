import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// The side panel (React). Background + content scripts are built by scripts/build.mjs.
// `--mode bench` also builds the dev-only benchmark page, panel/bench.html.
export default defineConfig(({ mode }) => ({
  root: here('./panel'),
  base: './',
  plugins: [react()],
  worker: { format: 'es' }, // the meaning matcher runs in a module worker
  define: {
    __API_URL__: JSON.stringify(process.env.GUTTER_API_URL ?? 'http://localhost:4000'),
    // Where the Upgrade button goes. Leave unset until paid plans open.
    __UPGRADE_URL__: JSON.stringify(process.env.GUTTER_UPGRADE_URL ?? '')
  },
  build: {
    outDir: here('./dist/panel'),
    emptyOutDir: true,
    target: 'chrome120',
    rollupOptions: {
      input: { index: here('./panel/index.html'), ...(mode === 'bench' ? { bench: here('./panel/bench.html') } : {}) }
    }
  }
}));
