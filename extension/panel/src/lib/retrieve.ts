// Decides which parts of the chat the model gets to see.
//
//   chat fits the budget  -> send all of it
//   chat is too long      -> always: the highlighted passage and its surroundings,
//                                    and the most recent part of the chat
//                            then:   the best-matching chunks, scored by shared words
//                                    (keyword.ts) and by meaning (embed.ts)
//
// Every chat is scored, whole or not: ai.ts routes the question on the best scores.
// One model call answers from the result, however long the chat is.
import type { PageContext } from '../../../../shared/types';
import { chunkChat, norm, roleName, splitText, trimMiddle, type Chunk } from './chunk';
import { embed as defaultEmbed, indexingGate, reportIndexing, type Embedder } from './embed';
import { keywordCoverage, keywordScores } from './keyword';

/** A part of the chat the answer was based on; clicking it jumps to that spot. */
export interface Source {
  label: string;
  snippet: string;
}

/** One piece of chat text that went into the prompt. */
export interface Sent {
  /** 1-based message number. */
  msg: number;
  text: string;
  source: Source;
}

export interface Likely {
  /** What found it: closeness in meaning (over the "maybe" floor), or terms the refusal names (ai.ts). */
  by: 'meaning' | 'refusal';
  /** Meaning score; null when found by the refusal's terms. */
  meaning: number | null;
  passage: string;
  source: Source;
}

export interface Built {
  /** Labelled chat text, ready to put in the prompt. */
  text: string;
  /** 'full' = the whole chat was sent. 'picked' = only selected parts. */
  mode: 'full' | 'picked' | 'none';
  /** Whether anything in the chat clearly matched the question (by scores, whole chat or not). */
  found: boolean;
  /** Whether any chunk passed even the picking floor. If not, nothing in the chat is about the question. */
  related: boolean;
  /** Best scores of any chunk: meaning (null if the matcher is unavailable) and word coverage. */
  best: { meaning: number | null; cover: number };
  /** The pieces of chat text in the prompt, for attributing an answer to them. */
  sent: Sent[];
  /**
   * The part of the chat closest in meaning to the question, whether or not it was sent: about two
   * sentences of it, its score and where it is. ai.ts shows it under a "can't find" answer if it
   * clears TUNING.maybeMeaning. Null without meaning scores.
   */
  likely: Likely | null;
  /** The messages the model was shown, by 1-based number: the only ones an answer may cite. */
  shown: Record<number, Source>;
}

// Tunable. Exported so the bench page can try other values.
export const TUNING = {
  // Picking: which chunks may fill the budget.
  minMeaning: 0.3, // cosine similarity below this is "not about the same thing"
  minWords: 0.3, // relative to the best word match in this chat
  // "Found": did anything really match? Absolute floors, so a weak best match doesn't count.
  /** Share of the question's word weight a chunk must contain (keywordCoverage). null = old rule: anything picked. */
  // Bench C: same-wording questions cover ≥ 0.62 of their fact's chunk; unanswerable ones reach 0.62 only for
  // "the Berlin budget" (Lisbon's is in the chat). With windows, unanswerable ones reach meaning 0.43–0.54.
  minCoverage: 0.6 as number | null,
  foundMeaning: 0.55,
  meaningWeight: 0.6, // combined score = w × meaning + (1 − w) × words
  /** Embed ~300-character windows and score each chunk by its best window (bench C: reworded hits 8→12 of 20). */
  windows: true,
  /**
   * "Maybe" floor: under a "can't find" answer, show the closest part if its meaning reaches this. Below foundMeaning.
   * Bench C.maybe (before the rewrite): unanswerable questions reach it 2/10 on each D chat; reworded facts 8/20, 8 holding the fact.
   */
  maybeMeaning: 0.4
};
const RECENT_SHARE = 0.35; // of the budget, kept for the newest part of the chat
const EMBED_WAIT_MS = 8000; // never keep the user waiting on indexing; fall back to words
const INDEX_SLICE = 64; // texts per background step: a question can go in between, and indexing can pause

let embedder: Embedder = defaultEmbed;
/** Tests swap in a fake (or null-returning) embedder. */
export const setEmbedder = (e: Embedder) => (embedder = e);

const label = (c: Chunk) =>
  `[${roleName(c.role)}, message ${c.msg + 1}${c.parts > 1 ? `, part ${c.part} of ${c.parts}` : ''}]`;
const sourceOf = (c: Chunk): Source => ({ label: `${roleName(c.role)}, message ${c.msg + 1}`, snippet: norm(c.text).slice(0, 80) });

