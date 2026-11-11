// Calls to the Gutter server (accounts, thread sync, hosted answers).
import { sseData } from '../../../../shared/providers';
import type { ChatMessage, HostedInfo, Provider, Thread } from '../../../../shared/types';
import type { Auth } from './storage';

declare const __API_URL__: string;
export const API_URL = __API_URL__;

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {})
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
    });
  } catch {
    throw new ApiError("I can't reach the Gutter server right now.", 0);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(json?.error ?? `Server error (${res.status}).`, res.status);
  return json as T;
}

export const api = {
  signup: (email: string, password: string) =>
    request<Auth>('POST', '/api/auth/signup', { body: { email, password } }),
  login: (email: string, password: string) =>
    request<Auth>('POST', '/api/auth/login', { body: { email, password } }),
  hosted: (token: string) => request<HostedInfo>('GET', '/api/ai/providers', { token }),
  listThreads: (token: string, convKey: string) =>
    request<{ threads: Thread[] }>('GET', `/api/threads?convKey=${encodeURIComponent(convKey)}`, { token }),
  putThread: (token: string, thread: Thread) => {
    const { id, ...body } = thread;
    return request<{ thread: Thread; stale: boolean }>('PUT', `/api/threads/${encodeURIComponent(id)}`, {
      token,
      body
    });
  }
};

/** Hosted answer, streamed from the Gutter server. */
export async function* hostedStream(
  token: string,
  body: { provider: Provider; system: string; messages: ChatMessage[] },
  signal?: AbortSignal
): AsyncGenerator<string> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/ai/chat`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError("I can't reach the Gutter server right now.", 0);
  }
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    throw new ApiError(json?.error ?? `Server error (${res.status}).`, res.status);
  }
  for await (const data of sseData(res)) {
    if (data === '[DONE]') return;
    let event: { t?: string; error?: string } | null = null;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.error) throw new ApiError(event.error, 502);
    if (event?.t) yield event.t;
  }
}
