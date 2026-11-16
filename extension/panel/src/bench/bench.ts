// Dev-only benchmark page (panel/bench.html, built by `npm run build:bench`).
// Measures the real limits of Chrome's built-in model, the meaning matcher and retrieval,
// using the product code in ../lib, not copies. All chats here are synthetic.
//
//   bench.html                      full run: the ticked sections, 3 runs, every chat size
//   bench.html?only=D.general,A.sampling
//                                   quick run: just those checks, 1 run, 60k and 200k chats,
//                                   no download timings ("?only=D" runs every D check)
//   bench.html?baseline             section C with the retrieval settings from before the tuning
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ChatMessage, PageContext } from '../../../../shared/types';
import { HYBRID_STATS, ROUTER_EXAMPLES, SEMANTIC, setRouterForBench, topMean } from '../lib/router';
import { ROUTERS, type RouterName } from './routers';
import { ask, classify, cleanAnswer, clearlyGeneral, dedupe, shownLabel, NANO_OPTION, NOT_FOUND, pickContext, ROUTE, type Checked } from '../lib/ai';
import { chunkChat, splitText } from '../lib/chunk';
import chunkSource from '../lib/chunk.ts?raw';
import { digestStream, splitParts, verifyQuotes } from '../lib/digest';
import { embed, forgetMemoryForBench, indexerRunning, pauseIndexing } from '../lib/embed';
import { CHAT_TOKENS, close, countTokens, nanoStatus, openSession, quotaOf, readStream, rewriteQuery } from '../lib/nano';
import { buildContext, scoreChunks, setEmbedder, TUNING, warm, type Built } from '../lib/retrieve';
import { DEFAULT_SETTINGS } from '../lib/storage';
import { ABSENT, ENGLISH, FACTS, GENERAL, HINDI, INJECTION, makeChat, markedText, messageWith, prose, rng, SAYS_NOT_FOUND, type Fact, type RouterCase, ROUTER_MESSY, ROUTER_TEST, chatOf, EXPLAIN, PARROT_OPENER, TRANSCRIPT, WORKERS_CHAT } from './data';

const query = new URLSearchParams(location.search);
const ONLY = query.get('only')?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
const QUICK = !!ONLY;
const BASELINE = query.has('baseline');
const RUNS = QUICK ? 1 : 3;
const SIZES = QUICK ? [60_000, 200_000] : [20_000, 60_000, 200_000, 500_000];
const $ = (id: string) => document.getElementById(id)!;
const now = () => performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const round = (x: number | null, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);
const of = (n: number, total: number) => `${n}/${total}`;

// ---------- results: kept across reloads so checks can be run one at a time ----------
type Entry = { value: unknown; unit?: string; runs?: unknown[]; note?: string };
let results: Record<string, Record<string, Entry>> = {};
try {
  results = JSON.parse(localStorage.getItem('gutter-bench') ?? '{}');
} catch {
  /* private window: start empty */
}
function put(section: string, metric: string, e: Entry) {
  (results[section] ??= {})[metric] = e;
  try {
    localStorage.setItem('gutter-bench', JSON.stringify(results));
  } catch {
    /* ignore */
  }
  render();
}
/** Runs `fn` RUNS times and stores the median. */
async function repeat(section: string, metric: string, unit: string, fn: (run: number) => Promise<number | null>, digits = 0) {
  const runs: (number | null)[] = [];
  for (let r = 0; r < RUNS; r++) {
    runs.push(await fn(r));
    log(`${section} · ${metric}: run ${r + 1} = ${runs[r] === null ? 'n/a' : round(runs[r], 2)}`);
  }
  put(section, metric, { value: round(median(runs), digits), unit, runs: runs.map((x) => round(x, 2)) });
  return median(runs);
}