const dot = (a: Float32Array, b: Float32Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

/** The texts the meaning matcher embeds for each chunk. */
const unitsOf = (c: Chunk) => (TUNING.windows ? splitText(c.text, 300, 450) : [c.text]);

/**
 * Indexes a chat in the background, in small steps, so the first question doesn't wait.
 * Steps wait while an answer is being written (see pauseIndexing in embed.ts).
 */
export async function warm(ctx: PageContext | null, minChars = 0): Promise<void> {
  if (!ctx || ctx.messages.reduce((n, m) => n + m.text.length, 0) <= minChars) return;
  const units = chunkChat(ctx.messages).flatMap(unitsOf);
  try {
    for (let i = 0; i < units.length; i += INDEX_SLICE) {
      await indexingGate();
      if (units.length > INDEX_SLICE) reportIndexing(i / units.length);
      if (!(await embedder(units.slice(i, i + INDEX_SLICE)))) return; // matcher unavailable: words only
    }
  } catch {
    /* word matching carries on */
  } finally {
    reportIndexing(null);
  }
}

/** How well each chunk matches the query: by words (relative and absolute) and by meaning (null if unavailable). */
/** Follow-ups: the current question's share of every score; the previous question's words get the rest (approved 2026-11-17). */
export const FOLLOW_UP = { current: 0.7 };
const mix = (now: number[], before: number[] | null) => (before ? now.map((x, i) => FOLLOW_UP.current * x + (1 - FOLLOW_UP.current) * before[i]) : now);

/**
 * How well each chunk matches the query: by words (relative and absolute) and by meaning (null if unavailable).
 * `previous`: the previous question of a follow-up ("why do we need them?" after "why do we need workers?").
 */
export async function scoreChunks(chunks: Chunk[], query: string, previous = '') {
  const texts = chunks.map((c) => c.text);
  const words = mix(keywordScores(query, texts), previous ? keywordScores(previous, texts) : null);
  const cover = mix(keywordCoverage(query, texts), previous ? keywordCoverage(previous, texts) : null);
  const units = chunks.map(unitsOf);
  const heads = previous ? [query, previous] : [query];
  const vectors = await withTimeout(embedder([...heads, ...units.flat()]).catch(() => null), EMBED_WAIT_MS);
  let meaning: number[] | null = null;
  const best: string[] = []; // each chunk's best-matching window
  if (vectors) {
    let k = heads.length;
    meaning = units.map((u, i) => {
      let m = -Infinity;
      for (const t of u) {
        const v = vectors[k++];
        const s = previous ? FOLLOW_UP.current * dot(vectors[0], v) + (1 - FOLLOW_UP.current) * dot(vectors[1], v) : dot(vectors[0], v);
        if (s > m) [m, best[i]] = [s, t];
      }
      return Math.max(0, m);
    });
  }
  return { words, cover, meaning, best };
}

export async function buildContext(
  ctx: PageContext | null,
  question: string,
  quote: string,
  maxChars: number,
  /** Fill budget left after the matches with the newest messages (cloud models). */
  fill = false,
  /** False when the route is already settled: a chat sent whole then skips waiting for the meaning matcher. */
  routing = true,
  /** A follow-up's previous question: its words count too, less than the current one's. */
  previous = ''
): Promise<Built> {
  if (!ctx || !ctx.messages.length) return { text: '', mode: 'none', found: false, related: false, best: { meaning: null, cover: 0 }, sent: [], likely: null, shown: {} };

  const chunks = chunkChat(ctx.messages);
  const query = `${question}\n${quote.slice(0, 500)}`.trim();
  const whole = ctx.messages.map((m, i) => `[${roleName(m.role)}, message ${i + 1}]\n${m.text}`).join('\n\n');
  const { words, cover, meaning, best: windows } =
    whole.length <= maxChars && !routing
      ? {
          words: [] as number[],
          cover: mix(keywordCoverage(query, chunks.map((c) => c.text)), previous ? keywordCoverage(previous, chunks.map((c) => c.text)) : null),
          meaning: null,
          best: []
        }
      : await scoreChunks(chunks, query, previous);
  const best = { meaning: meaning ? Math.max(0, ...meaning) : null, cover: Math.max(0, ...cover) };
  const floor = TUNING.minCoverage;
  const over = (m: number) => chunks.some((c) => (floor !== null && cover[c.id] >= floor) || (meaning !== null && meaning[c.id] >= m));
  const w = meaning ? TUNING.meaningWeight : 0;
  const scoreOf = (c: Chunk) => w * (meaning?.[c.id] ?? 0) + (1 - w) * (words.length ? words[c.id] : cover[c.id]);
  let likely: Likely | null = null;
  if (meaning) {
    const c = chunks.reduce((b, x) => (meaning[x.id] > meaning[b.id] ? x : b), chunks[0]);
    likely = { by: 'meaning', meaning: meaning[c.id], passage: passageOf(windows[c.id] ?? c.text, query), source: sourceOf(c) };
  }

  // 1. Short chat: send everything, untouched.
  if (whole.length <= maxChars) {
    const shown = Object.fromEntries(ctx.messages.map((m, i) => [i + 1, { label: `${roleName(m.role)}, message ${i + 1}`, snippet: norm(m.text).slice(0, 80) }]));
    const sent = chunks.map((c) => ({ msg: c.msg + 1, text: c.text, source: sourceOf(c) }));
    // Scored like a long chat: routing applies the same rule to both (approved 2026-11-16).
    const related = floor === null || over(TUNING.minMeaning);
    return { text: whole, mode: 'full', found: floor === null || over(TUNING.foundMeaning), related, best, sent, likely, shown };
  }

  const picked = new Map<number, string>(); // chunk id -> text to send
  let used = 0;
  const take = (c: Chunk, cap = Infinity): boolean => {
    if (picked.has(c.id)) return true;
    const text = trimMiddle(c.text, Math.min(cap, maxChars));
    const cost = text.length + 40;
    if (used + cost > maxChars && picked.size) return false;
    picked.set(c.id, text);
    used += cost;
    return true;
  };

  // 2. Always: the chunk the highlight came from, plus its neighbours in the same message.
  const needle = norm(quote).slice(0, 50).toLowerCase();
  const home = needle.length >= 8 ? chunks.find((c) => norm(c.text).toLowerCase().includes(needle)) : undefined;
  if (home) {
    for (const c of [home, chunks[home.id - 1], chunks[home.id + 1]]) {
      if (c && c.msg === home.msg) take(c);
    }
  }

  // 3. Always: the newest part of the chat, working backwards.
  const recentLimit = used + maxChars * RECENT_SHARE;
  for (let i = chunks.length - 1; i >= 0 && used < recentLimit; i--) {
    if (!take(chunks[i], Math.max(400, recentLimit - used))) break;
  }

  // 4. The rest of the budget goes to the best matches for the question.
  const ranked = chunks
    .map((c) => {
      const m = meaning ? meaning[c.id] : 0;
      const relevant = (meaning !== null && m >= TUNING.minMeaning) || words[c.id] >= TUNING.minWords;
      return { c, score: scoreOf(c), relevant };
    })
    .filter((r) => r.relevant)
    .sort((a, b) => b.score - a.score);

  for (const r of ranked) {
    if (used >= maxChars) break;
    take(r.c);
  }

  // 5. Cloud models: spend what is left on the newest messages.
  if (fill) {
    for (let i = chunks.length - 1; i >= 0 && used < maxChars; i--) {
      if (!take(chunks[i])) break;
    }
  }

  // 6. Put the picks back in chat order, marking the gaps.
  const ids = [...picked.keys()].sort((a, b) => a - b);
  const blocks: string[] = [];
  const shown: Record<number, Source> = {};
  const sent: Sent[] = [];
  ids.forEach((id, i) => {
    if (i === 0 ? id > 0 : id !== ids[i - 1] + 1) blocks.push('[… parts of the chat left out …]');
    const c = chunks[id];
    blocks.push(`${label(c)}\n${picked.get(id)}`);
    shown[c.msg + 1] ??= sourceOf(c);
    sent.push({ msg: c.msg + 1, text: picked.get(id)!, source: sourceOf(c) });
  });
  if (ids[ids.length - 1] < chunks.length - 1) blocks.push('[… parts of the chat left out …]');

  const matched = floor === null ? ranked.length > 0 : over(TUNING.foundMeaning);
  const related = floor === null ? ranked.length > 0 : over(TUNING.minMeaning);
  return { text: blocks.join('\n\n'), mode: 'picked', found: matched || !!home, related: related || !!home, best, sent, likely, shown };
}

/** About two sentences of `text`: the one sharing the most words with the query (the first on a tie), and the next. */
export function passageOf(text: string, query: string): string {
  const s = norm(text).split(/(?<=[.!?])\s+/);
  const cover = keywordCoverage(query, s);
  const i = cover.indexOf(Math.max(...cover));
  const two = (i < s.length - 1 ? s.slice(i, i + 2) : s.slice(Math.max(0, i - 1))).join(' ');
  return two.length > 400 ? `${two.slice(0, 400)}…` : two;
}
