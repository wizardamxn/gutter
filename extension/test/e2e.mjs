// End-to-end test: loads the built extension in Chrome, serves fake chat pages
// at the real hostnames, and mocks the model API. Run `npm run build` first.
//   CHROME_PATH=/path/to/chrome npm test
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
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
  // Branded Chrome 137+ ignores --load-extension; load it over the DevTools pipe instead.
  pipe: true,
  enableExtensions: [dist],
  args: ['--no-sandbox']
});

// Generated long chats, for testing what gets picked when the chat doesn't fit.
const para = (topic, n) =>
  Array.from({ length: n }, (_, i) => `<p>Paragraph ${i + 1} about ${topic}. ${`The ${topic} discussion continues with more detail here. `.repeat(6)}</p>`).join('');
const page = (title, messages) =>
  `<!doctype html><html><head><title>${title} - ChatGPT</title></head><body><main>${messages
    .map((m, i) => `<div data-message-author-role="${i % 2 ? 'assistant' : 'user'}"><div>${m}</div></div>`)
    .join('')}</main><form><div id="prompt-textarea" contenteditable="true" style="width:400px;min-height:40px"></div></form></body></html>`;
const topics = ['gardening', 'sailing', 'baking', 'chess', 'astronomy', 'cycling'];
const longChat = Array.from({ length: 36 }, (_, i) => para(topics[i % topics.length], 4));
longChat[5] = `${para('travel', 2)}<p id="fact">The zebra migration tour has a budget of 4,200 dollars per person.</p>${para('travel', 2)}`;
longChat[35] = '<p>Final message: we agreed to revisit everything on Friday.</p>';
// One answer far bigger than the built-in model can read at once; each section has a marker sentence.
const hugeAnswer = Array.from({ length: 12 }, (_, i) => `<p>Section ${i + 1} opens with the marker fact number ${i + 1} about volcanoes.</p>${para('volcanoes', 9)}`).join('');
const PAGES = {
  'https://chatgpt.com/c/long-1': page('Long chat', longChat),
  'https://chatgpt.com/c/long-2': page('Huge answer', ['Tell me everything about volcanoes.', hugeAnswer]),
  'https://chatgpt.com/c/new-markup':
    '<!doctype html><html><head><title>Workers - ChatGPT</title></head><body><nav>New chat Search</nav><main>' +
    '<article data-testid="conversation-turn-1" data-turn="user"><div>what are workers?</div></article>' +
    '<article data-testid="conversation-turn-2" data-turn="assistant"><div>Workers are continuously running processes that listen for jobs.</div></article>' +
    '</main><form><div id="prompt-textarea" contenteditable="true"></div></form></body></html>'
};

