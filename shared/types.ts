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
  /** Parts of the main chat this answer was based on. Clicking one jumps to it. */
  sources?: { label: string; snippet: string }[];
  /** An answer about the chat that cited no part the model was actually given. */
  unverified?: boolean;
  /** Old label (before 2026-11-17): answered from general knowledge. Read for display; new answers use `label`. */
  general?: boolean;
  /** Code's label: "From the chat", "From the chat + general knowledge", "General knowledge". */
  label?: 'chat' | 'mixed' | 'general';
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

/** What a signed-in user gets from Gutter's hosted "smart" models. */
export interface HostedInfo {
  providers: Provider[];
  models: Partial<Record<Provider, string>>;
  plan: 'free' | 'paid';
  /** Free smart answers per account, ever. Paid accounts are not limited. */
  freeLimit: number;
  used: number;
}
