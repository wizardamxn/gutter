// Types shared by the extension and the server.

export type Provider = 'openai' | 'anthropic' | 'gemini';
export const PROVIDERS: Provider[] = ['openai', 'anthropic', 'gemini'];

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
}

/** A message inside a Gutter side thread. */
export interface ThreadMessage extends ChatMessage {
  /** Who answered, e.g. "Claude · your key". Assistant messages only. */
  via?: string;
  /** True when `content` is an error notice rather than a model answer. */
  error?: boolean;
}

/** One side conversation, anchored to a main chat (convKey). */
export interface Thread {
  id: string;
  convKey: string;
  site: string;
  title: string;
  /** The text the user highlighted in the main chat, if any. */
  quote: string;
  messages: ThreadMessage[];
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

/** One message read from the host chat page. */
export interface PageMessage {
  role: Role | 'unknown';
  text: string;
}

/** What the content script reports about the open chat. */
export interface PageContext {
  site: string;
  siteName: string;
  title: string;
  convKey: string;
  url: string;
  /** True when site selectors found nothing and we fell back to raw page text. */
  fallback: boolean;
  messages: PageMessage[];
}

export interface HostedInfo {
  providers: Provider[];
  models: Partial<Record<Provider, string>>;
  dailyLimit: number;
  usedToday: number;
}
