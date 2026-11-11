// End-to-end API test: real Express app, in-memory MongoDB, mocked model provider.
// Run: npm test
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'test-secret-test-secret-test-secret-1234';
process.env.OPENAI_API_KEY = 'sk-test';
process.env.ANTHROPIC_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.FREE_DAILY_LIMIT = '2';
process.env.ADMIN_TOKEN = 'admin-token';
process.env.EXTENSION_ID = '';

const realFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.openai.com/')) {
    upstreamCalls++;
    assert.equal(init.headers.authorization, 'Bearer sk-test');
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"from the gutter"}}]}\n\n' +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  return realFetch(input, init);
}) as typeof fetch;

const mongo = await MongoMemoryServer.create();
await mongoose.connect(mongo.getUri());
const { createApp } = await import('../src/app');
const server = createApp().listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await realFetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* SSE */
  }
  return { status: res.status, json, text, headers: res.headers };
}

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  console.log(`  ok  ${name}`);
}

try {
  let token = '';
  let token2 = '';
  const auth = () => ({ authorization: `Bearer ${token}` });

  await test('signup, duplicate signup, login, wrong password', async () => {
    assert.equal((await call('POST', '/api/auth/signup', { email: 'bad', password: 'x' })).status, 400);
    const s = await call('POST', '/api/auth/signup', { email: 'A@Example.com', password: 'hunter22!' });
    assert.equal(s.status, 201);
    assert.equal(s.json.email, 'a@example.com');
    assert.equal((await call('POST', '/api/auth/signup', { email: 'a@example.com', password: 'hunter22!' })).status, 409);
    assert.equal((await call('POST', '/api/auth/login', { email: 'a@example.com', password: 'wrongpass' })).status, 401);
    // NoSQL-injection style payloads are rejected by validation.
    assert.equal((await call('POST', '/api/auth/login', { email: { $gt: '' }, password: { $gt: '' } })).status, 401);
    const l = await call('POST', '/api/auth/login', { email: 'a@example.com', password: 'hunter22!' });
    assert.equal(l.status, 200);
    token = l.json.token;
    token2 = (await call('POST', '/api/auth/signup', { email: 'b@example.com', password: 'hunter22!' })).json.token;
    assert.equal((await call('GET', '/api/auth/me', undefined, auth())).json.email, 'a@example.com');
  });

  await test('protected routes reject missing or bad tokens', async () => {
    assert.equal((await call('GET', '/api/threads?convKey=x')).status, 401);
    assert.equal((await call('GET', '/api/ai/providers', undefined, { authorization: 'Bearer nope' })).status, 401);
  });

  const thread = {
    convKey: 'chatgpt:/c/abc',
    site: 'chatgpt',
    title: 'What is a gutter?',
    quote: 'the gutter',
    messages: [
      { role: 'user', content: 'What is a gutter?' },
      { role: 'assistant', content: 'The margin.', via: 'OpenAI · Gutter' }
    ],
    createdAt: 1000,
    updatedAt: 2000
  };

  await test('thread sync: create, list, newest wins, per-user isolation, delete marker', async () => {
    const put = await call('PUT', '/api/threads/thread-0001', thread, auth());
    assert.equal(put.status, 200);
    assert.equal(put.json.thread.id, 'thread-0001');

    const list = await call('GET', '/api/threads?convKey=' + encodeURIComponent('chatgpt:/c/abc'), undefined, auth());
    assert.equal(list.json.threads.length, 1);
    assert.deepEqual(list.json.threads[0].messages[1], { role: 'assistant', content: 'The margin.', via: 'OpenAI · Gutter' });

    // An older copy does not overwrite a newer one.
    const stale = await call('PUT', '/api/threads/thread-0001', { ...thread, title: 'old', updatedAt: 1500 }, auth());
    assert.equal(stale.json.stale, true);
    assert.equal(stale.json.thread.title, 'What is a gutter?');

    // Another user can't see it, and gets their own copy under the same id.
    const other = { authorization: `Bearer ${token2}` };
    assert.equal((await call('GET', '/api/threads?convKey=' + encodeURIComponent('chatgpt:/c/abc'), undefined, other)).json.threads.length, 0);
    await call('PUT', '/api/threads/thread-0001', { ...thread, title: 'mine' }, other);
    assert.equal((await call('GET', '/api/threads?convKey=' + encodeURIComponent('chatgpt:/c/abc'), undefined, auth())).json.threads[0].title, 'What is a gutter?');

    // Deleting keeps a marker and drops the content.
    const del = await call('PUT', '/api/threads/thread-0001', { ...thread, updatedAt: 3000, deleted: true }, auth());
    assert.equal(del.json.thread.deleted, true);
    assert.equal(del.json.thread.messages.length, 0);

    assert.equal((await call('PUT', '/api/threads/bad id!', thread, auth())).status, 400);
    assert.equal((await call('PUT', '/api/threads/thread-0002', { ...thread, messages: 'nope' }, auth())).status, 400);
  });

  await test('hosted AI: providers, streaming, daily limit', async () => {
    const info = await call('GET', '/api/ai/providers', undefined, auth());
    assert.deepEqual(info.json.providers, ['openai']);
    assert.equal(info.json.dailyLimit, 2);
    assert.equal(info.json.usedToday, 0);

    const body = { provider: 'openai', system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
    const r1 = await call('POST', '/api/ai/chat', body, auth());
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.ok(r1.text.includes('data: {"t":"Hello "}'));
    assert.ok(r1.text.includes('data: {"t":"from the gutter"}'));
    assert.ok(r1.text.trim().endsWith('data: [DONE]'));

    // A provider with no server key is refused.
    assert.equal((await call('POST', '/api/ai/chat', { ...body, provider: 'anthropic' }, auth())).status, 400);

    assert.equal((await call('POST', '/api/ai/chat', body, auth())).status, 200);
    const r3 = await call('POST', '/api/ai/chat', body, auth());
    assert.equal(r3.status, 429);
    assert.equal(upstreamCalls, 2);
    assert.equal((await call('GET', '/api/ai/providers', undefined, auth())).json.usedToday, 2);
  });

  await test('selector config: default, admin publish, bad token', async () => {
    const d = await call('GET', '/api/config/selectors');
    assert.equal(d.json.version, 1);
    assert.equal(d.json.sites.length, 4);

    const next = { version: 2, sites: [{ ...d.json.sites[0], composer: ['#new-box'] }] };
    assert.equal((await call('PUT', '/api/config/selectors', next, { 'x-admin-token': 'wrong' })).status, 404);
    assert.equal((await call('PUT', '/api/config/selectors', { version: 2, sites: 'x' }, { 'x-admin-token': 'admin-token' })).status, 400);
    assert.equal((await call('PUT', '/api/config/selectors', next, { 'x-admin-token': 'admin-token' })).status, 200);
    const u = await call('GET', '/api/config/selectors');
    assert.equal(u.json.version, 2);
    assert.deepEqual(u.json.sites[0].composer, ['#new-box']);
  });

  await test('CORS: extension origins allowed, websites not', async () => {
    const ext = await realFetch(base + '/health', { headers: { origin: 'chrome-extension://abcdefghijklmnop' } });
    assert.equal(ext.headers.get('access-control-allow-origin'), 'chrome-extension://abcdefghijklmnop');
    const web = await realFetch(base + '/health', { headers: { origin: 'https://evil.example' } });
    assert.equal(web.headers.get('access-control-allow-origin'), null);
  });

  console.log(`\n${passed} test groups passed`);
} finally {
  server.close();
  await mongoose.disconnect();
  await mongo.stop();
}
