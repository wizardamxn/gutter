// Chrome's built-in model (Gemini Nano) through the Prompt API.
// Free, runs on the user's device, nothing leaves the machine.
// It is small (about 9,000 tokens shared by input and output), so the prompt is
// fitted to the model's real limit using Chrome's own token counter.
import type { ChatMessage } from '../../../../shared/types';

export type NanoStatus = 'unavailable' | 'downloadable' | 'downloading' | 'available';

/** A prompt built from at most a given amount of chat text: rules, the user turn, and the chat part alone. */
export interface Prepared {
  system: string;
  /** The user turn: the chat as a document, the rules again, the question. */
  prompt: string;
  /** The chat text inside `prompt`, measured against CHAT_TOKENS. */
  chat: string;
}
export type Prepare = (maxChars: number) => Promise<Prepared>;

const HISTORY_MESSAGES = 6;
const HISTORY_CHARS = 2_500;
const ANSWER_TOKENS = 1_200; // room left for the reply
const FALLBACK_QUOTA = 9_216;
/**
 * Chat text the built-in model reads per question. Reading costs ~1.4 s per 1,000 prompt tokens.
 * The whole chat is sent only if it is at most this many tokens; above it, parts are always picked.
 */
export const CHAT_TOKENS = 3_500;
/** No text runs over ~6 characters a token (English 4.72, code 3.05), so a longer chat can't fit CHAT_TOKENS. */
const MAX_CHARS_PER_TOKEN = 6;

const LANG = {
  expectedInputs: [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }]
};

// The Prompt API is newer than the TypeScript DOM typings.
/* eslint-disable @typescript-eslint/no-explicit-any */
const languageModel = (): any => (globalThis as any).LanguageModel ?? null;

function normalize(value: unknown): NanoStatus {
  if (value === 'available' || value === 'readily') return 'available';
  if (value === 'downloadable' || value === 'after-download') return 'downloadable';
  if (value === 'downloading') return 'downloading';
  return 'unavailable';
}

export async function nanoStatus(): Promise<NanoStatus> {
  const LM = languageModel();
  if (!LM?.availability) return 'unavailable';
  try {
    return normalize(await LM.availability(LANG));
  } catch {
    try {
      return normalize(await LM.availability());
    } catch {
      return 'unavailable';
    }
  }
}

export const LOW_RANDOMNESS = { temperature: 0.3, topK: 3 };

/** Low randomness makes a small model less likely to invent things. Extensions may set it. */
export async function sampling(LM: any): Promise<{ temperature: number; topK: number }> {
  try {
    const p = await LM.params?.();
    if (p && typeof p.defaultTopK === 'number') {
      return { temperature: Math.min(LOW_RANDOMNESS.temperature, p.maxTemperature ?? 1), topK: Math.min(p.defaultTopK, LOW_RANDOMNESS.topK) };
    }
  } catch {
    /* fall through */
  }
  // Chrome 157 returns {} from params() yet may still accept the values; openSession falls back if it doesn't.
  return LOW_RANDOMNESS;
}

export async function openSession(system: string, history: ChatMessage[], signal?: AbortSignal, onStatus?: (s: string) => void): Promise<any> {
  const LM = languageModel();
  if (!LM) throw new Error("Chrome's built-in model isn't available in this browser.");
  const base = {
    initialPrompts: [{ role: 'system', content: system }, ...history],
    signal,
    // First use downloads the model (several GB). Report progress.
    monitor(m: EventTarget) {
      m.addEventListener('downloadprogress', (e) => {
        const loaded = (e as unknown as { loaded: number }).loaded;
        onStatus?.(loaded < 1 ? `Downloading Chrome's built-in model, ${Math.round(loaded * 100)}%` : '');
      });
    }
  };
  // Try the fullest set of options first; older Chrome versions reject some of them.
  const attempts = [{ ...base, ...LANG, ...(await sampling(LM)) }, { ...base, ...LANG }, base];
  let lastError: unknown;
  for (const options of attempts) {
    try {
      return await LM.create(options);
    } catch (err) {
      lastError = err;
      const name = (err as Error)?.name;
      // An option this Chrome doesn't take (or a sampling value out of its range): try fewer options.
      if (signal?.aborted || !(name === 'NotSupportedError' || err instanceof TypeError || err instanceof RangeError)) throw err;
    }
  }
  throw lastError;
}