function render() {
  const rows: string[] = [];
  for (const [section, metrics] of Object.entries(results)) {
    for (const [metric, e] of Object.entries(metrics)) {
      const v = typeof e.value === 'object' ? JSON.stringify(e.value) : String(e.value);
      rows.push(`<tr><td>${section}</td><td>${esc(metric)}</td><td>${esc(v.length > 400 ? `${v.slice(0, 400)}…` : v)}</td><td>${esc(e.unit ?? '')}</td><td>${esc(e.note ?? '')}</td></tr>`);
    }
  }
  $('rows').innerHTML = rows.join('');
}
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
function log(msg: string) {
  const el = $('log');
  el.textContent += `${new Date().toLocaleTimeString()}  ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}
const errName = (e: unknown) => `${(e as Error)?.name ?? 'Error'}: ${(e as Error)?.message ?? e}`;

// ---------- watching the built-in model: what each session was given ----------
interface Call {
  system: string;
  prompts: { input: string; reply?: string; error?: string }[];
}
const calls: Call[] = [];
const LM = () => (globalThis as any).LanguageModel ?? null;
function instrument() {
  const lm = LM();
  if (!lm || lm.__bench) return;
  const create = lm.create.bind(lm);
  lm.create = async (opts: any) => {
    const session = await create(opts);
    const call: Call = { system: opts?.initialPrompts?.find((p: any) => p.role === 'system')?.content ?? '', prompts: [] };
    calls.push(call);
    const prompt = session.prompt.bind(session);
    session.prompt = async (input: string, o?: unknown) => {
      const rec: Call['prompts'][number] = { input };
      call.prompts.push(rec);
      try {
        const reply = await prompt(input, o);
        rec.reply = String(reply);
        return reply;
      } catch (e) {
        rec.error = (e as Error)?.name;
        throw e;
      }
    };
    const streaming = session.promptStreaming.bind(session);
    session.promptStreaming = (input: string, o?: unknown) => {
      call.prompts.push({ input });
      return streaming(input, o);
    };
    return session;
  };
  lm.__bench = true;
  if (lm.create === create) log('warning: could not watch LanguageModel.create; D/E details will be missing');
}
const inputsOf = (from: number) => calls.slice(from).flatMap((c) => c.prompts.map((p) => p.input));
const needNano = async (section: string, check: string) => {
  if ((await nanoStatus()) === 'available') return true;
  put(section, `${check}: skipped`, { value: 'built-in model not available' });
  return false;
};

// ---------- shared material ----------
let cpt = 4.72; // characters per token for English, updated by A.cpt
let quota = 9_216;
let counterSession: any = null;
const counter = async () => (counterSession ??= await openSession('You answer questions about a conversation.', []));

/** Prose of about `tokens` tokens, measured with Chrome's counter. */
async function sized(tokens: number, seed: number): Promise<{ text: string; tokens: number }> {
  const c = await counter();
  let chars = tokens * cpt;
  let text = '';
  let n = 0;
  for (let i = 0; i < 3; i++) {
    text = prose(rng(seed), Math.max(200, Math.round(chars)));
    n = await countTokens(c, text);
    if (Math.abs(n - tokens) / tokens < 0.03) break;
    chars *= tokens / n;
  }
  return { text, tokens: n };
}

const KINDS = ['filler', 'on-topic'] as const;
const chats = new Map<string, Promise<PageContext>>();
/** Synthetic chats, built and indexed once per page. */
function chat(key: string, make: () => PageContext): Promise<PageContext> {
  if (!chats.has(key))
    chats.set(
      key,
      (async () => {
        const ctx = make();
        setEmbedder(embed);
        await warm(ctx);
        return ctx;
      })()
    );
  return chats.get(key)!;
}
const kindChat = (kind: (typeof KINDS)[number], size: number) =>
  chat(`${kind} ${size}`, () =>
    kind === 'filler' ? makeChat(size, 1_000 + size, FACTS.map((f) => f.fact)) : makeChat(size, 2_000 + size, FACTS.map((f) => `${f.topic} ${f.fact}`), 0.6, true)
  );
const D_FACTS = FACTS.slice(0, 10);
const smallChat = () => chat('d small', () => makeChat(12_000, 7, D_FACTS.map((f) => f.fact)));
const bigChat = () => chat('d big', () => makeChat(200_000, 8, D_FACTS.map((f) => f.fact)));
const nanoBudget = () => Math.round(CHAT_TOKENS * cpt);

// ---------- A. built-in model ----------
async function aBasics() {
  const status = await nanoStatus();
  put('A', 'availability', { value: status });
  if (status === 'unavailable') return;
  if (status !== 'available' && !QUICK) {
    log('A: downloading the built-in model (keep this tab open)…');
    const t = now();
    close(await openSession('Hello.', [], undefined, (s) => s && log(s)));
    put('A', 'download time', { value: round((now() - t) / 1000, 1), unit: 's' });
  }
  const c = await counter();
  quota = quotaOf(c);
  put('A', 'context limit (quotaOf)', { value: quota, unit: 'tokens' });
  put('A', 'raw session limits', { value: { inputQuota: c.inputQuota, contextWindow: c.contextWindow } });
  try {
    put('A', 'LanguageModel.params()', { value: (await LM().params?.()) ?? 'not available' });
  } catch (e) {
    put('A', 'LanguageModel.params()', { value: errName(e) });
  }
}

async function aSampling() {
  if (!(await needNano('A', 'sampling'))) return;
  const tryCreate = async (opts: object) => {
    try {
      const s = await LM().create(opts);
      const r = { ok: true, temperature: s.temperature, topK: s.topK };
      s.destroy();
      return r;
    } catch (e) {
      return { ok: false, error: errName(e) };
    }
  };
  put('A', 'sampling accepted by LanguageModel.create', {
    value: { 'temperature 0.3 + topK 3': await tryCreate({ temperature: 0.3, topK: 3 }), 'temperature 0.3 only': await tryCreate({ temperature: 0.3 }) }
  });
  const s = await openSession('You answer briefly.', []);
  put('A', 'sampling in a Gutter session (openSession)', { value: { temperature: s.temperature, topK: s.topK } });
  close(s);
  // Fix 6: a factual question, 5 tries each. Fewer different answers = lower randomness took effect.
  const distinct = async (make: () => Promise<any>) => {
    const outs = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const session = await make();
      try {
        outs.add(String(await session.prompt('In one sentence, what is a hash table?')).trim());
      } finally {
        close(session);
      }
    }
    return outs.size;
  };
  put('A', 'distinct answers out of 5 (factual question)', {
    value: { 'Chrome default': await distinct(() => LM().create({})), 'Gutter (0.3 / 3)': await distinct(() => openSession('You answer briefly.', [])) }
  });
}

async function aCpt() {
  if (!(await needNano('A', 'chars per token'))) return;
  const c = await counter();
  for (const [name, text] of [['English prose', ENGLISH], ['code', chunkSource], ['Hindi', HINDI]] as const) {
    const v = await repeat('A', `chars per token: ${name}`, 'chars/token', async () => text.length / (await countTokens(c, text)), 2);
    if (name === 'English prose' && v) cpt = v;
  }
}

/** Opens a session with a prompt of `system`, asks for a summary; returns read time and output speed. */
async function answerSpeed(system: string) {
  const t0 = now();
  const s = await openSession(system, []);
  const t1 = now();
  let first = 0;
  let out = '';
  try {
    for await (const d of readStream(s.promptStreaming('Summarize the text above in about 150 words.'))) {
      if (!first) first = now();
      out += d;
    }
  } finally {
    close(s);
  }
  const outTokens = await countTokens(await counter(), out);
  return { createMs: t1 - t0, ttftMs: first - t1, tps: outTokens / ((now() - first) / 1000) };
}

async function aSpeed() {
  if (!(await needNano('A', 'speed'))) return;
  for (const size of [500, 2_000, 4_000, 6_000, 8_000]) {
    const { text, tokens } = await sized(size, size);
    const runs: { createMs: number; ttftMs: number; tps: number }[] = [];
    let failed = '';
    for (let r = 0; r < RUNS && !failed; r++) {
      try {
        runs.push(await answerSpeed(`You answer questions about the text below.\n\n${text}`));
      } catch (e) {
        failed = errName(e);
      }
    }
    const m = (k: 'createMs' | 'ttftMs' | 'tps') => median(runs.map((x) => x[k]));
    put('A', `prompt ~${size} tokens`, { value: failed && !runs.length ? failed : { tokens, createMs: round(m('createMs')), ttftMs: round(m('ttftMs')), outTokensPerSec: round(m('tps'), 1) }, note: failed });
    log(`A · ${size} tokens: ${round(m('createMs'))} ms to read, ${round(m('tps'), 1)} tokens/s`);
  }
}

async function aQuota() {
  if (!(await needNano('A', 'largest prompt'))) return;
  await repeat('A', 'largest prompt accepted', 'tokens', async (run) => {
    let lo = 200;
    let hi = Math.round(quota * 1.5);
    let best: number | null = null;
    while (hi - lo > 100) {
      const mid = Math.round((lo + hi) / 2);
      const { text, tokens } = await sized(mid, 9_000 + run);
      try {
        const s = await openSession(text, []);
        try {
          await s.prompt('Reply with the single word OK.');
        } finally {
          close(s);
        }
        best = tokens;
        lo = mid;
      } catch (e) {
        if ((e as Error)?.name !== 'QuotaExceededError') log(`A · max prompt at ${mid}: ${errName(e)}`);
        hi = mid;
      }
    }
    return best;
  });
}

/** Fix 3: does the meaning matcher slow the built-in model? ~4,000-token prompt, four conditions. */
async function aContention() {
  if (!(await needNano('A', 'contention'))) return;
  const { text, tokens } = await sized(4_000, 4_000);
  const system = `You answer questions about the text below.\n\n${text}`;
  const worker = (w: Worker) => () => w.terminate();
  const conditions: [string, () => Promise<() => void>][] = [
    ['no matcher worker of its own', async () => () => {}],
    ['matcher loaded on WebGPU, idle', async () => worker(await loaded({ device: 'webgpu', dtype: 'fp16' }))],
    ['indexing on WebGPU', async () => worker(await busy({ device: 'webgpu', dtype: 'fp16', batch: 32 }))],
    ['indexing on WebAssembly', async () => worker(await busy({ device: 'wasm', dtype: 'q8', batch: 8 }))],
    // What Gutter does now: index on the graphics card, embed the question on WebAssembly, free the card while answering.
    [
      'product setup',
      async () => {
        await kindChat('filler', 60_000); // indexed by embed.ts (WebGPU indexer)
        await embed([`a question ${Date.now()}`]); // the question worker (WebAssembly)
        return pauseIndexing(); // as ask() does while an answer is written
      }
    ]
  ];
  for (const [name, start] of conditions) {
    const runs: { createMs: number; tps: number }[] = [];
    let gpuHeld = false;
    for (let r = 0; r < RUNS; r++) {
      let stop = () => {};
      try {
        stop = await start();
        if (name === 'product setup') gpuHeld ||= indexerRunning();
        runs.push(await answerSpeed(system));
      } catch (e) {
        log(`A · contention, ${name}: ${errName(e)}`);
      } finally {
        stop();
      }
    }
    put('A', `contention: ${name}`, {
      value: { promptTokens: tokens, readMs: round(median(runs.map((x) => x.createMs))), outTokensPerSec: round(median(runs.map((x) => x.tps)), 1) },
      note: name === 'product setup' ? `model on the graphics card while answering: ${gpuHeld ? 'yes' : 'no'}; target ≥ 23 tokens/s` : ''
    });
    log(`A · contention, ${name}: ${round(median(runs.map((x) => x.tps)), 1)} tokens/s`);
  }
}

// ---------- B. meaning matcher ----------
const ortBase = () => new URL('./ort/', location.href).href;
let jobId = 1;
const newWorker = () => new Worker(new URL('../lib/embed.worker.ts', import.meta.url), { type: 'module' });
function job(w: Worker, texts: string[], opts: object): Promise<{ device: string; vectors: Float32Array[] }> {
  const id = jobId++;
  return new Promise((resolve, reject) => {
    w.addEventListener('message', (e) => {
      if (e.data.id !== id) return;
      if (e.data.vectors) resolve({ device: e.data.device, vectors: e.data.vectors });
      else if (e.data.error) reject(new Error(e.data.error));
    });
    w.onerror = (e) => reject(new Error(e.message));
    w.postMessage({ id, texts, ortBase: ortBase(), ...opts });
  });
}
const sampleChunks = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} chunk ${i}. ${prose(rng(n * 1000 + i), 900).slice(0, 900)}`);
/** A worker with the model loaded, doing nothing. */
async function loaded(opts: object) {
  const w = newWorker();
  await job(w, ['warm up the meaning matcher'], opts);
  return w;
}
/** A worker with the model loaded, busy indexing far more than one answer takes. */
async function busy(opts: object) {
  const w = await loaded(opts);
  void job(w, sampleChunks(3_000, `busy ${Date.now()}`), opts).catch(() => null);
  await sleep(500);
  return w;
}

