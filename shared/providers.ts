// Streaming chat calls to OpenAI, Anthropic and Gemini.
// Runs in both the extension side panel (browser fetch) and the server (Node fetch).

import type { ChatMessage, Provider } from './types';

/** Defaults are cheap, fast models: side questions are quick lookups.
 *  Model ids go stale; they are editable in settings and via server env. */
export const DEFAULT_MODELS: Record<Provider, string> = {
  openai: 'gpt-5.6-luna',
  anthropic: 'claude-haiku-5-5',
  gemini: 'gemini-3.5-flash-lite'
};

export const PROVIDER_LABEL: Record<Provider, string> = {
  openai: 'OpenAI',
  anthropic: 'Claude',
  gemini: 'Gemini'
};

export class ProviderError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}

export interface StreamArgs {
  provider: Provider;
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

/** Yields the `data:` payloads of a server-sent-events response. */
export async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith('data:')) yield buf.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

async function fail(res: Response, label: string): Promise<never> {
  let detail = '';
  try {
    const raw = await res.text();
    try {
      const j = JSON.parse(raw);
      detail = j?.error?.message ?? raw;
    } catch {
      detail = raw;
    }
  } catch {
    /* ignore */
  }
  const tail = detail ? `: ${String(detail).slice(0, 300)}` : '';
  throw new ProviderError(`${label} returned ${res.status}${tail}`, res.status);
}

function parse(data: string): any {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function* openai(a: StreamArgs): AsyncGenerator<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal: a.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${a.apiKey}` },
    body: JSON.stringify({
      model: a.model,
      stream: true,
      messages: [{ role: 'system', content: a.system }, ...a.messages]
    })
  });
  if (!res.ok) await fail(res, 'OpenAI');
  for await (const data of sseData(res)) {
    if (data === '[DONE]') return;
    const text = parse(data)?.choices?.[0]?.delta?.content;
    if (typeof text === 'string' && text) yield text;
  }
}

async function* anthropic(a: StreamArgs): AsyncGenerator<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal: a.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': a.apiKey,
      'anthropic-version': '2023-06-01',
      // Required when calling from a browser context (the side panel).
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: a.model,
      max_tokens: 2048,
      stream: true,
      system: a.system,
      messages: a.messages
    })
  });
  if (!res.ok) await fail(res, 'Claude');
  for await (const data of sseData(res)) {
    const j = parse(data);
    if (j?.type === 'content_block_delta' && j.delta?.type === 'text_delta') yield j.delta.text;
    if (j?.type === 'error') throw new ProviderError(`Claude: ${j.error?.message ?? 'stream error'}`, 500);
  }
}

async function* gemini(a: StreamArgs): AsyncGenerator<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    a.model
  )}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: 'POST',
    signal: a.signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': a.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: a.system }] },
      contents: a.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }))
    })
  });
  if (!res.ok) await fail(res, 'Gemini');
  for await (const data of sseData(res)) {
    const parts = parse(data)?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) if (typeof p?.text === 'string' && p.text) yield p.text;
    }
  }
}

export function streamChat(a: StreamArgs): AsyncGenerator<string> {
  if (a.provider === 'openai') return openai(a);
  if (a.provider === 'anthropic') return anthropic(a);
  return gemini(a);
}
