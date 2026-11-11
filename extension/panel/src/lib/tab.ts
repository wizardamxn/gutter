// Talking to the chat tab's content script.

/** The chat tab next to the panel. `?tabId=` overrides it (used by the e2e test). */
export async function getActiveTabId(): Promise<number | null> {
  const forced = new URLSearchParams(location.search).get('tabId');
  if (forced && /^\d+$/.test(forced)) return Number(forced);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

/** Returns null when the tab has no Gutter content script (other site, or not refreshed yet). */
export async function sendToTab<T>(tabId: number, message: unknown): Promise<T | null> {
  try {
    return ((await chrome.tabs.sendMessage(tabId, message)) as T) ?? null;
  } catch {
    return null;
  }
}
