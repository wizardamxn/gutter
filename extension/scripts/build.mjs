// Builds the background worker + content script, and writes manifest.json.
// The React side panel is built by Vite (see vite.config.ts).
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const API_URL = (process.env.GUTTER_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const pkg = JSON.parse(readFileSync(here('../package.json'), 'utf8'));

const CHAT_SITES = [
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://claude.ai/*',
  'https://gemini.google.com/*',
  'https://grok.com/*'
];

await build({
  entryPoints: { background: here('../src/background.ts'), content: here('../src/content.ts') },
  outdir: here('../dist'),
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  define: { __API_URL__: JSON.stringify(API_URL), __UPGRADE_URL__: JSON.stringify(process.env.GUTTER_UPGRADE_URL ?? '') },
  logLevel: 'info'
});

mkdirSync(here('../dist/icons'), { recursive: true });
cpSync(here('../static/icons'), here('../dist/icons'), { recursive: true });
cpSync(here('../src/content.css'), here('../dist/content.css'));

// WebAssembly runtime for the meaning matcher. It must ship inside the extension:
// Chrome Web Store rules (and our CSP) forbid loading code from a CDN.
// The asyncify build is the one that can use the graphics card (WebGPU).
mkdirSync(here('../dist/panel/ort'), { recursive: true });
for (const file of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  cpSync(here(`../node_modules/onnxruntime-web/dist/${file}`), here(`../dist/panel/ort/${file}`));
}
// The bundler also emits a second, larger copy of the runtime that we never load. Drop it.
for (const file of readdirSync(here('../dist/panel/assets'))) {
  if (/^ort-wasm.*\.wasm$/.test(file)) rmSync(here(`../dist/panel/assets/${file}`));
}

const icons = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const manifest = {
  manifest_version: 3,
  name: 'Gutter — side questions for AI chats',
  short_name: 'Gutter',
  version: pkg.version,
  description:
    'Ask side questions about your ChatGPT, Claude, Gemini or Grok chat without derailing the main thread.',
  permissions: ['sidePanel', 'storage', 'alarms'],
  host_permissions: [
    ...CHAT_SITES,
    // Model APIs, called directly from the side panel when you use your own key.
    'https://api.openai.com/*',
    'https://api.anthropic.com/*',
    'https://generativelanguage.googleapis.com/*',
    // Gutter server (accounts, sync, hosted answers, selector config).
    `${new URL(API_URL).origin}/*`
  ],
  // 'wasm-unsafe-eval' lets the packaged WebAssembly runtime run. No remote code is allowed.
  content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  background: { service_worker: 'background.js' },
  side_panel: { default_path: 'panel/index.html' },
  action: { default_title: 'Open Gutter', default_icon: icons },
  icons,
  commands: {
    _execute_action: {
      suggested_key: { default: 'Alt+Shift+S' },
      description: 'Open the Gutter side panel'
    }
  },
  content_scripts: [
    { matches: CHAT_SITES, js: ['content.js'], css: ['content.css'], run_at: 'document_idle' }
  ]
};
writeFileSync(here('../dist/manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest.json written (API: ${API_URL})`);