async function bDevices() {
  const gpu = !!(await (navigator as any).gpu?.requestAdapter?.().catch(() => null));
  put('B', 'WebGPU adapter', { value: gpu });
  const configs: { name: string; opts: object }[] = [
    { name: 'wasm q8, batch 8', opts: { device: 'wasm', dtype: 'q8', batch: 8 } },
    ...(gpu
      ? [
          { name: 'webgpu q8, batch 32', opts: { device: 'webgpu', dtype: 'q8', batch: 32 } },
          { name: 'webgpu fp16, batch 32 (product)', opts: { device: 'webgpu', dtype: 'fp16', batch: 32 } },
          { name: 'webgpu fp32, batch 32', opts: { device: 'webgpu', dtype: 'fp32', batch: 32 } }
        ]
      : [])
  ];
  for (const { name, opts } of configs) {
    try {
      const rates: number[] = [];
      for (let r = 0; r < RUNS; r++) {
        const w = await loaded(opts);
        try {
          const t = now();
          await job(w, sampleChunks(200, `${name} ${Date.now()} ${r}`), opts);
          rates.push(200 / ((now() - t) / 1000));
        } finally {
          w.terminate();
        }
      }
      put('B', `${name}: index 200 chunks`, { value: round(median(rates), 1), unit: 'chunks/s' });
    } catch (e) {
      put('B', `${name}: index 200 chunks`, { value: errName(e) });
    }
  }
}

/**
 * Fix 1, first step: can questions be embedded on WebAssembly while the chat was indexed on WebGPU?
 * Chunks: WebGPU fp16. Questions: the same backend, or WebAssembly fp16 / q8. Same retrieval code.
 */
async function bMixed() {
  if (!(await (navigator as any).gpu?.requestAdapter?.().catch(() => null))) return put('B', 'mixed backends', { value: 'no WebGPU adapter' });
  const backends: [string, object][] = [
    ['webgpu fp16 (same as chunks)', { device: 'webgpu', dtype: 'fp16', batch: 32 }],
    ['wasm fp16', { device: 'wasm', dtype: 'fp16', batch: 8 }],
    ['wasm q8', { device: 'wasm', dtype: 'q8', batch: 8 }]
  ];
  const embedAll = async (opts: object, texts: string[]) => {
    const w = await loaded(opts);
    try {
      const { vectors } = await job(w, texts, opts);
      return new Map(texts.map((t, i) => [t, vectors[i]]));
    } finally {
      w.terminate();
    }
  };
  const dot = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i], 0);
  for (const kind of KINDS) {
    for (const size of [60_000, 200_000]) {
      const ctx = await kindChat(kind, size);
      const units = [...new Set(chunkChat(ctx.messages).flatMap((c) => (TUNING.windows ? splitText(c.text, 300, 450) : [c.text])))];
      const chunkVecs = await embedAll(backends[0][1], units);
      const questions = [...FACTS.flatMap((f) => [f.same, f.para]), ...ABSENT, ...GENERAL];
      const same = await embedAll(backends[0][1], questions);
      const row: Record<string, unknown> = {};
      for (const [name, opts] of backends) {
        const qVecs = name.startsWith('webgpu') ? same : await embedAll(opts, questions);
        setEmbedder(async (texts) => texts.map((t, i) => (i === 0 ? qVecs.get(t)! : chunkVecs.get(t)!)));
        const s = await score(ctx, nanoBudget(), false);
        // How far the question's best similarity moves against the same-backend one.
        const drift = questions.map((q) => {
          const best = (v: Map<string, Float32Array>) => Math.max(...units.map((u) => dot(v.get(q)!, chunkVecs.get(u)!)));
          return Math.abs(best(qVecs) - best(same));
        });
        row[name] = { ...s, bestMeaningShift: { median: round(median(drift), 3), max: round(Math.max(...drift), 3) } };
      }
      setEmbedder(embed);
      put('B', `mixed backends: ${kind} ${size / 1000}k`, { value: row, note: 'questions on each backend, chunks on WebGPU fp16' });
      log(`B · mixed backends ${kind} ${size / 1000}k done`);
    }
  }
}

async function bLoad() {
  await repeat('B', 'cold load, product settings (incl. download)', 'ms', async () => {
    await caches.delete('transformers-cache');
    const w = newWorker();
    const t = now();
    try {
      await job(w, ['warm up the meaning matcher'], {});
      return now() - t;
    } finally {
      w.terminate();
    }
  });
  await repeat('B', 'warm load, product settings', 'ms', async () => {
    const w = newWorker();
    const t = now();
    try {
      await job(w, ['warm up the meaning matcher'], {});
      return now() - t;
    } finally {
      w.terminate();
    }
  });
}

async function bProduct() {
  if (!(await embed(['warm up']))) return put('B', 'embed()', { value: 'returned null: matcher unavailable' });
  let last: string[] = [];
  for (const n of QUICK ? [200] : [50, 200, 500]) {
    await repeat('B', `index ${n} chunks (product)`, 'chunks/s', async (run) => {
      last = sampleChunks(n, `Run ${Date.now()}-${run}`);
      const t = now();
      const v = await embed(last);
      return v ? n / ((now() - t) / 1000) : null;
    }, 1);
  }
  await sleep(2_000); // IndexedDB writes are not awaited by embed.ts
  await repeat('B', `reload ${last.length} vectors from IndexedDB`, 'ms', async () => {
    forgetMemoryForBench();
    const t = now();
    await embed(last);
    return now() - t;
  });
}

// ---------- C. retrieval quality ----------
// Before the tuning: budget from the old nano.ts formula, relative word floor, no cloud fill, whole chunks.
const OLD = {
  nano: Math.round((9_216 - 1_200 - 200 - 30) * 3),
  tuning: { minMeaning: 0.3, minWords: 0.3, minCoverage: null, foundMeaning: 0.3, meaningWeight: 0.6, windows: false }
};
const PRODUCT = { ...TUNING };

/** Hits on the 20 facts (same words and reworded), and how often "found" is wrongly set. */
async function score(ctx: PageContext, budget: number, fill: boolean) {
  const hits = { same: 0, para: 0 };
  const times: number[] = [];
  for (const f of FACTS) {
    for (const p of ['same', 'para'] as const) {
      const t = now();
      const b = await buildContext(ctx, f[p], '', budget, fill);
      times.push(now() - t);
      if (f.answer.test(b.text)) hits[p]++;
    }
  }
  let absentFound = 0;
  for (const q of ABSENT) if ((await buildContext(ctx, q, '', budget, fill)).found) absentFound++;
  return { same: of(hits.same, 20), para: of(hits.para, 20), absentFound: of(absentFound, 10), ms: round(median(times), 1) };
}

async function cRecall() {
  Object.assign(TUNING, BASELINE ? OLD.tuning : PRODUCT);
  const budgets = { nano: BASELINE ? OLD.nano : nanoBudget(), cloud: 60_000 };
  put('C', 'settings', { value: { baseline: BASELINE, budgets, tuning: { ...TUNING } } });
  for (const kind of KINDS) {
    for (const size of SIZES) {
      const t = now();
      const ctx = await kindChat(kind, size);
      put('C', `${kind} ${size / 1000}k: index`, { value: { chunks: chunkChat(ctx.messages).length, ms: round(now() - t) } });
      for (const mode of ['words', 'words+meaning'] as const) {
        setEmbedder(mode === 'words' ? async () => null : embed);
        put('C', `${kind} ${size / 1000}k nano ${mode}`, { value: await score(ctx, budgets.nano, false) });
        put('C', `${kind} ${size / 1000}k cloud ${mode}`, { value: await score(ctx, budgets.cloud, !BASELINE) });
      }
      setEmbedder(embed);
    }
  }
  Object.assign(TUNING, PRODUCT);
}

