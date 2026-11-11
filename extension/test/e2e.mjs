// End-to-end test: loads the built extension in Chrome, serves fake chat pages
// at the real hostnames, and mocks the model API. Run `npm run build` first.
//   CHROME_PATH=/path/to/chrome npm test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const dist = here('../dist');
const fixture = (name) => readFileSync(here(`./fixtures/${name}.html`), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SITES = {
  'https://chatgpt.com/c/abc-123': 'chatgpt',
  'https://claude.ai/chat/xyz': 'claude',
  'https://gemini.google.com/app/1': 'gemini',
  'https://grok.com/c/9': 'grok'
};

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH ?? '/usr/bin/google-chrome',
  headless: true,
  args: [
    '--no-sandbox',
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch'
  ]
});

let passed = 0;
const ok = (name) => console.log(`  ok  ${++passed}. ${name}`);

async function openChat(url) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const name = SITES[req.url()];
    if (name) req.respond({ status: 200, contentType: 'text/html', body: fixture(name) });
    else req.abort();
  });
  await page.goto(url);
  await page.waitForSelector('#gutter-root', { timeout: 5000 });
  return page;
}

try {
  const workerTarget = await browser.waitForTarget((t) => t.type() === 'service_worker', { timeout: 10000 });
  const worker = await workerTarget.worker();
  const extId = new URL(workerTarget.url()).host;
  ok('extension loads, service worker starts');

  const getContext = (urlPattern) =>
    worker.evaluate(async (pattern) => {
      const [tab] = await chrome.tabs.query({ url: pattern });
      return { tabId: tab.id, ctx: await chrome.tabs.sendMessage(tab.id, { type: 'gutter:getContext' }) };
    }, urlPattern);

  // --- every site adapter reads its fixture ---
  const chat = await openChat('https://chatgpt.com/c/abc-123');
  const { tabId, ctx } = await getContext('https://chatgpt.com/*');
  assert.equal(ctx.site, 'chatgpt');
  assert.equal(ctx.title, 'Photosynthesis basics');
  assert.equal(ctx.convKey, 'chatgpt:/c/abc-123');
  assert.equal(ctx.fallback, false);
  assert.deepEqual(ctx.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(ctx.messages[1].text, /Calvin cycle/);
  ok('ChatGPT: reads 4 messages with roles + title');

  for (const [url, pattern, roles, title] of [
    ['https://claude.ai/chat/xyz', 'https://claude.ai/*', ['user', 'assistant'], 'Tide tables'],
    ['https://gemini.google.com/app/1', 'https://gemini.google.com/*', ['user', 'assistant'], ''],
    ['https://grok.com/c/9', 'https://grok.com/*', ['user', 'assistant'], 'Rust lifetimes']
  ]) {
    const p = await openChat(url);
    const r = await getContext(pattern);
    assert.deepEqual(r.ctx.messages.map((m) => m.role), roles, url);
    assert.equal(r.ctx.title, title);
    assert.equal(r.ctx.fallback, false);
    await p.close();
  }
  ok('Claude, Gemini, Grok: fixtures read correctly (nested matches deduped)');

  // --- "Ask Gutter" button on selection ---
  await chat.bringToFront();
  await chat.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#target'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await chat.waitForSelector('#gutter-root.visible', { timeout: 3000 });
  ok('selecting text shows the Ask Gutter button');

  // --- side panel (opened as a tab, pointed at the chat tab) ---
  await worker.evaluate(() =>
    chrome.storage.local.set({
      settings: { keys: { openai: 'sk-test', anthropic: 'sk-ant-test', gemini: '' }, models: {}, choice: 'own:openai' }
    })
  );
  const calls = [];
  const panel = await browser.newPage();
  await panel.setViewport({ width: 400, height: 860 });
  panel.on('pageerror', (e) => console.log('  [panel error]', e.message));
  await panel.setRequestInterception(true);
  panel.on('request', (req) => {
    const url = req.url();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: cors });
    if (url.startsWith('https://api.openai.com/')) {
      const body = JSON.parse(req.postData());
      calls.push({ provider: 'openai', body, auth: req.headers().authorization });
      const last = body.messages.at(-1).content;
      const text = last.includes('ONE follow-up') ? 'So how do C4 plants differ?' : 'It **fixes CO2** into sugar using ATP.';
      const sse = text.match(/.{1,8}/g).map((t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`).join('') + 'data: [DONE]\n\n';
      return req.respond({ status: 200, contentType: 'text/event-stream', headers: cors, body: sse });
    }
    if (url.startsWith('https://api.anthropic.com/')) {
      const body = JSON.parse(req.postData());
      calls.push({ provider: 'anthropic', body, key: req.headers()['x-api-key'] });
      const sse = `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Looks right to me.' } })}\n\n`;
      return req.respond({ status: 200, contentType: 'text/event-stream', headers: cors, body: sse });
    }
    if (url.startsWith('http://localhost:4000')) return req.abort();
    req.continue();
  });
  await panel.goto(`chrome-extension://${extId}/panel/index.html?tabId=${tabId}`);
  await panel.waitForSelector('.chip');
  assert.match(await panel.$eval('.chip', (e) => e.textContent), /ChatGPT · 4 messages/);
  ok('panel shows the chat it is reading');
  await panel.screenshot({ path: here('./shot-home.png') });

  // --- click Ask Gutter -> quote lands in the panel ---
  await chat.bringToFront();
  await chat.click('.gutter-ask-btn');
  await panel.waitForSelector('.quote', { timeout: 3000 });
  assert.match(await panel.$eval('.quote-text', (e) => e.textContent), /Calvin cycle then fixes carbon dioxide/);
  ok('Ask Gutter hands the highlighted text to the panel');

  // --- ask, stream, render ---
  await panel.bringToFront();
  await panel.type('textarea', 'What does "fixes" mean here?');
  await panel.keyboard.press('Enter');
  await panel.waitForFunction(() => document.querySelector('.msg.bot .via'), { timeout: 5000 });
  assert.equal(await panel.$eval('.msg.bot .md', (e) => e.textContent.trim()), 'It fixes CO2 into sugar using ATP.');
  assert.equal(await panel.$eval('.msg.bot .md strong', (e) => e.textContent), 'fixes CO2');
  assert.equal(await panel.$eval('.msg.bot .via', (e) => e.textContent), 'OpenAI · your key');
  const first = calls[0];
  assert.equal(first.auth, 'Bearer sk-test');
  assert.equal(first.body.messages[0].role, 'system');
  assert.match(first.body.messages[0].content, /How does photosynthesis work\?/);
  assert.match(first.body.messages[0].content, /<highlighted_text>\nThe Calvin cycle/);
  assert.deepEqual(first.body.messages.slice(1), [{ role: 'user', content: 'What does "fixes" mean here?' }]);
  ok('side question streams back; model got the chat + highlight as context');
  await sleep(300);
  await panel.screenshot({ path: here('./shot-thread.png') });

  // --- the main chat was not touched ---
  assert.equal(await chat.$eval('#prompt-textarea', (e) => e.textContent), '');
  assert.equal(await chat.$$eval('[data-message-author-role]', (els) => els.length), 4);
  ok('main chat untouched by the side question');

  // --- send to main: drops a follow-up in the chat box, does not send ---
  await chat.bringToFront();
  await panel.evaluate(() => document.querySelector('.to-main').click());
  await chat.waitForFunction(() => document.querySelector('#prompt-textarea').textContent.length > 0, { timeout: 5000 });
  assert.equal(await chat.$eval('#prompt-textarea', (e) => e.textContent), 'So how do C4 plants differ?');
  ok('Send to main puts the follow-up in the chat box');

  // --- thread saved; second opinion goes to a different company's model ---
  await panel.bringToFront();
  await panel.evaluate(() => document.querySelector('.link.back').click());
  await panel.waitForSelector('.threads .thread');
  assert.equal(await panel.$$eval('.threads .thread', (els) => els.length), 1);
  const stored = await worker.evaluate(() => chrome.storage.local.get('threads:chatgpt:/c/abc-123'));
  assert.equal(stored['threads:chatgpt:/c/abc-123'][0].messages.length, 2);
  ok('thread saved locally under this chat');

  await panel.evaluate(() => document.querySelector('.chip-btn.alt').click());
  await panel.waitForFunction(() => document.querySelector('.msg.bot .via')?.textContent === 'Claude · your key', { timeout: 5000 });
  const claudeCall = calls.find((c) => c.provider === 'anthropic');
  assert.equal(claudeCall.key, 'sk-ant-test');
  assert.match(claudeCall.body.system, /<highlighted_text>\nInside chloroplasts/);
  ok('Second opinion on a ChatGPT chat is answered by Claude, about the last answer');

  // --- jump to quote ---
  const jumped = await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'gutter:jump', quote: 'The Calvin cycle then fixes' }), tabId);
  assert.equal(jumped.ok, true);
  assert.equal(await chat.$eval('#target', (e) => e.classList.contains('gutter-flash')), true);
  ok('jump-to-source highlights the right paragraph');

  // --- no-chat state + settings screen render ---
  const lonely = await browser.newPage();
  await lonely.setViewport({ width: 400, height: 700 });
  await lonely.goto(`chrome-extension://${extId}/panel/index.html?tabId=999999`);
  await lonely.waitForSelector('.gutter-oops');
  await lonely.screenshot({ path: here('./shot-nochat.png') });
  await panel.evaluate(() => document.querySelector('.icon-btn').click());
  await panel.waitForSelector('.settings');
  await panel.screenshot({ path: here('./shot-settings.png') });
  ok('no-chat and settings screens render');

  console.log(`\n${passed} checks passed`);
} finally {
  await browser.close();
}
