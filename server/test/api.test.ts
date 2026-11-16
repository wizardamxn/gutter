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
process.env.FREE_SMART_ANSWERS = '3';
process.env.ADMIN_TOKEN = 'admin-token';
process.env.EXTENSION_ID = '';

const realFetch = globalThis.fetch;
let upstreamCalls = 0;
let upstreamFails = false;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.openai.com/')) {
    upstreamCalls++;
    assert.equal(init.headers.authorization, 'Bearer sk-test');
    if (upstreamFails) return new Response('{"error":{"message":"overloaded"}}', { status: 503 });
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"from the gutter"}}]}\n\n' +
      'data: [DONE]\n\n';
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  // Never reach a real model provider from the tests.
  if (/^https:\/\/(api\.anthropic\.com|generativelanguage\.googleapis\.com)\//.test(url)) throw new Error(`unexpected upstream call: ${url}`);
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
      { role: 'assistant', content: 'The margin.', via: 'OpenAI · Gutter', label: 'mixed' }
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
    assert.deepEqual(list.json.threads[0].messages[1], { role: 'assistant', content: 'The margin.', via: 'OpenAI · Gutter', label: 'mixed' });

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

  await test('smart answers: providers, streaming, free limit, paid plan', async () => {
    const info = await call('GET', '/api/ai/providers', undefined, auth());
    assert.deepEqual(info.json.providers, ['openai']);
    assert.equal(info.json.plan, 'free');
    assert.equal(info.json.freeLimit, 3);
    assert.equal(info.json.used, 0);

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
    assert.equal((await call('POST', '/api/ai/chat', body, auth())).status, 200);
    const r4 = await call('POST', '/api/ai/chat', body, auth());
    assert.equal(r4.status, 402);
    assert.equal(r4.json.code, 'upgrade');
    assert.equal(upstreamCalls, 3);
    assert.equal((await call('GET', '/api/ai/providers', undefined, auth())).json.used, 3);

    // Marking the account paid (by hand, with the admin token) lifts the limit.
    const admin = { 'x-admin-token': 'admin-token' };
    assert.equal((await call('PUT', '/api/admin/plan', { email: 'a@example.com', plan: 'paid' }, { 'x-admin-token': 'wrong' })).status, 404);
    assert.equal((await call('PUT', '/api/admin/plan', { email: 'nobody@example.com', plan: 'paid' }, admin)).status, 404);
    assert.equal((await call('PUT', '/api/admin/plan', { email: 'a@example.com', plan: 'paid' }, admin)).json.plan, 'paid');
    assert.equal((await call('POST', '/api/ai/chat', body, auth())).status, 200);
    assert.equal((await call('GET', '/api/ai/providers', undefined, auth())).json.plan, 'paid');
  });

  const signup = async (email: string) => {
    const t = (await call('POST', '/api/auth/signup', { email, password: 'hunter22!' })).json.token;
    return { authorization: `Bearer ${t}` };
  };
  const chatBody = { provider: 'openai', system: 'sys', messages: [{ role: 'user', content: 'hi' }] };

  await test('10 parallel smart answers from one free account: exactly 3 get through', async () => {
    const h = await signup('parallel@example.com');
    const before = upstreamCalls;
    const all = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/api/ai/chat', chatBody, h)));
    const statuses = all.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 3, `statuses: ${statuses}`);
    assert.equal(statuses.filter((s) => s === 402).length, 7, `statuses: ${statuses}`);
    assert.equal(upstreamCalls - before, 3);
    assert.equal((await call('GET', '/api/ai/providers', undefined, h)).json.used, 3);

    // Marking the account paid lifts the limit.
    const admin = { 'x-admin-token': 'admin-token' };
    assert.equal((await call('PUT', '/api/admin/plan', { email: 'parallel@example.com', plan: 'paid' }, admin)).status, 200);
    assert.equal((await call('POST', '/api/ai/chat', chatBody, h)).status, 200);
  });

  await test('a failed upstream answer does not use up a free answer', async () => {
    const h = await signup('flaky@example.com');
    upstreamFails = true;
    try {
      const r = await call('POST', '/api/ai/chat', chatBody, h);
      assert.equal(r.status, 200); // headers were already streaming; the error arrives as an event
      assert.ok(r.text.includes('"error"'), r.text);
      assert.ok(!r.text.includes('[DONE]'));
    } finally {
      upstreamFails = false;
    }
    assert.equal((await call('GET', '/api/ai/providers', undefined, h)).json.used, 0);
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/ai/chat', chatBody, h)).status, 200);
    assert.equal((await call('POST', '/api/ai/chat', chatBody, h)).status, 402);
  });

  await test('admin endpoint: wrong or missing token gets 404, bad body 400', async () => {
    const body = { email: 'flaky@example.com', plan: 'paid' };
    assert.equal((await call('PUT', '/api/admin/plan', body, { 'x-admin-token': 'admin-tokeN' })).status, 404);
    assert.equal((await call('PUT', '/api/admin/plan', body, { 'x-admin-token': 'admin-token-and-more' })).status, 404);
    assert.equal((await call('PUT', '/api/admin/plan', body)).status, 404);
    assert.equal((await call('PUT', '/api/admin/plan', { email: 'flaky@example.com', plan: 'gold' }, { 'x-admin-token': 'admin-token' })).status, 400);
    // The wrong-token attempts changed nothing.
    const h = { authorization: `Bearer ${(await call('POST', '/api/auth/login', { email: 'flaky@example.com', password: 'hunter22!' })).json.token}` };
    assert.equal((await call('GET', '/api/ai/providers', undefined, h)).json.plan, 'free');
  });

  await test("one user can't read or overwrite another's side notes", async () => {
    const alice = await signup('alice@example.com');
    const mallory = await signup('mallory@example.com');
    const key = encodeURIComponent('claude:/chat/shared');
    const note = { ...thread, convKey: 'claude:/chat/shared', site: 'claude', title: 'alice secret', updatedAt: 5000 };
    assert.equal((await call('PUT', '/api/threads/alice-note-01', note, alice)).status, 200);

    // Same conversation key and the same thread id, newer timestamp, even a delete marker.
    assert.equal((await call('GET', `/api/threads?convKey=${key}`, undefined, mallory)).json.threads.length, 0);
    const hijack = await call('PUT', '/api/threads/alice-note-01', { ...note, title: 'pwned', updatedAt: 9_999_999 }, mallory);
    assert.equal(hijack.status, 200);
    assert.equal(hijack.json.thread.title, 'pwned'); // mallory's own copy
    await call('PUT', '/api/threads/alice-note-01', { ...note, updatedAt: 10_000_000, deleted: true }, mallory);

    const mine = (await call('GET', `/api/threads?convKey=${key}`, undefined, alice)).json.threads;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].title, 'alice secret');
    assert.equal(mine[0].deleted, undefined);
    assert.equal(mine[0].messages.length, 2);
    const theirs = (await call('GET', `/api/threads?convKey=${key}`, undefined, mallory)).json.threads;
    assert.equal(theirs.length, 1);
    assert.equal(theirs[0].deleted, true);
  });

  await test('selector config: default, admin publish, bad token', async () => {
    const d = await call('GET', '/api/config/selectors');
    assert.equal(d.json.version, 2); // shared/selectors.ts (2: ChatGPT second-chance selectors)
    assert.equal(d.json.sites.length, 4);

    const next = { version: 3, sites: [{ ...d.json.sites[0], composer: ['#new-box'] }] };
    assert.equal((await call('PUT', '/api/config/selectors', next, { 'x-admin-token': 'wrong' })).status, 404);
    assert.equal((await call('PUT', '/api/config/selectors', { version: 3, sites: 'x' }, { 'x-admin-token': 'admin-token' })).status, 400);
    assert.equal((await call('PUT', '/api/config/selectors', next, { 'x-admin-token': 'admin-token' })).status, 200);
    const u = await call('GET', '/api/config/selectors');
    assert.equal(u.json.version, 3);
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