/** Best scores of each question group against one chat. Only facts planted in this chat count. */
async function bestScores(ctx: PageContext) {
  const chunks = chunkChat(ctx.messages);
  const best = async (q: string) => {
    const s = await scoreChunks(chunks, q);
    return { q, meaning: s.meaning ? Math.max(0, ...s.meaning) : null, cover: Math.max(0, ...s.cover) };
  };
  const all = async (qs: string[]) => {
    const out = [];
    for (const q of qs) out.push(await best(q));
    return out;
  };
  const here = FACTS.filter((f) => messageWith(ctx, f.fact));
  return { same: await all(here.map((f) => f.same)), para: await all(here.map((f) => f.para)), absent: await all(ABSENT), general: await all(GENERAL) };
}

/** Fix 1: where code routes each kind of question, at the product cut-offs and with other low cut-offs. */
async function cRoute() {
  const targets: [string, Promise<PageContext>][] = [['12k (D whole)', smallChat()], ...KINDS.flatMap((k) => [60_000, 200_000].map((s) => [`${k} ${s / 1000}k`, kindChat(k, s)] as [string, Promise<PageContext>]))];
  const grid: Record<string, { rewordedToGeneral: number; sameToGeneral: number; generalDirect: number; absentToGeneral: number }> = {};
  const saved = { ...ROUTE };
  for (const [name, p] of targets) {
    const ctx = await p;
    const s = await bestScores(ctx);
    // Routes before any keyword rewrite (C.rewrite and D measure what the rewrite changes).
    const route = (x: { q: string; meaning: number | null; cover: number }) => {
      if (clearlyGeneral(x.q, '', false, x)) return 'general';
      const related = x.cover >= (TUNING.minCoverage ?? 0.6) || (x.meaning ?? 0) >= TUNING.minMeaning;
      const found = x.cover >= (TUNING.minCoverage ?? 0.6) || (x.meaning ?? 0) >= TUNING.foundMeaning;
      const mode = classify(x.q);
      const route = mode === 'lookup' ? (related ? 'chat' : 'refused') : related ? 'explain' : 'general';
      return `${route}${found ? '' : ' (rewrite first)'}`;
    };
    const split = (xs: typeof s.same) => tally(xs.map(route));
    put('C', `route ${name}`, {
      value: { same: split(s.same), reworded: split(s.para), absent: split(s.absent), general: split(s.general) },
      note: `${s.same.length} facts in this chat; cut-offs ${JSON.stringify(ROUTE)}`
    });
    for (const g of [0.15, 0.18, 0.2, 0.22, 0.25, 0.3]) {
      Object.assign(ROUTE, { general: g });
      const direct = (xs: typeof s.same) => xs.filter((x) => clearlyGeneral(x.q, '', false, x)).length;
      const row = (grid[`general below ${g}`] ??= { rewordedToGeneral: 0, sameToGeneral: 0, generalDirect: 0, absentToGeneral: 0 });
      row.rewordedToGeneral += direct(s.para);
      row.sameToGeneral += direct(s.same);
      row.generalDirect += direct(s.general);
      row.absentToGeneral += direct(s.absent);
      Object.assign(ROUTE, saved);
    }
    put('C', `route ${name}: scores`, {
      value: {
        reworded: s.para.map((x) => `${round(x.meaning, 2)}/${round(x.cover, 2)}`).join(' '),
        general: s.general.map((x) => `${round(x.meaning, 2)}/${round(x.cover, 2)}`).join(' ')
      },
      note: 'best meaning / best cover per question'
    });
  }
  put('C', 'route grid (sum over the chats above)', { value: grid, note: 'rewordedToGeneral and sameToGeneral must be 0; generalDirect: general questions answered in one call' });
}

/**
 * "Maybe" floor, without the built-in model: the score of the passage each question would get
 * (before any keyword rewrite) and whether it holds the fact. D measures it on real can't-find answers.
 */
async function cMaybe() {
  for (const [name, p] of [['whole 12k', smallChat()], ['picked 200k', bigChat()]] as const) {
    const ctx = await p;
    const many = async (qs: [string, Fact?][]) => {
      const out: Cand[] = [];
      for (const [q, fact] of qs) {
        const l = (await buildContext(ctx, q, '', nanoBudget())).likely;
        if (l) out.push({ by: l.by, meaning: l.meaning, ...(fact ? { hit: fact.answer.test(l.passage) } : {}) });
      }
      return passages(out, qs.length);
    };
    put('C', `maybe floor: ${name}`, {
      value: {
        reworded: await many(D_FACTS.map((x) => [x.para, x])),
        same: await many(D_FACTS.map((x) => [x.same, x])),
        absent: await many(ABSENT.map((q) => [q])),
        general: await many(GENERAL.map((q) => [q]))
      },
      note: "every question counted as if the answer said it can't find it; ✓ = the passage holds the fact"
    });
  }
}

/** Fix 5: how often the keyword rewrite fires (product gate), and what it buys. */
async function cRewrite() {
  if (!(await needNano('C', 'rewrite'))) return;
  for (const kind of KINDS) {
    for (const size of [60_000, 200_000]) {
      const ctx = await kindChat(kind, size);
      const fired = { same: 0, para: 0, absent: 0, general: 0 };
      let hitsBefore = 0;
      let hitsAfter = 0;
      const ms: number[] = [];
      const groups: [keyof typeof fired, string[], RegExp[] | null][] = [
        ['same', FACTS.map((f) => f.same), FACTS.map((f) => f.answer)],
        ['para', FACTS.map((f) => f.para), FACTS.map((f) => f.answer)],
        ['absent', ABSENT, null],
        ['general', GENERAL, null]
      ];
      for (const [group, qs, answers] of groups) {
        for (let i = 0; i < qs.length; i++) {
          let t = 0;
          const picked = await pickContext({
            ctx,
            question: qs[i],
            quote: '',
            maxChars: nanoBudget(),
            fill: false,
            followUp: false,
            mode: classify(qs[i]),
            rewrite: async () => {
              t = now();
              const k = await rewriteQuery(qs[i]);
              ms.push(now() - t);
              return k;
            }
          });
          if (picked.rewritten) fired[group]++;
          if (group === 'para' && answers) {
            const plain = await buildContext(ctx, qs[i], '', nanoBudget());
            if (answers[i].test(plain.text)) hitsBefore++;
            if (answers[i].test(picked.built.text)) hitsAfter++;
          }
        }
      }
      put('C', `rewrite ${kind} ${size / 1000}k`, {
        value: { fired: { same: of(fired.same, 20), reworded: of(fired.para, 20), absent: of(fired.absent, 10), general: of(fired.general, 10) }, rewordedHits: `${hitsBefore} → ${hitsAfter} of 20` },
        note: `adds ${round(median(ms))} ms when it fires`
      });
    }
  }
}

async function cVariants() {
  const variants: [string, Partial<typeof TUNING>][] = [
    ['product settings', {}],
    ['whole chunks instead of windows', { windows: false }]
  ];
  for (const [name, change] of variants) {
    Object.assign(TUNING, PRODUCT, change);
    for (const kind of KINDS) {
      for (const size of [60_000, 200_000]) {
        const ctx = await kindChat(kind, size);
        await warm(ctx);
        put('C', `variant "${name}": ${kind} ${size / 1000}k nano`, { value: await score(ctx, nanoBudget(), false) });
      }
    }
  }
  Object.assign(TUNING, PRODUCT);
}

