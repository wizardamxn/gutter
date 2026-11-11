// Builds the background worker + content script, and writes manifest.json.
// The React side panel is built by Vite (see vite.config.ts).
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  define: { __API_URL__: JSON.stringify(API_URL) },
  logLevel: 'info'
});

mkdirSync(here('../dist/icons'), { recursive: true });
cpSync(here('../static/icons'), here('../dist/icons'), { recursive: true });
cpSync(here('../src/content.css'), here('../dist/content.css'));

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
