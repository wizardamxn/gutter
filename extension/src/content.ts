// Gutter — content script. Runs on the chat sites.
// Shows the "Ask Gutter" button on text selection, and answers the side panel:
// read the chat, drop text into the chat box, jump to a quote.

import {
  DEFAULT_SELECTORS,
  isSelectorConfig,
  type SelectorConfig,
  type SiteConfig
} from '../../shared/selectors';
import type { PageContext, PageMessage } from '../../shared/types';

interface Found {
  el: Element;
  role: PageMessage['role'];
}

const MAX_QUOTE = 4000;
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const textOf = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();

async function loadConfig(): Promise<SelectorConfig> {
  try {
    const { selectors } = await chrome.storage.local.get('selectors');
    if (isSelectorConfig(selectors) && selectors.version >= DEFAULT_SELECTORS.version) return selectors;
  } catch {
    /* fall through */
  }
  return DEFAULT_SELECTORS;
}

function query(selector: string): Element[] {
  try {
    return [...document.querySelectorAll(selector)];
  } catch {
    return []; // a bad selector in remote config must not break the page
  }
}

function findMessages(site: SiteConfig): Found[] {
  const seen = new Set<Element>();
  const found: Found[] = [];
  for (const rule of site.messages) {
    for (const el of query(rule.selector)) {
      if (seen.has(el)) continue;
      let role: Found['role'] = 'unknown';
      if (rule.role) role = rule.role;
      else if (rule.roleAttr) {
        const v = el.getAttribute(rule.roleAttr);
        if (v !== 'user' && v !== 'assistant') continue;
        role = v;
      } else if (rule.userIfClosest) {
        let isUser = false;
        try {
          isUser = !!el.closest(rule.userIfClosest);
        } catch {
          /* bad selector */
        }
        role = isUser ? 'user' : 'assistant';
      }
      seen.add(el);
      found.push({ el, role });
    }
  }
  // Drop matches nested inside another match, then put them in page order.
  return found
    .filter((f) => !found.some((o) => o !== f && o.el.contains(f.el)))
    .sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .filter((f) => textOf(f.el));
}

function readChat(site: SiteConfig): { found: Found[]; fallback: boolean } {
  const found = findMessages(site);
  if (found.length) return { found, fallback: false };
  // Selectors found nothing (site changed?): fall back to the page's main text.
  const main = document.querySelector('main') ?? document.body;
  return { found: textOf(main) ? [{ el: main, role: 'unknown' }] : [], fallback: true };
}

function findComposer(site: SiteConfig): HTMLElement | null {
  for (const selector of site.composer) {
    const el = query(selector)[0];
    if (el) return el as HTMLElement;
  }
  // Fallback: the lowest visible editable on the page.
  const candidates = query('textarea, [contenteditable="true"]').filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 100 && r.height > 10 && !el.closest('#gutter-root');
  });
  candidates.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
  return (candidates[0] as HTMLElement) ?? null;
}

function pageTitle(site: SiteConfig): string {
  let title = document.title ?? '';
  for (const source of site.titleStrip) {
    try {
      title = title.replace(new RegExp(source, 'i'), '');
    } catch {
      /* bad regex in config */
    }
  }
  return title.trim();
}

function insertIntoComposer(site: SiteConfig, text: string): { ok: boolean; error?: string } {
  const el = findComposer(site);
  if (!el) return { ok: false, error: "I couldn't find the chat box on this page." };
  el.focus();

  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    // React-controlled inputs ignore plain `.value =`; use the native setter + input event.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const next = el.value ? `${el.value}\n\n${text}` : text;
    setter ? setter.call(el, next) : (el.value = next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  }

  // Rich editors (ProseMirror, Quill, Lexical): caret to the end, then insert as typed text.
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel?.removeAllRanges();
  sel?.addRange(range);

  const payload = (norm(el.innerText) ? '\n\n' : '') + text;
  let ok = false;
  try {
    ok = document.execCommand('insertText', false, payload);
  } catch {
    ok = false;
  }
  if (!ok) {
    const data = new DataTransfer();
    data.setData('text/plain', payload);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }
  return { ok: true };
}