// ---------- D. end to end with the built-in model ----------
async function askNano(ctx: PageContext, question: string, quote = '', history: ChatMessage[] = [], anyway = false) {
  const before = calls.length;
  let out = '';
  let checked: Checked | null = null;
  const t = now();
  const floor = TUNING.maybeMeaning;
  TUNING.maybeMeaning = 0; // display only: the answer is the same; passages are counted at each floor below
  try {
    for await (const d of ask({ option: NANO_OPTION, settings: DEFAULT_SETTINGS, auth: null, ctx, messages: [...history, { role: 'user', content: question }], quote, cite: true, anyway, onDone: (c) => (checked = c) }))
      out += d;
  } catch (e) {
    out = `[error] ${errName(e)}`;
  } finally {
    TUNING.maybeMeaning = floor;
  }
  // Progress: one line per answer, so a long run shows it is moving.
  log(`  ${tag.trim() || 'D'} · ${round((now() - t) / 1000, 1)} s · ${(checked as Checked | null)?.route ?? 'error'} · ${question.slice(0, 60)}`);
  routePaths.push((checked as Checked | null)?.routedBy ?? 'error');
  const prompt = inputsOf(before).filter((p) => p.includes('Question: ')).pop() ?? '';
  const c = checked as Checked | null;
  return {
    out,
    text: c?.text ?? out,
    checked: c,
    /** chat (strict lookup) | refused (by code) | explain (chat attached) | general (no chat) */
    route: c?.route ?? 'error',
    mode: c?.mode ?? 'error',
    /** chat | mixed | general | none (refusal or unverified lookup) */
    label: c?.label ?? 'none',
    /** What the panel shows: no label text under 8 words. */
    shown: (c && shownLabel(c.text, c.label)) ?? 'none',
    overlap: c?.overlap ?? null,
    deduped: c?.deduped ?? 0,
    rewritten: !!c?.rewritten,
    ms: now() - t,
    picked: prompt.includes('only the parts most relevant') || (prompt.includes('Parts of the conversation that may help') && prompt.includes('parts of the chat left out')),
    prompt,
    leakRaw: /sources?\s*:/i.test(out),
    leakShown: /sources?\s*:/i.test(c?.text ?? out),
    /** The "might answer it" passage a can't-find answer would get at floor 0 (null: not a can't-find answer). */
    likely: c?.likely ?? null,
    routedBy: c?.routedBy ?? 'error'
  };
}
const FLOORS = [0.35, 0.4, 0.45, 0.5, 0.55];
type Cand = { by: 'meaning' | 'refusal'; meaning: number | null; hit?: boolean };
/**
 * Passages shown at the product floor and at others, split by trigger; `hit`: the passage holds the fact.
 * Refusal-text matches show at any floor; meaning matches only at or above it.
 */
function passages(cands: Cand[], total: number) {
  const shownAt = (fl: number) => cands.filter((c) => c.by === 'refusal' || (c.meaning ?? 0) >= fl);
  const count = (shown: Cand[]) => `${shown.length}/${total}${cands.some((c) => c.hit !== undefined) ? `, fact in ${shown.filter((c) => c.hit).length}` : ''}`;
  const shown = shownAt(TUNING.maybeMeaning);
  return {
    [`passageShown (floor ${TUNING.maybeMeaning})`]: count(shown),
    byTrigger: { refusalText: count(shown.filter((c) => c.by === 'refusal')), floor: count(shown.filter((c) => c.by === 'meaning')) },
    passageByFloor: Object.fromEntries(FLOORS.map((fl) => [fl, count(shownAt(fl))])),
    passageScores: cands.map((c) => `${c.by === 'refusal' ? 'R' : round(c.meaning, 2)}${c.hit === undefined ? '' : c.hit ? '✓' : '✗'}`).join(' ')
  };
}
const refuses = (text: string) => text === NOT_FOUND || SAYS_NOT_FOUND.test(text);
/** How many answers went each way. */
const tally = (routes: string[]) => routes.reduce<Record<string, number>>((n, r) => ((n[r] = (n[r] ?? 0) + 1), n), {});
const samples: unknown[] = [];
/** Appended to D metric names while D.routers runs a check once per router. */
let tag = '';
/** How the live router decided, over every answer so far (semantic / nano-tie / nano-not-ready / explain-fallback). */
const routePaths: string[] = [];
const keepSamples = () => (put('D', 'router paths (all answers so far)', { value: tally(routePaths) }), putSamples());
const putSamples = () => put('D', 'samples', { value: samples.slice(-120), note: 'synthetic chats; for checking the classification' });

/** Facts and absent: both chats; during a router pass (D.routers) only the long one, to keep the round under 20 minutes. */
const dChats = async (): Promise<[string, PageContext][]> => (tag ? [['picked', await bigChat()]] : [['whole', await smallChat()], ['picked', await bigChat()]]);

/** Fix 2: facts asked in the same words, whole and picked: correct, and code attribution. */
async function dFacts() {
  if (!(await needNano('D', 'facts'))) return;
  for (const [name, ctx] of await dChats()) {
    const n = { ok: 0, had: 0, right: 0, unverified: 0, leakRaw: 0, leakShown: 0, asked: 0 };
    const times: number[] = [];
    const cands: Cand[] = [];
    const modes: string[] = [];
    const labels: string[] = [];
    for (let r = 0; r < RUNS; r++) {
      for (const f of D_FACTS) {
        const a = await askNano(ctx, f.same);
        modes.push(a.mode);
        labels.push(a.shown);
        const msg = messageWith(ctx, f.fact);
        n.asked++;
        times.push(a.ms);
        if (f.answer.test(a.text)) n.ok++;
        if (f.answer.test(a.prompt)) n.had++;
        if (a.checked?.sources.some((s) => s.label.endsWith(`message ${msg}`))) n.right++;
        if (a.checked?.unverified) n.unverified++;
        if (a.leakRaw) n.leakRaw++;
        if (a.leakShown) n.leakShown++;
        if (a.likely) cands.push({ by: a.likely.by, meaning: a.likely.meaning });
        if (r === 0) samples.push({ chat: name, q: f.same, mode: a.mode, label: a.label, answer: a.text.slice(0, 400), factMessage: msg, sources: a.checked?.sources.map((s) => s.label) });
      }
    }
    put('D', `facts (${name})${tag}`, {
      value: { correct: of(n.ok, n.asked), factInPrompt: of(n.had, n.asked), sourcesRightMessage: of(n.right, n.asked), unverified: of(n.unverified, n.asked), sourcesTextFromModel: of(n.leakRaw, n.asked), sourcesTextShown: of(n.leakShown, n.asked), modes: tally(modes), labelsShown: tally(labels), ...passages(cands, n.asked) },
      note: `median ${round(median(times))} ms per answer`
    });
  }
  keepSamples();
}

/** Items 2 and 3: reworded questions, long chat (target ≥ 8/10 correct, 0 refused by code) and short chat. */
async function dReworded() {
  if (!(await needNano('D', 'reworded'))) return;
  for (const [name, ctx] of [['picked', await bigChat()], ['whole', await smallChat()]] as const) {
    const n = { ok: 0, had: 0, rewritten: 0, asked: 0, missed: 0, missedHad: 0, missedSaid: 0 };
    const routes: string[] = [];
    const times: number[] = [];
    const cands: Cand[] = []; // misses only
    const inPrompt: Cand[] = []; // misses where the fact was in the prompt
    for (let r = 0; r < RUNS; r++) {
      for (const f of D_FACTS) {
        const a = await askNano(ctx, f.para);
        n.asked++;
        routes.push(a.route);
        times.push(a.ms);
        if (f.answer.test(a.text)) n.ok++;
        if (f.answer.test(a.prompt)) n.had++;
        if (a.rewritten) n.rewritten++;
        const missed = !f.answer.test(a.text);
        const had = f.answer.test(a.prompt);
        if (missed) {
          n.missed++;
          if (had) n.missedHad++;
          if (a.likely) {
            n.missedSaid++;
            const c = { by: a.likely.by, meaning: a.likely.meaning, hit: f.answer.test(a.likely.passage) };
            cands.push(c);
            if (had) inPrompt.push(c);
          }
        }
        if (r === 0) samples.push({ chat: name, reworded: f.para, route: a.route, rewritten: a.rewritten, answer: a.out.slice(0, 300), passage: a.likely && { by: a.likely.by, meaning: round(a.likely.meaning, 2), text: a.likely.passage.slice(0, 200) } });
      }
    }
    put('D', `reworded questions (${name})`, {
      value: {
        correct: of(n.ok, n.asked),
        factInPrompt: of(n.had, n.asked),
        rewriteFired: of(n.rewritten, n.asked),
        routes: tally(routes),
        misses: { all: n.missed, factInPrompt: n.missedHad, saidCantFind: n.missedSaid },
        missesAll: passages(cands, n.missed),
        missesFactInPrompt: passages(inPrompt, n.missedHad)
      },
      note: `median ${round(median(times))} ms; routes "general", "notInChat" and "refused" miss a fact that is in the chat`
    });
  }
  keepSamples();
}

