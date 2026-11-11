"use strict";
(() => {
  // ../shared/selectors.ts
  var DEFAULT_SELECTORS = {
    version: 1,
    sites: [
      {
        id: "chatgpt",
        name: "ChatGPT",
        hosts: ["chatgpt.com", "chat.openai.com"],
        messages: [{ selector: "[data-message-author-role]", roleAttr: "data-message-author-role" }],
        composer: ["#prompt-textarea", 'form [contenteditable="true"]', "form textarea"],
        titleStrip: ["\\s*[-|]\\s*ChatGPT$", "^ChatGPT$"]
      },
      {
        id: "claude",
        name: "Claude",
        hosts: ["claude.ai"],
        messages: [
          { selector: '[data-testid="user-message"]', role: "user" },
          { selector: ".font-claude-response", role: "assistant" },
          { selector: ".font-claude-message", role: "assistant" }
        ],
        composer: ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]'],
        titleStrip: ["\\s*[-|]\\s*Claude$", "^Claude$"]
      },
      {
        id: "gemini",
        name: "Gemini",
        hosts: ["gemini.google.com"],
        messages: [
          { selector: "user-query", role: "user" },
          { selector: "model-response", role: "assistant" }
        ],
        composer: ["rich-textarea .ql-editor", '.ql-editor[contenteditable="true"]'],
        titleStrip: ["\\s*[-|]\\s*Gemini$", "^(Google )?Gemini$"]
      },
      {
        id: "grok",
        name: "Grok",
        hosts: ["grok.com"],
        messages: [{ selector: ".message-bubble", userIfClosest: ".items-end" }],
        composer: ["form textarea", 'form [contenteditable="true"]'],
        titleStrip: ["\\s*[-|]\\s*Grok$", "^Grok$"]
      }
    ]
  };
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

  // src/content.ts
  var MAX_QUOTE = 4e3;
  var norm = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  var textOf = (el) => (el.innerText ?? el.textContent ?? "").trim();
  async function loadConfig() {
    try {
      const { selectors } = await chrome.storage.local.get("selectors");
      if (isSelectorConfig(selectors) && selectors.version >= DEFAULT_SELECTORS.version) return selectors;
    } catch {
    }
    return DEFAULT_SELECTORS;
  }
  function query(selector) {
    try {
      return [...document.querySelectorAll(selector)];
    } catch {
      return [];
    }
  }
  function findMessages(site) {
    const seen = /* @__PURE__ */ new Set();
    const found = [];
    for (const rule of site.messages) {
      for (const el of query(rule.selector)) {
        if (seen.has(el)) continue;
        let role = "unknown";
        if (rule.role) role = rule.role;
        else if (rule.roleAttr) {
          const v = el.getAttribute(rule.roleAttr);
          if (v !== "user" && v !== "assistant") continue;
          role = v;
        } else if (rule.userIfClosest) {
          let isUser = false;
          try {
            isUser = !!el.closest(rule.userIfClosest);
          } catch {
          }
          role = isUser ? "user" : "assistant";
        }
        seen.add(el);
        found.push({ el, role });
      }
    }
    return found.filter((f) => !found.some((o) => o !== f && o.el.contains(f.el))).sort((a, b) => a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1).filter((f) => textOf(f.el));
  }
  function readChat(site) {
    const found = findMessages(site);
    if (found.length) return { found, fallback: false };
    const main2 = document.querySelector("main") ?? document.body;
    return { found: textOf(main2) ? [{ el: main2, role: "unknown" }] : [], fallback: true };
  }
  function findComposer(site) {
    for (const selector of site.composer) {
      const el = query(selector)[0];
      if (el) return el;
    }
    const candidates = query('textarea, [contenteditable="true"]').filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 100 && r.height > 10 && !el.closest("#gutter-root");
    });
    candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    return candidates[0] ?? null;
  }
  function pageTitle(site) {
    let title = document.title ?? "";
    for (const source of site.titleStrip) {
      try {
        title = title.replace(new RegExp(source, "i"), "");
      } catch {
      }
    }
    return title.trim();
  }
  function insertIntoComposer(site, text) {
    const el = findComposer(site);
    if (!el) return { ok: false, error: "I couldn't find the chat box on this page." };
    el.focus();
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const next = el.value ? `${el.value}

${text}` : text;
      setter ? setter.call(el, next) : el.value = next;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true };
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    const payload = (norm(el.innerText) ? "\n\n" : "") + text;
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, payload);
    } catch {
      ok = false;
    }
    if (!ok) {
      const data = new DataTransfer();
      data.setData("text/plain", payload);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }
    return { ok: true };
  }
  function jumpTo(site, quote) {
    const needle = norm(quote).slice(0, 60);
    if (!needle) return { ok: false };
    const host = readChat(site).found.find((f) => norm(textOf(f.el)).includes(needle));
    if (!host) return { ok: false };
    const short = needle.slice(0, 30);
    let target = host.el;
    const walker = document.createTreeWalker(host.el, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (target.contains(node) && norm(node.textContent).includes(short)) target = node;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("gutter-flash");
    setTimeout(() => target.classList.remove("gutter-flash"), 1800);
    return { ok: true };
  }
  function mountAskButton(site) {
    const root = document.createElement("div");
    root.id = "gutter-root";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gutter-ask-btn";
    btn.textContent = "Ask Gutter";
    btn.title = "Ask about this on the side, without touching the main chat";
    root.appendChild(btn);
    document.documentElement.appendChild(root);
    let quote = "";
    const hide = () => {
      root.classList.remove("visible");
      quote = "";
    };
    const update = () => {
      const sel = window.getSelection();
      const picked = sel?.toString().trim() ?? "";
      if (!sel || !sel.rangeCount || picked.length < 2) return hide();
      const range = sel.getRangeAt(0);
      if (findComposer(site)?.contains(range.commonAncestorContainer)) return hide();
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return hide();
      quote = picked.slice(0, MAX_QUOTE);
      root.style.top = `${Math.max(8, rect.top - 44)}px`;
      root.style.left = `${Math.min(window.innerWidth - 130, Math.max(8, rect.left + rect.width / 2 - 55))}px`;
      btn.textContent = "Ask Gutter";
      root.classList.add("visible");
    };
    let timer;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 10);
    };
    document.addEventListener("mouseup", (e) => {
      if (!root.contains(e.target)) schedule();
    });
    document.addEventListener("keyup", (e) => {
      if (e.shiftKey || e.key === "Shift") schedule();
    });
    document.addEventListener("mousedown", (e) => {
      if (!root.contains(e.target)) hide();
    });
    window.addEventListener("scroll", hide, true);
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      if (!quote) return;
      try {
        void chrome.runtime.sendMessage({ type: "gutter:ask", quote });
        hide();
      } catch {
        btn.textContent = "Refresh the page to use Gutter";
      }
    });
  }
  async function main() {
    const w = window;
    if (w.__gutterLoaded) return;
    w.__gutterLoaded = true;
    const config = await loadConfig();
    const site = config.sites.find((s) => s.hosts.includes(location.hostname));
    if (!site) return;
    mountAskButton(site);
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === "gutter:getContext") {
        const { found, fallback } = readChat(site);
        const context = {
          site: site.id,
          siteName: site.name,
          title: pageTitle(site),
          convKey: `${site.id}:${location.pathname}`,
          url: location.href,
          fallback,
          messages: found.map((f) => ({ role: f.role, text: textOf(f.el) }))
        };
        sendResponse(context);
      } else if (msg?.type === "gutter:insert") {
        sendResponse(insertIntoComposer(site, String(msg.text ?? "")));
      } else if (msg?.type === "gutter:jump") {
        sendResponse(jumpTo(site, String(msg.quote ?? "")));
      }
      return false;
    });
  }
  void main();
})();