function jumpTo(site: SiteConfig, quote: string): { ok: boolean } {
  const needle = norm(quote).slice(0, 60);
  if (!needle) return { ok: false };
  const host = readChat(site).found.find((f) => norm(textOf(f.el)).includes(needle));
  if (!host) return { ok: false };

  // Narrow down to the smallest element that still contains the start of the quote.
  const short = needle.slice(0, 30);
  let target: Element = host.el;
  const walker = document.createTreeWalker(host.el, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode() as Element | null; node; node = walker.nextNode() as Element | null) {
    if (target.contains(node) && norm(node.textContent).includes(short)) target = node;
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.add('gutter-flash');
  setTimeout(() => target.classList.remove('gutter-flash'), 1800);
  return { ok: true };
}

function mountAskButton(site: SiteConfig): void {
  const root = document.createElement('div');
  root.id = 'gutter-root';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'gutter-ask-btn';
  btn.textContent = 'Ask Gutter';
  btn.title = 'Ask about this on the side, without touching the main chat';
  root.appendChild(btn);
  document.documentElement.appendChild(root);

  let quote = '';
  const hide = () => {
    root.classList.remove('visible');
    quote = '';
  };

  const update = () => {
    const sel = window.getSelection();
    const picked = sel?.toString().trim() ?? '';
    if (!sel || !sel.rangeCount || picked.length < 2) return hide();
    const range = sel.getRangeAt(0);
    if (findComposer(site)?.contains(range.commonAncestorContainer)) return hide(); // typing, not reading
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return hide();

    quote = picked.slice(0, MAX_QUOTE);
    root.style.top = `${Math.max(8, rect.top - 44)}px`;
    root.style.left = `${Math.min(window.innerWidth - 130, Math.max(8, rect.left + rect.width / 2 - 55))}px`;
    btn.textContent = 'Ask Gutter';
    root.classList.add('visible');
  };

  let timer: number | undefined;
  const schedule = () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(update, 10);
  };
  document.addEventListener('mouseup', (e) => {
    if (!root.contains(e.target as Node)) schedule();
  });
  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Shift') schedule();
  });
  document.addEventListener('mousedown', (e) => {
    if (!root.contains(e.target as Node)) hide();
  });
  window.addEventListener('scroll', hide, true);

  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  btn.addEventListener('click', () => {
    if (!quote) return;
    try {
      void chrome.runtime.sendMessage({ type: 'gutter:ask', quote });
      hide();
    } catch {
      // The extension was updated or reloaded; this page still has the old script.
      btn.textContent = 'Refresh the page to use Gutter';
    }
  });
}

async function main(): Promise<void> {
  const w = window as unknown as { __gutterLoaded?: boolean };
  if (w.__gutterLoaded) return;
  w.__gutterLoaded = true;

  const config = await loadConfig();
  const site = config.sites.find((s) => s.hosts.includes(location.hostname));
  if (!site) return;

  mountAskButton(site);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'gutter:getContext') {
      const { found, fallback } = readChat(site);
      const context: PageContext = {
        site: site.id,
        siteName: site.name,
        title: pageTitle(site),
        convKey: `${site.id}:${location.pathname}`,
        url: location.href,
        fallback,
        messages: found.map((f) => ({ role: f.role, text: textOf(f.el) }))
      };
      sendResponse(context);
    } else if (msg?.type === 'gutter:insert') {
      sendResponse(insertIntoComposer(site, String(msg.text ?? '')));
    } else if (msg?.type === 'gutter:jump') {
      sendResponse(jumpTo(site, String(msg.quote ?? '')));
    }
    return false;
  });
}

void main();
