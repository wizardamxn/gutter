// Lookup vs explain (approved 2026-11-17, DECISIONS.md): the hybrid router.
//   1. Semantic: the question's vector against example questions for each route (mean of the 3 closest);
//      lookup only if it wins by at least SEMANTIC.margin.
//   2. Near a tie (|margin| < HYBRID.band), or while the meaning matcher isn't ready: one built-in-model
//      call, one word back.
//   3. Built-in model unavailable too: explain.
// Chat vs general is not decided here: the retrieval floor does that. The bench compares other routers
// (rules, semantic only, Nano only) through setRouterForBench; the product only uses the hybrid.
import { embed as defaultEmbed, embedderFailed, type Embedder } from './embed';
import { routeWithNano } from './nano';
import type { Mode } from './ai';

export type { Mode };
/** `previous`: the previous question in the thread, for follow-ups ("why do we need them?"). */
export type Router = (question: string, previous?: string) => Promise<Mode>;
/** Which way the hybrid decided: logged, and reported by the bench. */
export type RoutePath = 'semantic' | 'nano-tie' | 'nano-not-ready' | 'explain-fallback' | 'fixed' | 'bench';

// ---------- semantic router ----------
/** Example questions per route. The bench's router test set must not contain these. */
export const ROUTER_EXAMPLES: Record<Mode, string[]> = {
  lookup: [
    'What number did you give me for the deposit?',
    'Which framework did we settle on?',
    'What was the address you wrote down?',
    'Who did we say would handle the invoices?',
    'When is the deadline we set?',
    'How many seats did we reserve?',
    'What is the code for the staging server?',
    'What did we name the new project?',
    'Which version did you recommend installing?',
    'What price did we agree on?',
    'What time is the meeting?',
    "What is the contractor's phone number?",
    'Which room is the workshop in?',
    'What was the final score?',
    'What is the login email for the account?',
    'How much does the subscription cost per month?',
    'What date did we pick for the trip?',
    'Who is the contact person at the agency?'
  ],
  explain: [
    'Why would anyone use a message broker?',
    'How does garbage collection work?',
    'Can you explain recursion in simple words?',
    'Give me an example of a race condition.',
    'What are the pros and cons of microservices?',
    'Why is this approach better than the alternative?',
    'How should I think about caching?',
    'What does eventual consistency mean?',
    'Explain that again more simply.',
    'I still do not get it, can you put it another way?',
    'What is the capital of Canada?',
    'How do vaccines train the immune system?',
    'What are some real-world uses of this?',
    'Is it a good idea to use this in production?',
    'Compare REST and GraphQL for me.',
    'What would happen if the server crashed halfway?',
    'Tell me more about how that works.',
    'What should I learn first?',
    // Round 2: the kinds the semantic router got wrong (reworded, so the test sets don't contain them).
    'Who wrote Hamlet?',
    'Who painted the Mona Lisa?',
    'Who are you and what can you do?',
    'Why that number and not another one?'
  ]
};

/** Margin cut-off: lookup must beat explain by at least this much (mean of top-3 cosine), else explain. */
export const SEMANTIC = { margin: 0.03, topK: 3 };

let embedder: Embedder = defaultEmbed;
/** Tests swap in a fake. */
export const setRouterEmbedder = (e: Embedder) => {
  embedder = e;
  exampleVectors = null;
};

const QUESTION_BATCH = 8; // the question worker's job size (embed.ts): keeps the examples off the graphics card
let exampleVectors: Promise<Record<Mode, Float32Array[]> | null> | null = null;

async function embedSmall(texts: string[]): Promise<Float32Array[] | null> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += QUESTION_BATCH) {
    const v = await embedder(texts.slice(i, i + QUESTION_BATCH));
    if (!v) return null;
    out.push(...v);
  }
  return out;
}

const examples = () =>
  (exampleVectors ??= (async () => {
    const lookup = await embedSmall(ROUTER_EXAMPLES.lookup);
    const explain = lookup && (await embedSmall(ROUTER_EXAMPLES.explain));
    return lookup && explain ? { lookup, explain } : null;
  })().catch(() => null));

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
/** Mean of the k highest similarities. */
export const topMean = (v: Float32Array, set: Float32Array[], k = SEMANTIC.topK) => {
  const sims = set.map((x) => dot(v, x)).sort((a, b) => b - a);
  const top = sims.slice(0, k);
  return top.reduce((a, b) => a + b, 0) / Math.max(1, top.length);
};

/** lookup score minus explain score for one question (null: matcher unavailable). */
export async function semanticMargin(question: string): Promise<number | null> {
  const ex = await examples();
  const v = ex && (await embedder([question]))?.[0];
  if (!ex || !v) return null;
  return topMean(v, ex.lookup) - topMean(v, ex.explain);
}


export const HYBRID = { band: 0.03 };
/** How long the router waits for the meaning matcher (first open: the model may still be loading). */
export const ROUTER_WAIT = { ms: 1500 };
export const HYBRID_STATS = { asked: 0, nano: 0 };

const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
/** The built-in model's one-word reply: lookup only if it says so (and not also "explain"). */
export const parseRoute = (word: string): Mode => (/\blookup\b/i.test(word) && !/\bexplain\b/i.test(word) ? 'lookup' : 'explain');

/** The live router. */
export async function hybrid(question: string, previous = ''): Promise<{ mode: Mode; path: RoutePath }> {
  HYBRID_STATS.asked++;
  // Not ready: matcher failed, or still loading (the examples keep embedding in the background for next time).
  const m = embedderFailed() ? null : await within(semanticMargin(question).catch(() => null), ROUTER_WAIT.ms);
  if (m !== null && Math.abs(m) >= HYBRID.band) return { mode: m >= SEMANTIC.margin ? 'lookup' : 'explain', path: 'semantic' };
  HYBRID_STATS.nano++;
  try {
    return { mode: parseRoute(await routeWithNano(question, previous)), path: m === null ? 'nano-not-ready' : 'nano-tie' };
  } catch {
    return { mode: 'explain', path: 'explain-fallback' };
  }
}

let override: Router | null = null;
/** Bench and tests only: route with another router (null: back to the hybrid). */
export const setRouterForBench = (r: Router | null) => (override = r);

/** Mode for one question, and how it was decided. */
export async function chooseMode(question: string, previous = ''): Promise<{ mode: Mode; path: RoutePath }> {
  if (override) return { mode: await override(question, previous), path: 'bench' };
  const d = await hybrid(question, previous);
  console.info(`[Gutter] route: ${d.mode} (${d.path})`);
  return d;
}