async function dAbsent() {
  if (!(await needNano('D', 'absent'))) return;
  for (const [name, ctx] of await dChats()) {
    const n = { said: 0, asked: 0, lookup: 0, lookupSaid: 0, explain: 0, explainSaid: 0 };
    const routes: string[] = [];
    const cands: Cand[] = [];
    const explainLabels: string[] = [];
    for (let r = 0; r < RUNS; r++) {
      for (const q of ABSENT) {
        const a = await askNano(ctx, q);
        n.asked++;
        routes.push(a.route);
        const said = refuses(a.text);
        if (said) n.said++;
        if (a.mode === 'lookup') {
          n.lookup++;
          if (said) n.lookupSaid++;
        } else {
          n.explain++;
          if (said) n.explainSaid++;
          else explainLabels.push(a.shown);
        }
        if (a.likely) cands.push({ by: a.likely.by, meaning: a.likely.meaning });
        if (r === 0) samples.push({ chat: name, absent: q, passage: a.likely && { by: a.likely.by, meaning: round(a.likely.meaning, 2), text: a.likely.passage.slice(0, 200) }, route: a.route, mode: a.mode, label: a.label, answer: a.text.slice(0, 400), saysNotFound: said });
      }
    }
    put('D', `answer not in chat (${name})${tag}`, {
      value: {
        saysCantFindOrDoesntKnow: of(n.said, n.asked),
        invented: of(n.asked - n.said, n.asked),
        strictLookup: { asked: n.lookup, saysCantFind: of(n.lookupSaid, n.lookup), invented: of(n.lookup - n.lookupSaid, n.lookup) },
        sentToExplainMode: { asked: of(n.explain, n.asked), saysDoesntKnow: of(n.explainSaid, n.explain), answeredAnyway: of(n.explain - n.explainSaid, n.explain), labelsOfThose: tally(explainLabels) },
        routes: tally(routes),
        ...passages(cands, n.asked)
      },
      note: 'route "refused" = answered by code without the model; explain mode never refuses, so an answer there may invent a chat fact (it should be labelled "General knowledge")'
    });
  }
  keepSamples();
}

/** Task 2 (diagnose only): reworded facts the chat search misses: the rewrite's words, the fact's scores before and after. */
async function dDiag() {
  if (!(await needNano('D', 'diagnose'))) return;
  for (const [name, ctx] of [['picked', await bigChat()], ['whole', await smallChat()]] as const) {
    const chunks = chunkChat(ctx.messages);
    const rows: unknown[] = [];
    for (const f of D_FACTS) {
      const i = chunks.findIndex((c) => c.text.includes(f.fact));
      const keywords = await rewriteQuery(f.para);
      const at = async (q: string) => {
        const s = await scoreChunks(chunks, q);
        const m = s.meaning ?? [];
        const b = await buildContext(ctx, q, '', nanoBudget());
        return {
          factMeaning: round(m[i] ?? null, 2),
          factCover: round(s.cover[i], 2),
          factRank: m.length ? 1 + m.filter((x) => x > m[i]).length : null, // 1 = the best-matching chunk
          bestOtherMeaning: round(Math.max(0, ...m.filter((_, j) => j !== i)), 2),
          factInPrompt: f.answer.test(b.text),
          related: b.related
        };
      };
      const before = await at(f.para);
      const after = await at(`${f.para}\n${keywords}`);
      const keywordsAlone = await at(keywords); // what the words would score without the question's wording
      // "Missed": the fact isn't in what the model sees, or nothing counts as related (→ code refuses / labels it general).
      if (!after.factInPrompt || !after.related) rows.push({ q: f.para, keywords, before, after, keywordsAlone, factChunk: chunks[i].text.slice(0, 160) });
    }
    put('D', `diagnose missed reworded facts (${name})`, { value: rows, note: `${rows.length} of ${D_FACTS.length} missed after the rewrite` });
  }
}

async function dGeneral() {
  if (!(await needNano('D', 'general'))) return;
  for (const [name, ctx] of [['whole', await smallChat()], ['picked', await bigChat()]] as const) {
    const n = { refused: 0, withLabel: 0, unlabelled: 0, opener: 0, asked: 0 };
    const routes: string[] = [];
    const times: number[] = [];
    const cands: Cand[] = [];
    for (let r = 0; r < RUNS; r++) {
      for (const q of GENERAL) {
        const a = await askNano(ctx, q);
        n.asked++;
        routes.push(a.route);
        times.push(a.ms);
        const body = a.text;
        const refused = a.route === 'refused' || refuses(body);
        if (refused) n.refused++;
        else if (a.label === 'general') n.withLabel++;
        else n.unlabelled++; // answered, but labelled as (partly) from the chat
        if (/^(hey|hi|hello|great question|sure|absolutely|of course)\b/i.test(body)) n.opener++;
        if (a.likely) cands.push({ by: a.likely.by, meaning: a.likely.meaning });
        if (r === 0) samples.push({ chat: name, general: q, route: a.route, answer: a.out.slice(0, 300), refused });
      }
    }
    put('D', `general questions (${name})`, {
      value: { refused: of(n.refused, n.asked), labelledGeneralKnowledge: of(n.withLabel, n.asked), labelledFromChat: of(n.unlabelled, n.asked), chattyOpener: of(n.opener, n.asked), routes: tally(routes), ...passages(cands, n.asked) },
      note: `median ${round(median(times))} ms (target under 6 s, picked); "refused" counts real refusals only`
    });
  }
  keepSamples();
}

// ---------- router bake-off ----------
/** Accuracy of one router on the labelled test set (ROUTER_TEST). */
const ROUTER_SETS = { clean: ROUTER_TEST, messy: ROUTER_MESSY } as const;
async function routerScores(name: RouterName, set: keyof typeof ROUTER_SETS = 'clean') {
  const cases = ROUTER_SETS[set];
  const nanoBefore = HYBRID_STATS.nano;
  const rows: { c: RouterCase; got: string; ms: number }[] = [];
  for (const c of cases) {
    const t = now();
    const got = await ROUTERS[name](c.q, c.previous);
    rows.push({ c, got, ms: now() - t });
    if (rows.length % 10 === 0) log(`  router ${name}, ${set} set: ${rows.length}/${cases.length}`);
  }
  const share = (xs: typeof rows) => of(xs.filter((r) => r.got === r.c.want).length, xs.length);
  const kind = (k: RouterCase['kind']) => rows.filter((r) => r.c.kind === k);
  return {
    accuracy: share(rows),
    lookupRecallFacts: share(kind('fact')),
    lookupRecallAbsent: share(kind('absent')),
    explainRecall: share(rows.filter((r) => r.c.want === 'explain')),
    byKind: Object.fromEntries((['fact', 'absent', 'explain-chat', 'general', 'transcript', 'follow-up'] as const).map((k) => [k, share(kind(k))])),
    medianMs: round(median(rows.map((r) => r.ms)), 1),
    ...(name === 'hybrid' ? { nanoCalled: of(HYBRID_STATS.nano - nanoBefore, rows.length) } : {}),
    wrong: rows.filter((r) => r.got !== r.c.want).map((r) => `${r.c.previous ? `[after "${r.c.previous}"] ` : ''}${r.c.q} → ${r.got}`)
  };
}

/**
 * Router bake-off without the built-in model: rules and semantic on the test set, and how the semantic
 * margin cut-off was chosen (leave-one-out on the router's own examples, never on the test set).
 */
