"use strict";
(() => {
  // ../shared/selectors.ts
  var isStr = (x) => typeof x === "string";
  var isStrArr = (x) => Array.isArray(x) && x.every(isStr);
  function isSelectorConfig(x) {
    if (!x || typeof x !== "object") return false;
    const c = x;
    if (typeof c.version !== "number" || !Array.isArray(c.sites) || c.sites.length > 50) return false;
    return c.sites.every((s) => {
      if (!s || typeof s !== "object") return false;
      const site = s;
      return isStr(site.id) && isStr(site.name) && isStrArr(site.hosts) && isStrArr(site.composer) && isStrArr(site.titleStrip) && Array.isArray(site.messages) && site.messages.every((m) => {
        if (!m || typeof m !== "object") return false;
        const r = m;
        return isStr(r.selector) && (r.role === void 0 || r.role === "user" || r.role === "assistant") && (r.roleAttr === void 0 || isStr(r.roleAttr)) && (r.userIfClosest === void 0 || isStr(r.userIfClosest));
      });
    });
  }

  // src/background.ts
  async function refreshSelectors() {
    try {
      const res = await fetch(`${"http://localhost:4000"}/api/config/selectors`);
      if (!res.ok) return;
      const config = await res.json();
      if (isSelectorConfig(config)) await chrome.storage.local.set({ selectors: config });
    } catch {
    }
  }
  chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    });
    chrome.alarms.create("selectors", { periodInMinutes: 360 });
    void refreshSelectors();
  });
  chrome.runtime.onStartup.addListener(() => void refreshSelectors());
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === "selectors") void refreshSelectors();
  });
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "gutter:ask" && sender.tab?.id != null) {
      chrome.sidePanel.open({ windowId: sender.tab.windowId }).catch(() => {
      });
      void chrome.storage.session.set({
        pending: { quote: String(msg.quote ?? ""), tabId: sender.tab.id, ts: Date.now() }
      });
      sendResponse({ ok: true });
    }
    return false;
  });
})();