/** One short call: the question as search keywords plus synonyms, to find chat parts worded differently. */
export async function rewriteQuery(question: string, signal?: AbortSignal): Promise<string> {
  const session = await openSession('You turn questions into search keywords.', [], signal);
  try {
    const out = await session.prompt(
      `Rewrite this question as one line of search keywords: its key words plus 3 to 6 synonyms or related words. Output only the keywords.\nQuestion: ${question}`,
      { signal }
    );
    return String(out ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  } finally {
    close(session);
  }
}

/** Router bake-off, "nano" router: one short call, one word back (LOOKUP or EXPLAIN). */
export async function routeWithNano(question: string, previous = '', signal?: AbortSignal): Promise<string> {
  const session = await openSession(
    'You sort questions a user asks in a side panel next to their conversation with an AI assistant. Reply with exactly one word.',
    [],
    signal
  );
  try {
    const out = await session.prompt(
      [
        'LOOKUP: the question asks for a specific fact from the conversation: a value, name, number, date, code or decision that would be written there.',
        'EXPLAIN: anything else: why or how, an explanation, examples, advice, opinions, or general knowledge.',
        ...(previous ? [`Previous question: ${previous}`] : []),
        `Question: ${question}`,
        'Answer with one word: LOOKUP or EXPLAIN.'
      ].join('\n'),
      { signal }
    );
    return String(out ?? '').trim().slice(0, 40);
  } finally {
    close(session);
  }
}

export function close(session: any): void {
  try {
    session?.destroy();
  } catch {
    /* already gone */
  }
}

/** Token count from Chrome's own counter; a character estimate if this Chrome has none. */
export async function countTokens(session: any, text: string): Promise<number> {
  try {
    const measure = session.measureInputUsage ?? session.measureContextUsage ?? session.countPromptTokens;
    if (measure) {
      const n = await measure.call(session, text);
      if (typeof n === 'number' && n >= 0) return n;
    }
  } catch {
    /* fall through */
  }
  return Math.ceil(text.length / 3.2);
}

export const quotaOf = (session: any): number => Number(session.inputQuota ?? session.contextWindow) || FALLBACK_QUOTA;

/** Reads a streamed reply. Current Chrome streams deltas; early versions streamed the whole text so far. */
export async function* readStream(stream: ReadableStream<string>): AsyncGenerator<string> {
  const reader = stream.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (typeof value !== 'string' || !value) continue;
    if (text.length >= 8 && value.startsWith(text)) {
      const delta = value.slice(text.length);
      text = value;
      if (delta) yield delta;
    } else {
      text += value;
      yield value;
    }
  }
}

const TOO_BIG = 'This is too much text for the built-in model. Highlight a shorter passage, or use a smart model.';

/**
 * Streams an answer from the built-in model.
 * `prepare(maxChars)` builds the prompt from at most that much chat text.
 * We measure the result in real tokens and shrink it until it fits the model's limit
 * and the chat part stays under CHAT_TOKENS.
 */
export async function* nanoStream(
  prepare: Prepare,
  messages: ChatMessage[],
  signal?: AbortSignal,
  onStatus?: (s: string) => void
): AsyncGenerator<string> {
  const history = messages
    .slice(0, -1)
    .slice(-HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content.slice(0, HISTORY_CHARS) }));
  while (history.length && history[0].role !== 'user') history.shift(); // must start with a user turn

  // 1. Fit the prompt to the model's real limit, and the chat to its cap.
  let prepared: Prepared;
  let chars: number;
  const probe = await openSession('You answer questions about a conversation.', [], signal, onStatus);
  try {
    onStatus?.('');
    const fixed = (await countTokens(probe, history.map((m) => m.content).join('\n'))) + ANSWER_TOKENS + 200;
    const room = Math.max(600, quotaOf(probe) - fixed);
    // Start generous: a chat that fits in this many characters is sent whole if its real token count
    // is within the cap; otherwise the loop below shrinks the budget and parts are picked.
    chars = Math.min(room, CHAT_TOKENS) * MAX_CHARS_PER_TOKEN;
    for (let i = 0; ; i++) {
      prepared = await prepare(Math.max(1500, Math.floor(chars)));
      const total = await countTokens(probe, `${prepared.system}\n${prepared.prompt}`);
      const chat = await countTokens(probe, prepared.chat);
      if ((total <= room && chat <= CHAT_TOKENS) || i === 3) break;
      chars = chars * Math.min(room / total, CHAT_TOKENS / Math.max(1, chat)) * 0.9;
      // Over the cap: the next try must be shorter than this chat text, so a whole chat turns into picked parts.
      if (chat > CHAT_TOKENS) chars = Math.min(chars, prepared.chat.length - 1);
    }
  } finally {
    close(probe);
  }

  // 2. Ask. If Chrome still says it's too big, halve once and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    let session: any = null;
    let produced = false;
    try {
      session = await openSession(prepared.system, history, signal, onStatus);
      onStatus?.('');
      for await (const delta of readStream(session.promptStreaming(prepared.prompt, { signal }))) {
        produced = true;
        yield delta;
      }
      return;
    } catch (err) {
      const tooBig = (err as Error)?.name === 'QuotaExceededError';
      if (tooBig && !produced && attempt === 0 && !signal?.aborted) {
        chars = chars / 2;
        prepared = await prepare(Math.max(1500, Math.floor(chars)));
        continue;
      }
      throw tooBig ? new Error(TOO_BIG) : err;
    } finally {
      close(session);
    }
  }
}