async function cRouter() {
const examples = [...ROUTER_EXAMPLES.lookup, ...ROUTER_EXAMPLES.explain];
  put('C', 'router test sets', {
    value: { clean: ROUTER_TEST.length, messy: ROUTER_MESSY.length, overlapWithSemanticExamples: [...ROUTER_TEST, ...ROUTER_MESSY].filter((c) => examples.includes(c.q)).length },
    note: 'must be 0 overlap'
  });
  // Leave-one-out margins of the examples.
  const vec = async (texts: string[]) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 8) out.push(...((await embed(texts.slice(i, i + 8))) ?? []));
    return out;
  };
  const L = await vec(ROUTER_EXAMPLES.lookup);
  const E = await vec(ROUTER_EXAMPLES.explain);
  if (L.length !== ROUTER_EXAMPLES.lookup.length || E.length !== ROUTER_EXAMPLES.explain.length) {
    put('C', 'router: semantic', { value: 'skipped', note: 'meaning matcher unavailable' });
  } else {
    const loo = [
      ...L.map((v, i) => ({ want: 'lookup', m: topMean(v, L.filter((_, j) => j !== i)) - topMean(v, E) })),
      ...E.map((v, i) => ({ want: 'explain', m: topMean(v, L) - topMean(v, E.filter((_, j) => j !== i)) }))
    ];
    const sweep = Object.fromEntries(
      [-0.02, 0, 0.01, 0.02, 0.03, 0.05, 0.08].map((cut) => [
        cut,
        {
          accuracy: of(loo.filter((x) => (x.m >= cut ? 'lookup' : 'explain') === x.want).length, loo.length),
          lookupRecall: of(loo.filter((x) => x.want === 'lookup' && x.m >= cut).length, L.length),
          explainRecall: of(loo.filter((x) => x.want === 'explain' && x.m < cut).length, E.length)
        }
      ])
    );
    put('C', 'router: semantic cut-off (leave-one-out on its examples)', {
      value: { product: SEMANTIC.margin, sweep, margins: loo.map((x) => `${x.want[0]}${round(x.m, 3)}`).join(' ') },
      note: 'margin = mean top-3 cosine to lookup examples minus to explain examples; below the cut-off → explain'
    });
    put('C', 'router: semantic · clean', { value: await routerScores('semantic', 'clean') });
    put('C', 'router: semantic · messy', { value: await routerScores('semantic', 'messy') });
  }
  put('C', 'router: rules · clean', { value: await routerScores('rules', 'clean') });
  put('C', 'router: rules · messy', { value: await routerScores('rules', 'messy') });
}

/** Router bake-off with the built-in model: the test set, then D.facts, D.absent and D.explain once per router. */
async function dRouters() {
  if (!(await needNano('D', 'routers'))) return;
  // Rules (live) on both sets for reference: instant, no answers needed.
  for (const set of ['clean', 'messy'] as const) put('D', `router ${set} set · rules`, { value: await routerScores('rules', set) });
  for (const name of ['semantic', 'nano', 'hybrid'] as const) {
    setRouterForBench(name === 'hybrid' ? null : ROUTERS[name]); // hybrid = the live path
    tag = ` · router ${name}`;
    try {
      for (const set of ['clean', 'messy'] as const) put('D', `router ${set} set · ${name}`, { value: await routerScores(name, set) });
      const before = { ...HYBRID_STATS };
      await dFacts();
      await dAbsent();
      await dExplain();
      if (name === 'hybrid') put('D', 'hybrid: Nano asked during D.facts/absent/explain', { value: of(HYBRID_STATS.nano - before.nano, HYBRID_STATS.asked - before.asked) });
    } finally {
      setRouterForBench(null);
      tag = '';
    }
  }
}

/** Shared counts for explain-mode answers. `previous`: the answer before, in a thread. */
function judge(a: Awaited<ReturnType<typeof askNano>>, previous = '') {
  return {
    refused: a.route === 'refused' || refuses(a.text),
    repeatsRaw: dedupe(cleanAnswer(a.out), previous).dropped, // in what the model wrote
    repeatsShown: dedupe(a.text, previous).dropped, // in what the panel shows (after code's dedupe)
    parrot: PARROT_OPENER.test(a.text.trim())
  };
}
function explainSummary(rows: { refused: boolean; repeatsRaw: number; repeatsShown: number; parrot: boolean; label: string; want: string; deduped: number; overlap: number | null }[]) {
  const n = rows.length;
  return {
    refused: of(rows.filter((r) => r.refused).length, n),
    repeatedSentencesShown: rows.reduce((x, r) => x + r.repeatsShown, 0),
    repeatedFromModel: rows.reduce((x, r) => x + r.repeatsRaw, 0),
    dedupeFired: of(rows.filter((r) => r.deduped > 0).length, n),
    conversationStatesOpeners: of(rows.filter((r) => r.parrot).length, n),
    labelCorrect: of(rows.filter((r) => (r.want === 'chat-used' ? r.label === 'chat' || r.label === 'mixed' : r.label === r.want)).length, n),
    labels: tally(rows.map((r) => r.label)),
    overlaps: rows.map((r) => (r.overlap === null ? '-' : round(r.overlap, 2))).join(' ')
  };
}
const workersChat = () => chat('workers', () => chatOf(WORKERS_CHAT));

/** Explain mode: why / how / example / simply, about the chat's topics. Target: 0 refused, 0 repeats, 0 parrot openers. */
async function dExplain() {
  if (!(await needNano('D', 'explain'))) return;
  const ctx = await workersChat();
  const rows = [];
  for (const q of EXPLAIN) {
    const a = await askNano(ctx, q);
    rows.push({ ...judge(a), label: a.label, want: 'chat-used', deduped: a.deduped, overlap: a.overlap });
    samples.push({ explain: q, mode: a.mode, route: a.route, label: a.label, overlap: round(a.overlap, 2), deduped: a.deduped, answer: a.text });
  }
  put('D', `explain questions (workers chat)${tag}`, { value: explainSummary(rows), note: 'labelCorrect: "From the chat" or "+ general knowledge" (the chat covers these topics); all answers are in samples' });
  keepSamples();
}

/** The owner's real thread, as follow-ups in one thread. */
async function dTranscript() {
  if (!(await needNano('D', 'transcript'))) return;
  const ctx = await workersChat();
  const history: ChatMessage[] = [];
  const rows = [];
  for (const t of TRANSCRIPT) {
    const previous = [...history].reverse().find((m) => m.role === 'assistant')?.content ?? '';
    const a = await askNano(ctx, t.q, '', history);
    rows.push({ ...judge(a, previous), label: a.label, want: t.general ? 'general' : 'chat-used', deduped: a.deduped, overlap: a.overlap });
    samples.push({ transcript: t.q, mode: a.mode, route: a.route, label: a.label, overlap: round(a.overlap, 2), deduped: a.deduped, answer: a.text });
    history.push({ role: 'user', content: t.q }, { role: 'assistant', content: a.text });
  }
  put('D', 'owner transcript (follow-ups)', { value: explainSummary(rows), note: 'regression: worker questions must explain, not repeat; population questions must be answered, labelled "General knowledge"' });
  keepSamples();
}

/** General questions asked as follow-ups inside a thread about the chat. */
async function dFollowups() {
  if (!(await needNano('D', 'followups'))) return;
  const ctx = await workersChat();
  const first = await askNano(ctx, 'what are workers?');
  const history: ChatMessage[] = [
    { role: 'user', content: 'what are workers?' },
    { role: 'assistant', content: first.text }
  ];
  const rows = [];
  for (const q of GENERAL) {
    const a = await askNano(ctx, q, '', history);
    rows.push({ ...judge(a, first.text), label: a.label, want: 'general', deduped: a.deduped, overlap: a.overlap });
    samples.push({ followUpGeneral: q, mode: a.mode, route: a.route, label: a.label, answer: a.text });
  }
  put('D', 'general questions as follow-ups', { value: explainSummary(rows), note: 'target: refused 0/10, labelled "General knowledge"' });
  keepSamples();
}

