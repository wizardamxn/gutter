// Gutter — background service worker.
// 1. Opens the side panel (toolbar click, shortcut, or the "Ask Gutter" button).
// 2. Keeps the site-selector config fresh from the Gutter server.

import { isSelectorConfig } from '../../shared/selectors';

declare const __API_URL__: string;

async function refreshSelectors(): Promise<void> {
  try {
    const res = await fetch(`${__API_URL__}/api/config/selectors`);
    if (!res.ok) return;
    const config: unknown = await res.json();
    if (isSelectorConfig(config)) await chrome.storage.local.set({ selectors: config });
  } catch {
    // Server unreachable: the content script uses its built-in selectors.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.alarms.create('selectors', { periodInMinutes: 360 });
  void refreshSelectors();
});
chrome.runtime.onStartup.addListener(() => void refreshSelectors());
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'selectors') void refreshSelectors();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'gutter:ask' && sender.tab?.id != null) {
    // Must run inside the click's user gesture, so open before anything async.
    chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {});
    // The panel picks this up (on load, or via storage.onChanged if already open).
    void chrome.storage.session.set({
      pending: { quote: String(msg.quote ?? ''), tabId: sender.tab.id, ts: Date.now() }
    });
    sendResponse({ ok: true });
  }
  return false;
});
