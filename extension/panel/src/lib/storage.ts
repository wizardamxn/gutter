// Everything Gutter keeps on this device (chrome.storage.local).
import { DEFAULT_MODELS } from '../../../../shared/providers';
import type { Provider, Thread } from '../../../../shared/types';

export interface Settings {
  /** Your own API keys. Stored only on this device; sent only to that provider. */
  keys: Record<Provider, string>;
  models: Record<Provider, string>;
  /** Selected answer source, e.g. "own:openai" or "hosted:anthropic". */
  choice: string;
}

export interface Auth {
  token: string;
  email: string;
}

export const DEFAULT_SETTINGS: Settings = {
  keys: { openai: '', anthropic: '', gemini: '' },
  models: { ...DEFAULT_MODELS },
  choice: ''
};

export async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  const s = (settings ?? {}) as Partial<Settings>;
  return {
    keys: { ...DEFAULT_SETTINGS.keys, ...s.keys },
    models: { ...DEFAULT_SETTINGS.models, ...s.models },
    choice: s.choice ?? ''
  };
}

export const saveSettings = (settings: Settings) => chrome.storage.local.set({ settings });

export async function loadAuth(): Promise<Auth | null> {
  const { auth } = await chrome.storage.local.get('auth');
  const a = auth as Auth | undefined;
  return a?.token ? a : null;
}

export const saveAuth = (auth: Auth | null) =>
  auth ? chrome.storage.local.set({ auth }) : chrome.storage.local.remove('auth');

const threadsKey = (convKey: string) => `threads:${convKey}`;

export async function loadThreads(convKey: string): Promise<Thread[]> {
  const key = threadsKey(convKey);
  const stored = (await chrome.storage.local.get(key))[key];
  return Array.isArray(stored) ? (stored as Thread[]) : [];
}

export const saveThreads = (convKey: string, threads: Thread[]) =>
  chrome.storage.local.set({ [threadsKey(convKey)]: threads });
