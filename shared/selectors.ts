// How Gutter reads each chat site. This is DATA, not code, so the server can
// ship fixes (GET /api/config/selectors) without a Chrome Web Store re-review.
//
// NOTE: these selectors are best-known values and must be checked against the
// live sites. When a site changes its markup, bump `version` and edit here
// (or PUT a new config to the server).

export interface MessageRule {
  /** CSS selector for a message element. */
  selector: string;
  /** Fixed role for every match. */
  role?: 'user' | 'assistant';
  /** Read the role ("user" / "assistant") from this attribute. */
  roleAttr?: string;
  /** Role is "user" when the element has an ancestor matching this, else "assistant". */
  userIfClosest?: string;
}

export interface SiteConfig {
  id: string;
  name: string;
  hosts: string[];
  messages: MessageRule[];
  /** Chat input box candidates, tried in order. */
  composer: string[];
  /** Regex sources (case-insensitive) removed from document.title. */
  titleStrip: string[];
}

export interface SelectorConfig {
  version: number;
  sites: SiteConfig[];
}

export const DEFAULT_SELECTORS: SelectorConfig = {
  version: 1,
  sites: [
    {
      id: 'chatgpt',
      name: 'ChatGPT',
      hosts: ['chatgpt.com', 'chat.openai.com'],
      messages: [{ selector: '[data-message-author-role]', roleAttr: 'data-message-author-role' }],
      composer: ['#prompt-textarea', 'form [contenteditable="true"]', 'form textarea'],
      titleStrip: ['\\s*[-|]\\s*ChatGPT$', '^ChatGPT$']
    },
    {
      id: 'claude',
      name: 'Claude',
      hosts: ['claude.ai'],
      messages: [
        { selector: '[data-testid="user-message"]', role: 'user' },
        { selector: '.font-claude-response', role: 'assistant' },
        { selector: '.font-claude-message', role: 'assistant' }
      ],
      composer: ['[data-testid="chat-input"]', 'div.ProseMirror[contenteditable="true"]'],
      titleStrip: ['\\s*[-|]\\s*Claude$', '^Claude$']
    },
    {
      id: 'gemini',
      name: 'Gemini',
      hosts: ['gemini.google.com'],
      messages: [
        { selector: 'user-query', role: 'user' },
        { selector: 'model-response', role: 'assistant' }
      ],
      composer: ['rich-textarea .ql-editor', '.ql-editor[contenteditable="true"]'],
      titleStrip: ['\\s*[-|]\\s*Gemini$', '^(Google )?Gemini$']
    },
    {
      id: 'grok',
      name: 'Grok',
      hosts: ['grok.com'],
      messages: [{ selector: '.message-bubble', userIfClosest: '.items-end' }],
      composer: ['form textarea', 'form [contenteditable="true"]'],
      titleStrip: ['\\s*[-|]\\s*Grok$', '^Grok$']
    }
  ]
};

const isStr = (x: unknown): x is string => typeof x === 'string';
const isStrArr = (x: unknown): x is string[] => Array.isArray(x) && x.every(isStr);

/** Shape check for configs that arrive over the network or from storage. */
export function isSelectorConfig(x: unknown): x is SelectorConfig {
  if (!x || typeof x !== 'object') return false;
  const c = x as Record<string, unknown>;
  if (typeof c.version !== 'number' || !Array.isArray(c.sites) || c.sites.length > 50) return false;
  return c.sites.every((s: unknown) => {
    if (!s || typeof s !== 'object') return false;
    const site = s as Record<string, unknown>;
    return (
      isStr(site.id) &&
      isStr(site.name) &&
      isStrArr(site.hosts) &&
      isStrArr(site.composer) &&
      isStrArr(site.titleStrip) &&
      Array.isArray(site.messages) &&
      site.messages.every((m: unknown) => {
        if (!m || typeof m !== 'object') return false;
        const r = m as Record<string, unknown>;
        return (
          isStr(r.selector) &&
          (r.role === undefined || r.role === 'user' || r.role === 'assistant') &&
          (r.roleAttr === undefined || isStr(r.roleAttr)) &&
          (r.userIfClosest === undefined || isStr(r.userIfClosest))
        );
      })
    );
  });
}
