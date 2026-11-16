// Main-thread side of the meaning matcher: caching, and talking to the workers.
// Everything here is optional. If the model can't load (offline, blocked, old
// machine), `embed` returns null and retrieval falls back to word matching alone.
//
// Two workers (decision 2026-11-16, see DECISIONS.md):
//   indexer   bulk jobs (a whole chat): WebGPU when there is a graphics card. It is shut down as soon
//             as it is idle, and right away while an answer is written: even an idle model on the
//             graphics card slowed the built-in model from 26.5 to 9.7 tokens a second (bench A).
//   questions small jobs (a question): WebAssembly, the same fp16 model file as the indexer, so no
//             extra download; its vectors score within 0.001 of WebGPU's (bench B.mixed).
import { hash } from './chunk';

export type Embedder = (texts: string[]) => Promise<Float32Array[] | null>;

const memory = new Map<string, Float32Array>();
let failed = false;
let nextId = 1;
const waiting = new Map<number, { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void; worker: Worker }>();

const QUESTION_JOB_MAX = 8; // texts; a question needs 1–2, a chat step 64
const INDEXER_IDLE_MS = 1500; // between background steps the indexer stays; after that it is shut down

/** Share of a chat indexed so far (0..1), or null when no indexing is running. One listener: the panel. */
let onProgress: ((share: number | null) => void) | null = null;
export const watchIndexing = (fn: typeof onProgress) => (onProgress = fn);
export const reportIndexing = (share: number | null) => onProgress?.(share);

// ---- Background indexing waits while an answer is being written ----
let holds = 0;
let resumers: (() => void)[] = [];
/** Holds background indexing, and frees the graphics card, until the returned release is called. */
export function pauseIndexing(): () => void {
  holds++;
  stopIndexerIfIdle();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holds === 0) for (const r of resumers.splice(0)) r();
  };
}
/** Resolves when background indexing may run. */
export const indexingGate = (): Promise<void> => (holds ? new Promise((r) => resumers.push(r)) : Promise.resolve());

// ---- IndexedDB: vectors survive closing the panel, so a chat is only indexed once ----
function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('gutter', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('vectors');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function loadStored(keys: string[]): Promise<void> {
  try {
    const store = (await db()).transaction('vectors').objectStore('vectors');
    await Promise.all(
      keys.map(
        (key) =>
          new Promise<void>((resolve) => {
            const get = store.get(key);
            get.onsuccess = () => {
              if (get.result instanceof Float32Array) memory.set(key, get.result);
              resolve();
            };
            get.onerror = () => resolve();
          })
      )
    );
  } catch {
    /* storage unavailable: keep everything in memory */
  }
}

async function store(entries: [string, Float32Array][]): Promise<void> {
  try {
    const tx = (await db()).transaction('vectors', 'readwrite');
    for (const [key, vector] of entries) tx.objectStore('vectors').put(vector, key);
  } catch {
    /* ignore */
  }
}

/** The e2e test serves a stand-in model from this machine. Nothing but localhost is accepted. */
function testModelHost(): string | undefined {
  const host = new URLSearchParams(location.search).get('modelHost') ?? '';
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+\/$/.test(host) ? host : undefined;
}

// ---- The two workers ----
let indexer: Worker | null = null;
let questions: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const busy = (w: Worker | null) => !!w && [...waiting.values()].some((p) => p.worker === w);

function spawn(): Worker {
  const w = new Worker(new URL('./embed.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (event: MessageEvent<{ id: number; vectors?: Float32Array[]; error?: string }>) => {
    const { id, vectors, error } = event.data;
    const pending = waiting.get(id);
    if (!pending || (!vectors && !error)) return; // progress message
    waiting.delete(id);
    if (vectors) pending.resolve(vectors);
    else pending.reject(new Error(error));
    if (w === indexer) afterIndexerJob();
  };
  w.onerror = () => {
    for (const [id, p] of waiting) {
      if (p.worker !== w) continue;
      waiting.delete(id);
      p.reject(new Error('embedding worker crashed'));
    }
  };
  return w;
}

function stopIndexerIfIdle() {
  if (!indexer || busy(indexer)) return;
  clearTimeout(idleTimer);
  indexer.terminate(); // frees the graphics card
  indexer = null;
}
function afterIndexerJob() {
  clearTimeout(idleTimer);
  if (holds) stopIndexerIfIdle(); // an answer is being written: free the graphics card now
  else idleTimer = setTimeout(stopIndexerIfIdle, INDEXER_IDLE_MS);
}

/** Does this browser have a graphics card for WebGPU? Decides which model file the question worker uses. */
let gpu: Promise<boolean> | null = null;
const hasGpu = () =>
  (gpu ??= (async () => {
    try {
      return !!(await (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu?.requestAdapter());
    } catch {
      return false;
    }
  })());

async function run(texts: string[]): Promise<Float32Array[]> {
  const forQuestion = texts.length <= QUESTION_JOB_MAX;
  // Questions: WebAssembly, with the model file the indexer uses (fp16 on graphics-card machines, else q8).
  const opts = forQuestion ? { device: 'wasm', dtype: (await hasGpu()) ? 'fp16' : 'q8' } : {};
  const w = forQuestion ? (questions ??= spawn()) : (indexer ??= spawn());
  if (!forQuestion) clearTimeout(idleTimer);
  const id = nextId++;
  return new Promise<Float32Array[]>((resolve, reject) => {
    waiting.set(id, { resolve, reject, worker: w });
    w.postMessage({ id, texts, ortBase: new URL('./ort/', location.href).href, modelHost: testModelHost(), ...opts });
  });
}

async function embedNow(texts: string[]): Promise<Float32Array[] | null> {
  if (failed || typeof Worker === 'undefined' || typeof indexedDB === 'undefined') return null;
  const keys = texts.map(hash);
  const unknown = keys.filter((k) => !memory.has(k));
  if (unknown.length) await loadStored([...new Set(unknown)]);

  const missing = [...new Set(keys.filter((k) => !memory.has(k)))];
  if (missing.length) {
    const missingTexts = missing.map((k) => texts[keys.indexOf(k)]);
    try {
      const vectors = await run(missingTexts);
      const fresh = missing.map((k, i) => [k, vectors[i]] as [string, Float32Array]);
      for (const [k, v] of fresh) memory.set(k, v);
      void store(fresh);
    } catch (err) {
      // Don't retry on every question: word matching carries on alone until the panel reopens.
      failed = true;
      console.warn('[Gutter] meaning matcher unavailable, using word matching only:', err);
      return null;
    }
  }
  return keys.map((k) => memory.get(k)!);
}

// One request at a time: background indexing and a question often want the same chunks,
// and the second request then finds them already cached.
let queue: Promise<unknown> = Promise.resolve();

/** Vectors for these texts (cached where possible), or null if the matcher is unavailable. */
export const embed: Embedder = (texts) => {
  const job = queue.then(() => embedNow(texts));
  queue = job.catch(() => null);
  return job;
};

export const embedderFailed = () => failed;
/** Bench page: is a model loaded on the graphics card right now? */
export const indexerRunning = () => !!indexer;

/** Bench page only: forget the in-memory vectors so the next call reads them back from IndexedDB. */
export const forgetMemoryForBench = () => memory.clear();