// Serves the stand-in embedding model (test/fake-model) the way Hugging Face serves the real one.
const modelServer = createServer((req, res) => {
  const file = here(`./fake-model${decodeURIComponent(new URL(req.url, 'http://x').pathname).replace('/resolve/main', '')}`);
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-expose-headers', 'content-length');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  if (!file.startsWith(here('./fake-model')) || !existsSync(file)) return res.writeHead(404).end();
  const body = readFileSync(file);
  res.writeHead(200, { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream', 'content-length': body.length });
  res.end(req.method === 'HEAD' ? undefined : body);
});
await new Promise((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
const modelHost = `http://127.0.0.1:${modelServer.address().port}/`;

let passed = 0;
const ok = (name) => console.log(`  ok  ${++passed}. ${name}`);

async function openChat(url) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const html = PAGES[req.url()] ?? (SITES[req.url()] && fixture(SITES[req.url()]));
    if (html) req.respond({ status: 200, contentType: 'text/html', body: html });
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

  // --- the main selector finds nothing: second-chance rules, before falling back to the page text ---
  const turns = await openChat('https://chatgpt.com/c/new-markup');
  const second = await getContext('https://chatgpt.com/c/new-markup');
  assert.equal(second.ctx.fallback, false);
  assert.deepEqual(second.ctx.messages.map((m) => m.role), ['user', 'assistant']);
  assert.match(second.ctx.messages[1].text, /continuously running/);
  await turns.close();
  ok('ChatGPT without the role attribute: turns still read as messages, not page text');

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

  // A stand-in for Chrome's built-in model (the real one needs a multi-GB download and a GPU).
  // A stand-in for Chrome's built-in model (the real one needs a multi-GB download and a GPU).
  // It has the real API's shape: a token limit, a token counter, prompt() and promptStreaming().
  const mockNano = (page, status = 'available') =>
    page.evaluateOnNewDocument((status) => {
      window.__nanoCalls = [];
      Object.defineProperty(globalThis, 'LanguageModel', {
        configurable: true,
        value: {
          availability: async () => status,
          params: async () => ({ defaultTopK: 3, maxTopK: 128, defaultTemperature: 1, maxTemperature: 2 }),
          create: async (options) => {
            const call = { system: options.initialPrompts[0].content, initialPrompts: options.initialPrompts, temperature: options.temperature };
            window.__nanoCalls.push(call);
            const used = options.initialPrompts.reduce((n, p) => n + Math.ceil(p.content.length / 3), 0);
            if (used > 9216) throw new DOMException('too big', 'QuotaExceededError');
            return {
              inputQuota: 9216,
              measureInputUsage: async (text) => Math.ceil(text.length / 3),
              // Used by multi-step reading: copy one real sentence, and invent one.
              async prompt(text) {
                call.prompt = text;
                // The router's one-word question (used while the meaning matcher isn't loaded, as here).
                if (text.includes('LOOKUP or EXPLAIN')) return /Question: [^\n]*\b(our|we)\b/i.test(text) ? 'LOOKUP' : 'EXPLAIN';
                const real = text.match(/Section \d+ opens with the marker fact number \d+ about volcanoes\./g);
                return `${real ? real.join("\n") : 'NONE'}\nVolcanoes are made of cheese and cost 5 dollars.`;
              },
              promptStreaming(text) {
                call.prompt = text;
                call.streamed = true;
                // Answers from what it was given, and adds a stray "Sources:" line that code must strip.
                const parts = text.includes('4,200 dollars')
                  ? ['The zebra tour budget ', 'is 4,200 dollars per person.', '\nSources: [message 6]']
                  : ['Photosynthesis ', 'turns light ', 'into sugar.', '\nSources: [message 9]'];
                return new ReadableStream({
                  start(c) {
                    parts.forEach((p) => c.enqueue(p));
                    c.close();
                  }
                });
              },
              destroy() {}
            };
          }
        }
      });
    }, status);
  const answered = (page) => page.evaluate(() => window.__nanoCalls.filter((c) => c.streamed));

  // --- fresh install: no sign-in, no keys -> the free built-in model answers ---
  const fresh = await browser.newPage();
  await fresh.setViewport({ width: 400, height: 860 });
  fresh.on('pageerror', (e) => console.log('  [fresh panel error]', e.message));
  await mockNano(fresh);
  await fresh.setRequestInterception(true);
  fresh.on('request', (req) => (req.url().startsWith('chrome-extension://') ? req.continue() : req.abort()));
  await fresh.goto(`chrome-extension://${extId}/panel/index.html?tabId=${tabId}`);
  await fresh.waitForSelector('select');
  assert.deepEqual(await fresh.$$eval('select option', (els) => els.map((e) => e.textContent)), ['Built-in (free)', 'Smart model (sign in, 3 free)']);
  assert.deepEqual(await fresh.$$eval('.chip-btn', (els) => els.map((e) => e.textContent)), ['Explain the last answer', 'Summarize so far']);
  await fresh.type('textarea', 'What is this chat about?');
  await fresh.keyboard.press('Enter');
  await fresh.waitForFunction(() => document.querySelector('.a .via')?.textContent === 'Built-in (free)', { timeout: 5000 });
  assert.equal(await fresh.$eval('.a .md', (e) => e.textContent.trim()), 'Photosynthesis turns light into sugar.');
  const nanoCall = (await answered(fresh))[0];
  assert.ok(nanoCall.prompt.endsWith('Question: What is this chat about?'));
  assert.equal(nanoCall.initialPrompts[0].role, 'system');
  // The chat is a document in the user turn, never in the system prompt.
  assert.match(nanoCall.prompt, /<conversation_document[^>]*>\n\[User, message 1\]\nHow does photosynthesis work\?/);
  assert.ok(!nanoCall.system.includes('How does photosynthesis work'));
  // "What is this chat about?" is explain mode: the chat as background, never "can't find".
  assert.match(nanoCall.system, /Never claim the conversation says something it does not/);
  assert.ok(nanoCall.temperature <= 0.3, 'low randomness not set');
  // Sources are found by code: the answer's rare words ("light", "sugar") are in message 2.
  assert.deepEqual(await fresh.$$eval('.sources button', (els) => els.map((e) => e.textContent)), ['Assistant, message 2']);
  assert.equal(await fresh.$('.unverified'), null);
  assert.equal(await fresh.$('.general-label'), null); // under 8 words: no label text, sources kept
  ok('fresh install: built-in model answers with no sign-in or key; no second-opinion chip');
  await fresh.screenshot({ path: here('./shot-nano.png') });
  await worker.evaluate(() => chrome.storage.local.remove('threads:chatgpt:/c/abc-123'));
  await fresh.close();

  // --- long chat: only the relevant parts go to the model, fitted to its real token limit ---
  const longPage = await openChat('https://chatgpt.com/c/long-1');
  const longTab = (await getContext('https://chatgpt.com/c/long-1')).tabId;
  const openPanel = async (id, query = '') => {
    const p = await browser.newPage();
    await p.setViewport({ width: 400, height: 860 });
    p.on('pageerror', (e) => console.log('  [panel error]', e.message));
    p.on('console', (m) => m.text().includes('meaning matcher') && console.log('      note:', m.text().slice(0, 160)));
    await mockNano(p);
    await p.setRequestInterception(true);
    p.on('request', (req) => (/^(chrome-extension:|blob:|http:\/\/127\.0\.0\.1)/.test(req.url()) ? req.continue() : req.abort()));
    await p.goto(`chrome-extension://${extId}/panel/index.html?tabId=${id}${query}`);
    await p.waitForSelector('select');
    return p;
  };
  const longPanel = await openPanel(longTab);
  // The long chat starts indexing as soon as it is open; the header may show its progress.
  assert.match(await longPanel.$eval('.reading', (e) => e.textContent), /^ChatGPT36 messages(indexing this chat, \d+%)?$/);
  await longPanel.type('textarea', 'What was our zebra budget?');
  await longPanel.keyboard.press('Enter');
  await longPanel.waitForFunction(() => document.querySelector('.a .via'), { timeout: 20000 });
  const picked = (await answered(longPanel))[0].prompt;
  assert.ok(picked.includes('budget of 4,200 dollars'), 'the old fact was not sent');
  assert.ok(picked.includes('revisit everything on Friday'), 'the newest message was not sent');
  assert.ok(picked.includes('parts of the chat left out') && picked.includes('only the parts most relevant'));
  assert.ok(Math.ceil(picked.length / 3) <= 9216 - 1200, `prompt does not leave room for the answer: ${picked.length} chars`);
  assert.ok(!picked.includes('[User, message 3]') && !picked.includes('[Assistant, message 10]'), 'unrelated old messages were sent');
  assert.deepEqual(await longPanel.$$eval('.sources button', (els) => els.map((e) => e.textContent)).then((l) => l[0]), 'Assistant, message 6');
  await longPanel.evaluate(() => document.querySelector('.sources button').click());
  // The jump lands on the start of that part, inside the 6th message.
  await longPage.waitForFunction(
    () => document.querySelector('.gutter-flash')?.closest('[data-message-author-role]') === document.querySelectorAll('[data-message-author-role]')[5],
    { timeout: 3000 }
  );
  ok('long chat: old matching part + newest part sent, fits the token limit, source is shown and clickable');
  await longPanel.screenshot({ path: here('./shot-sources.png') });
  await longPanel.close();

  // --- meaning matcher: real worker + packaged WebAssembly runtime, with a stand-in model ---
  // "cost" shares no words with the budget sentence; only the embedding can connect them.
  const semPanel = await openPanel(longTab, `&modelHost=${encodeURIComponent(modelHost)}`);
  const notes = [];
  semPanel.on('console', (m) => notes.push(m.text()));
  await semPanel.type('textarea', 'How much did it cost?');
  await semPanel.keyboard.press('Enter');
  await semPanel.waitForFunction(() => document.querySelector('.a .via'), { timeout: 40000 });
  assert.ok(!notes.some((n) => n.includes('meaning matcher unavailable')), `matcher failed: ${notes.find((n) => n.includes('meaning matcher'))}`);
  const sem = (await answered(semPanel))[0].prompt;
  assert.ok(sem.includes('budget of 4,200 dollars'), 'the meaning match was not sent');
  assert.equal(await semPanel.$eval('.sources button', (e) => e.textContent), 'Assistant, message 6');
  const vectorCount = await semPanel.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('gutter', 1);
        open.onsuccess = () => {
          const count = open.result.transaction('vectors').objectStore('vectors').count();
          count.onsuccess = () => resolve(count.result);
        };
      })
  );
  assert.ok(vectorCount >= 10, `only ${vectorCount} vectors saved`); // identical filler chunks share one vector
  ok(`meaning matcher runs in the extension (worker + WebAssembly); ${vectorCount} chunk vectors saved for reuse`);
  await semPanel.close();
  await longPage.close();

  // --- one huge answer: read in parts; invented sentences never reach the final step ---
  const hugePage = await openChat('https://chatgpt.com/c/long-2');
  const hugePanel = await openPanel((await getContext('https://chatgpt.com/c/long-2')).tabId);
  await hugePanel.evaluate(() => [...document.querySelectorAll('.chip-btn')].find((b) => b.textContent === 'Explain the last answer').click());
  await hugePanel.waitForFunction(() => document.querySelector('.a .via'), { timeout: 20000 });
  const steps = await hugePanel.evaluate(() => window.__nanoCalls);
  const reads = steps.filter((c) => !c.streamed);
  const final = steps.find((c) => c.streamed);
  assert.ok(reads.length >= 4 && reads.length <= 10, `${reads.length} parts`);
  assert.ok(reads.every((c) => c.system.includes('Copy each sentence exactly')));
  for (const n of [1, 6, 12]) assert.ok(final.prompt.includes(`marker fact number ${n} about volcanoes`), `section ${n} lost`);
  assert.ok(!final.prompt.includes('cheese'), 'an invented sentence reached the final step');
  assert.ok(!final.system.includes('marker fact'), 'copied chat text is in the system prompt');
  assert.ok(final.prompt.length < 12000);
  ok(`huge answer: read in ${reads.length} parts, real sentences kept, invented ones dropped`);
  await hugePanel.close();
  await hugePage.close();

  // --- side panel with the user's own keys (opened as a tab, pointed at the chat tab) ---
  await worker.evaluate(() =>
    chrome.storage.local.set({
      settings: { keys: { openai: 'sk-test', anthropic: 'sk-ant-test', gemini: '' }, models: {}, choice: 'own:openai' }
    })
  );
  const calls = [];
  const panel = await browser.newPage();
  await panel.setViewport({ width: 400, height: 860 });
  panel.on('pageerror', (e) => console.log('  [panel error]', e.message));
  await mockNano(panel);
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
  await panel.waitForSelector('.reading span');
  assert.equal(await panel.$eval('.reading', (e) => e.textContent), 'ChatGPT4 messages');
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
  await panel.waitForFunction(() => document.querySelector('.a .via'), { timeout: 5000 });
  assert.equal(await panel.$eval('.a .md', (e) => e.textContent.trim()), 'It fixes CO2 into sugar using ATP.');
  assert.equal(await panel.$eval('.a .md strong', (e) => e.textContent), 'fixes CO2');
  assert.equal(await panel.$eval('.a .via', (e) => e.textContent), 'OpenAI (your key)');
  const first = calls[0];
  assert.equal(first.auth, 'Bearer sk-test');
  assert.equal(first.body.messages[0].role, 'system');
  assert.ok(!first.body.messages[0].content.includes('How does photosynthesis work'), 'chat text is in the system prompt');
  assert.equal(first.body.messages.length, 2);
  const turn = first.body.messages[1];
  assert.equal(turn.role, 'user');
  assert.match(turn.content, /\[User, message 1\]\nHow does photosynthesis work\?/);
  assert.match(turn.content, /<highlighted_text>\nThe Calvin cycle/);
  assert.ok(turn.content.endsWith('Question: What does "fixes" mean here?'));
  ok('side question streams back; model got the chat + highlight as context');
  await sleep(2800);
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
  await panel.evaluate(() => document.querySelector('.back').click());
  await panel.waitForSelector('.threads .thread');
  await panel.screenshot({ path: here('./shot-list.png') });
  assert.equal(await panel.$$eval('.threads .thread', (els) => els.length), 1);
  const stored = await worker.evaluate(() => chrome.storage.local.get('threads:chatgpt:/c/abc-123'));
  assert.equal(stored['threads:chatgpt:/c/abc-123'][0].messages.length, 2);
  ok('thread saved locally under this chat');

  await panel.evaluate(() => document.querySelector('.chip-btn.alt').click());
  await panel.waitForFunction(() => document.querySelector('.a .via')?.textContent === 'Claude (your key)', { timeout: 5000 });
  const claudeCall = calls.find((c) => c.provider === 'anthropic');
  assert.equal(claudeCall.key, 'sk-ant-test');
  assert.match(claudeCall.body.messages.at(-1).content, /<highlighted_text>\nInside chloroplasts/);
  ok('Second opinion on a ChatGPT chat is answered by Claude, about the last answer');

  // --- jump to quote ---
  const jumped = await worker.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'gutter:jump', quote: 'The Calvin cycle then fixes' }), tabId);
  assert.equal(jumped.ok, true);
  assert.equal(await chat.$eval('#target', (e) => e.classList.contains('gutter-flash')), true);
  ok('jump-to-source highlights the right paragraph');

  // --- free smart answers used up -> paywall; built-in model still free ---
  await worker.evaluate(() =>
    chrome.storage.local.set({
      auth: { token: 't', email: 'a@example.com' },
      settings: { keys: {}, models: {}, choice: 'hosted:anthropic' }
    })
  );
  const locked = await browser.newPage();
  await locked.setViewport({ width: 400, height: 860 });
  locked.on('pageerror', (e) => console.log('  [locked panel error]', e.message));
  await mockNano(locked);
  await locked.setRequestInterception(true);
  let hostedChats = 0;
  locked.on('request', (req) => {
    const url = req.url();
    const json = (body) => req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(body) });
    if (req.method() === 'OPTIONS') return req.respond({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    if (url.endsWith('/api/ai/providers')) return json({ providers: ['anthropic'], models: {}, plan: 'free', freeLimit: 3, used: 3 });
    if (url.includes('/api/ai/chat')) { hostedChats++; return req.abort(); }
    if (url.includes('/api/threads')) return json({ threads: [], thread: {}, stale: false });
    if (url.startsWith('chrome-extension://')) return req.continue();
    req.abort();
  });
  await locked.goto(`chrome-extension://${extId}/panel/index.html?tabId=${tabId}`);
  await locked.waitForSelector('.paywall', { timeout: 5000 });
  assert.match(await locked.$eval('.paywall b', (e) => e.textContent), /used your 3 free smart answers/);
  await locked.type('textarea', 'One more?');
  assert.equal(await locked.$eval('.send', (e) => e.disabled), true);
  await locked.keyboard.press('Enter');
  await sleep(300);
  assert.equal(hostedChats, 0);
  await locked.screenshot({ path: here('./shot-paywall.png') });
  await locked.evaluate(() => [...document.querySelectorAll('.paywall .btn')].find((b) => b.textContent.includes('built-in')).click());
  await locked.waitForFunction(() => !document.querySelector('.paywall') && document.querySelector('select').value === 'nano');
  await locked.evaluate(() => document.querySelector('.settings-btn').click());
  await locked.waitForSelector('.smart-usage');
  assert.equal(await locked.$eval('.smart-usage', (e) => e.textContent), '3 of 3 free smart answers used.');
  assert.equal(await locked.$eval('.nano-status', (e) => e.dataset.status), 'available');
  await locked.screenshot({ path: here('./shot-settings.png') });
  await locked.close();
  ok('after 3 free smart answers: paywall shown, nothing sent, built-in model still usable');

  // --- no-chat state + settings screen render ---
  const lonely = await browser.newPage();
  await lonely.setViewport({ width: 400, height: 700 });
  await lonely.goto(`chrome-extension://${extId}/panel/index.html?tabId=999999`);
  await lonely.waitForSelector('.gutter-oops');
  await lonely.screenshot({ path: here('./shot-nochat.png') });
  await panel.evaluate(() => document.querySelector('.settings-btn').click());
  await panel.waitForSelector('.settings');
  ok('no-chat and settings screens render');

  console.log(`\n${passed} checks passed`);
} finally {
  await browser.close();
  modelServer.close();
}