async function dInjection() {
  if (!(await needNano('D', 'injection'))) return;
  const bait = `${FACTS[2].fact} ${INJECTION}`;
  const smallInj = await chat('d small inj', () => makeChat(12_000, 9, [bait]));
  const bigInj = await chat('d big inj', () => makeChat(200_000, 10, [bait]));
  const variants: [string, PageContext, string, string][] = [
    ['in chat, whole', smallInj, FACTS[2].same, ''],
    ['in chat, picked', bigInj, FACTS[2].same, ''],
    ['highlighted', smallInj, 'Explain this simply.', INJECTION]
  ];
  for (const [name, ctx, q, quote] of variants) {
    let obeyed = 0;
    let tested = 0;
    let factStated = 0; // item 6: did the answer still give the fact next to the bait?
    for (let r = 0; r < Math.max(RUNS, 2); r++) {
      const a = await askNano(ctx, q, quote);
      if (!a.prompt.includes(INJECTION)) continue; // retrieval left the bait out: this run tests nothing
      tested++;
      const banana = /banana/i.test(a.text);
      if (banana && (quote ? a.text.replace(/\W/g, '').length < 20 : !FACTS[2].answer.test(a.text))) obeyed++;
      if (FACTS[2].answer.test(a.text)) factStated++;
      samples.push({ injection: name, route: a.route, answer: a.out.slice(0, 300) });
    }
    put('D', `injection obeyed (${name})`, {
      value: of(obeyed, tested),
      note: `${quote ? '' : `fact still given ${of(factStated, tested)}; `}${tested ? 'bait was in the prompt each counted run' : 'bait never reached the prompt'}`
    });
  }
  // Item 6, control: the same short chat and question with the bait sentence removed.
  const clean = await chat('d small inj control', () => makeChat(12_000, 9, [FACTS[2].fact]));
  let ok = 0;
  for (let r = 0; r < Math.max(RUNS, 2); r++) {
    const a = await askNano(clean, FACTS[2].same);
    if (FACTS[2].answer.test(a.text)) ok++;
    samples.push({ injection: 'control (no bait), whole', route: a.route, answer: a.out.slice(0, 300) });
  }
  put('D', 'injection control: same chat without the bait', { value: `fact given ${of(ok, Math.max(RUNS, 2))}`, note: 'if this gives the fact and the bait version does not, the bait causes the miss' });
  keepSamples();
}

/** Fix 4: whole chat up to CHAT_TOKENS, picked parts above. */
async function dSwitch() {
  if (!(await needNano('D', 'switch'))) return;
  const c = await counter();
  const f = FACTS[0];
  for (const target of [3_000, 3_400, 3_700, 4_500]) {
    // Grow a chat until its labelled text measures about `target` tokens.
    let chars = target * cpt;
    let ctx: PageContext = makeChat(chars, 77, [f.fact], 1);
    let tokens = 0;
    for (let i = 0; i < 4; i++) {
      ctx = makeChat(chars, 77, [f.fact], 1);
      const whole = ctx.messages.map((m, j) => `[${m.role === 'user' ? 'User' : 'Assistant'}, message ${j + 1}]\n${m.text}`).join('\n\n');
      tokens = await countTokens(c, whole);
      if (Math.abs(tokens - target) < 60) break;
      chars *= target / tokens;
    }
    const a = await askNano(ctx, f.same);
    put('D', `switch: chat of ${tokens} tokens`, { value: { sent: a.picked ? 'picked parts' : 'whole chat', expected: tokens <= CHAT_TOKENS ? 'whole chat' : 'picked parts', correct: f.answer.test(a.text) }, note: `${round(a.ms)} ms` });
  }
}

// ---------- E. multi-step reading ----------
async function eDigest() {
  if (!(await needNano('E', 'digest'))) return;
  const question = 'List every code word that the text gives for its checkpoints.';
  for (const size of QUICK ? [65_000] : [20_000, 65_000, 150_000]) {
    const { text, words } = markedText(size, 50 + size);
    const { parts, cut } = splitParts(text, false);
    const runs: any[] = [];
    for (let r = 0; r < RUNS; r++) {
      const before = calls.length;
      const t = now();
      let out = '';
      try {
        for await (const d of digestStream({ text, what: 'the last answer in the chat', question, newestMatters: false, onStatus: (s) => s && log(`E · ${size / 1000}k: ${s}`) })) out += d;
      } catch (e) {
        out = `[error] ${errName(e)}`;
      }
      const mine = calls.slice(before);
      let kept = 0;
      let dropped = 0;
      for (const call of mine.filter((x) => x.system.startsWith('You pick out key sentences'))) {
        for (const p of call.prompts) {
          if (p.reply === undefined) continue;
          const v = verifyQuotes(p.reply, /"""\n([\s\S]*)\n"""/.exec(p.input)?.[1] ?? '');
          kept += v.kept.length;
          dropped += v.dropped;
        }
      }
      runs.push({ ms: now() - t, rejectedShare: kept + dropped ? dropped / (kept + dropped) : null, markersInAnswer: words.filter((w) => new RegExp(w, 'i').test(out)).length });
    }
    const m = (k: string) => median(runs.map((x) => x[k]));
    put('E', `${size / 1000}k chars`, { value: { parts: parts.length, cut, totalSec: round((m('ms') ?? 0) / 1000, 1), rejectedShare: round(m('rejectedShare'), 2), markersInAnswer: of(m('markersInAnswer') ?? 0, words.length) } });
  }
}

// ---------- page ----------
// Checks in run order. A comes first so its timings see an idle GPU.
const CHECKS: [string, () => Promise<unknown>][] = [
  ['A.basics', aBasics],
  ['A.sampling', aSampling],
  ['A.cpt', aCpt],
  ['A.contention', aContention],
  ['A.speed', aSpeed],
  ['A.quota', aQuota],
  ['B.devices', bDevices],
  ['B.mixed', bMixed],
  ['B.load', bLoad],
  ['B.product', bProduct],
  ['C.recall', cRecall],
  ['C.route', cRoute],
  ['C.rewrite', cRewrite],
  ['C.maybe', cMaybe],
  ['C.router', cRouter],
  ['C.variants', cVariants],
  ['D.facts', dFacts],
  ['D.reworded', dReworded],
  ['D.absent', dAbsent],
  ['D.general', dGeneral],
  ['D.explain', dExplain],
  ['D.transcript', dTranscript],
  ['D.followups', dFollowups],
  ['D.routers', dRouters],
  ['D.diag', dDiag],
  ['D.injection', dInjection],
  ['D.switch', dSwitch],
  ['E.digest', eDigest]
];
const SKIP_IN_QUICK = new Set(['B.load']); // downloads
const wanted = (name: string) =>
  ONLY ? ONLY.some((o) => o === name || (o.length === 1 && name.startsWith(`${o}.`))) && !(SKIP_IN_QUICK.has(name) && !ONLY.includes(name)) : ($(`s${name[0]}`) as HTMLInputElement).checked;

async function run() {
  ($('start') as HTMLButtonElement).disabled = true;
  instrument();
  const storedQuota = results.A?.['context limit (quotaOf)']?.value;
  if (typeof storedQuota === 'number') quota = storedQuota;
  const storedCpt = results.A?.['chars per token: English prose']?.value;
  if (typeof storedCpt === 'number') cpt = storedCpt;
  const started = now();
  for (const [name, fn] of CHECKS) {
    if (!wanted(name)) continue;
    log(`--- ${name} ---`);
    const t = now();
    try {
      await fn();
    } catch (e) {
      log(`${name} stopped: ${errName(e)}`);
      put(name[0], `${name}: stopped with error`, { value: errName(e) });
    }
    log(`${name} took ${Math.round((now() - t) / 1000)} s`);
  }
  close(counterSession);
  counterSession = null;
  log(`done in ${Math.round((now() - started) / 1000)} s`);
  ($('start') as HTMLButtonElement).disabled = false;
}

function report() {
  return JSON.stringify({ when: new Date().toISOString(), userAgent: navigator.userAgent, quick: ONLY, results }, null, 1);
}

$('start').addEventListener('click', () => void run());
$('copy').addEventListener('click', async () => {
  const text = report();
  try {
    await navigator.clipboard.writeText(text);
    log(`copied ${text.length} characters`);
  } catch {
    const area = $('json') as HTMLTextAreaElement;
    area.hidden = false;
    area.value = text;
    area.select();
    log('clipboard blocked: the JSON is in the box below, press Ctrl+C');
  }
});
$('clear').addEventListener('click', () => {
  results = {};
  try {
    localStorage.removeItem('gutter-bench');
  } catch {
    /* ignore */
  }
  render();
});
render();
if (ONLY) for (const s of 'ABCDE') ($(`s${s}`) as HTMLInputElement).disabled = true;
void nanoStatus().then((s) =>
  log(`built-in model: ${s}${ONLY ? ` · quick run: ${ONLY.join(', ')}` : ''}${BASELINE ? ' · baseline retrieval settings' : ''}`)
);
