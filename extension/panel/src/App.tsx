import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostedInfo, PageContext, Thread } from '../../../shared/types';
import { Gutter, type Mood } from './Gutter';
import { Settings } from './Settings';
import { ask, buildOptions, buildSystem, historyOf, secondOpinionOption, type Option } from './lib/ai';
import { api, ApiError } from './lib/api';
import { renderMarkdown } from './lib/markdown';
import {
  loadAuth,
  loadSettings,
  loadThreads,
  saveAuth,
  saveSettings,
  saveThreads,
  type Auth,
  type Settings as SettingsData
} from './lib/storage';
import { pullAndMerge, push } from './lib/sync';
import { getActiveTabId, sendToTab } from './lib/tab';

interface Store {
  key: string; // convKey these threads belong to
  threads: Thread[];
}

const QUOTE_CHIPS = [
  { label: 'Explain simply', text: 'Explain this in simple terms.' },
  { label: 'Is this right?', text: 'Is this accurate? Point out anything wrong or misleading.' },
  { label: 'Give an example', text: 'Give me a concrete example of this.' }
];

const SECOND_OPINION =
  'Give me a second opinion on this answer. Is it correct? Point out errors, gaps, or anything misleading. Be brief.';

const FOLLOW_UP =
  'Based on this side conversation, write ONE follow-up message I can send in the main chat to move it forward with what I learned here. Write it in my voice, self-contained and concise. Output only the message text.';

const errorText = (err: unknown) =>
  err instanceof Error && err.message ? err.message : 'Something went wrong. Try again?';

export default function App() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [auth, setAuth] = useState<Auth | null>(null);
  const [hosted, setHosted] = useState<HostedInfo | null>(null);
  const [ctx, setCtx] = useState<PageContext | null>(null);
  const [ctxReady, setCtxReady] = useState(false);
  const [store, setStoreState] = useState<Store>({ key: '', threads: [] });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ quote: string } | null>(null);
  const [view, setView] = useState<'main' | 'settings'>('main');
  const [busy, setBusy] = useState(false);
  const [mood, setMood] = useState<Mood>('idle');
  const [toast, setToast] = useState('');
  const [input, setInput] = useState('');

  // Mirrors for async code, which must not read stale state.
  const storeRef = useRef(store);
  const authRef = useRef(auth);
  const busyRef = useRef(false);
  const tabRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const setStore = (next: Store) => {
    storeRef.current = next;
    setStoreState(next);
  };
  const persist = () => {
    const s = storeRef.current;
    return s.key ? saveThreads(s.key, s.threads) : Promise.resolve();
  };
  const flash = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((t) => (t === message ? '' : t)), 3500);
  };

  // ----- threads for the open chat -----
  const syncNow = useCallback(async (convKey: string) => {
    const a = authRef.current;
    if (!a || !convKey) return;
    try {
      const merged = await pullAndMerge(a, convKey, storeRef.current.threads);
      if (storeRef.current.key !== convKey || busyRef.current) return;
      setStore({ key: convKey, threads: merged });
      await persist();
    } catch {
      /* offline: local copy still works */
    }
  }, []);

  const ensureStore = useCallback(
    async (convKey: string) => {
      if (storeRef.current.key === convKey) return;
      const threads = await loadThreads(convKey);
      if (storeRef.current.key === convKey) return;
      setStore({ key: convKey, threads });
      setActiveId(null);
      void syncNow(convKey);
    },
    [syncNow]
  );

  // ----- reading the chat tab -----
  const refreshCtx = useCallback(async (): Promise<PageContext | null> => {
    const tabId = await getActiveTabId();
    tabRef.current = tabId;
    const c = tabId != null ? await sendToTab<PageContext>(tabId, { type: 'gutter:getContext' }) : null;
    setCtx(c);
    setCtxReady(true);
    if (c) await ensureStore(c.convKey);
    return c;
  }, [ensureStore]);

  const consumePending = useCallback(async () => {
    const { pending } = await chrome.storage.session.get('pending');
    if (!pending) return;
    await chrome.storage.session.remove('pending');
    await refreshCtx();
    setView('main');
    setActiveId(null);
    setDraft({ quote: String((pending as { quote?: string }).quote ?? '') });
    window.setTimeout(() => inputRef.current?.focus(), 50);
  }, [refreshCtx]);

  useEffect(() => {
    void (async () => {
      const [s, a] = await Promise.all([loadSettings(), loadAuth()]);
      setSettings(s);
      authRef.current = a;
      setAuth(a);
      const c = await refreshCtx();
      // The content script may still be loading on a fresh page: try once more.
      if (!c) window.setTimeout(() => void refreshCtx(), 1200);
      await consumePending();
    })();

    const onActivated = () => void refreshCtx();
    const onUpdated = (tabId: number, info: { status?: string; url?: string }) => {
      if (tabId === tabRef.current && (info.status === 'complete' || info.url)) void refreshCtx();
    };
    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'session' && changes.pending?.newValue) void consumePending();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  }, [refreshCtx, consumePending]);

  // ----- account -----
  const refreshHosted = useCallback(async () => {
    const a = authRef.current;
    if (!a) return setHosted(null);
    try {
      setHosted(await api.hosted(a.token));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        authRef.current = null;
        setAuth(null);
        setHosted(null);
        void saveAuth(null);
      }
    }
  }, []);

  useEffect(() => {
    void refreshHosted();
  }, [auth, refreshHosted]);

  const changeAuth = (next: Auth | null) => {
    authRef.current = next;
    setAuth(next);
    void saveAuth(next);
    if (next) void syncNow(storeRef.current.key);
  };

  const changeSettings = (next: SettingsData) => {
    setSettings(next);
    void saveSettings(next);
  };

  // ----- answer sources -----
  const options = useMemo(() => (settings ? buildOptions(settings, auth, hosted) : []), [settings, auth, hosted]);
  const current = options.find((o) => o.id === settings?.choice) ?? options[0];

  useEffect(() => {
    if (mood !== 'happy') return;
    const t = window.setTimeout(() => setMood('idle'), 2500);
    return () => window.clearTimeout(t);
  }, [mood]);

  const threads = store.threads.filter((t) => !t.deleted);
  const active = activeId ? threads.find((t) => t.id === activeId) ?? null : null;
  const lastMessage = active?.messages[active.messages.length - 1];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active?.id, active?.messages.length, lastMessage?.content.length]);

  const upsert = (thread: Thread) => {
    const s = storeRef.current;
    if (s.key !== thread.convKey) return;
    const exists = s.threads.some((t) => t.id === thread.id);
    setStore({
      key: s.key,
      threads: exists ? s.threads.map((t) => (t.id === thread.id ? thread : t)) : [...s.threads, thread]
    });
  };

  // ----- asking -----
  const send = async (raw: string, o: { quote?: string; option?: Option; fresh?: boolean } = {}) => {
    const text = raw.trim();
    if (!text || busyRef.current || !settings) return;
    const option = o.option ?? current;
    if (!option) {
      setView('settings');
      flash('Sign in or add a key so I can answer.');
      return;
    }
    const c = await refreshCtx();
    if (!c) {
      flash("I can't see a chat in this tab.");
      return;
    }

    const now = Date.now();
    const existing = !o.fresh && activeId ? storeRef.current.threads.find((t) => t.id === activeId && !t.deleted) : undefined;
    const base: Thread = existing ?? {
      id: crypto.randomUUID(),
      convKey: c.convKey,
      site: c.site,
      title: text.slice(0, 80),
      quote: o.quote ?? draft?.quote ?? '',
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    let working: Thread = {
      ...base,
      updatedAt: now,
      messages: [...base.messages, { role: 'user', content: text }, { role: 'assistant', content: '', via: option.label }]
    };
    upsert(working);
    setActiveId(working.id);
    setDraft(null);
    setInput('');

    const setAnswer = (content: string, error = false) => {
      working = {
        ...working,
        updatedAt: Date.now(),
        messages: [
          ...working.messages.slice(0, -1),
          { role: 'assistant', content, via: option.label, ...(error ? { error: true } : {}) }
        ]
      };
      upsert(working);
    };

    busyRef.current = true;
    setBusy(true);
    setMood('thinking');
    const abort = new AbortController();
    abortRef.current = abort;
    let answer = '';
    try {
      const history = historyOf({ ...working, messages: working.messages.slice(0, -1) });
      for await (const chunk of ask(option, settings, authRef.current, buildSystem(c, working.quote), history, abort.signal)) {
        answer += chunk;
        setAnswer(answer);
      }
      if (answer.trim()) setMood('happy');
      else {
        setAnswer("I didn't get an answer back. Try again?", true);
        setMood('oops');
      }
    } catch (err) {
      if (abort.signal.aborted) {
        setAnswer(answer || 'Stopped.', !answer);
        setMood('idle');
      } else {
        setAnswer(errorText(err), true);
        setMood('oops');
      }
    } finally {
      abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
      await persist();
      void push(authRef.current, working);
      if (option.source === 'hosted') void refreshHosted();
    }
  };

  const secondOpinion = async () => {
    const c = await refreshCtx();
    const last = c ? [...c.messages].reverse().find((m) => m.role === 'assistant') ?? c.messages[c.messages.length - 1] : null;
    if (!c || !last) {
      flash("There's no answer in the main chat to check yet.");
      return;
    }
    await send(SECOND_OPINION, {
      quote: last.text.slice(0, 4000),
      option: secondOpinionOption(options, current, c.site),
      fresh: true
    });
  };

  const sendToMain = async (thread: Thread) => {
    if (busyRef.current || !settings || !current) return;
    const history = historyOf(thread);
    if (!history.length || tabRef.current == null) return;
    busyRef.current = true;
    setBusy(true);
    setMood('thinking');
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      let out = '';
      const messages = [...history, { role: 'user' as const, content: FOLLOW_UP }];
      for await (const chunk of ask(current, settings, authRef.current, buildSystem(ctx, thread.quote), messages, abort.signal)) {
        out += chunk;
      }
      if (!out.trim()) throw new Error("I couldn't write a follow-up. Try again?");
      const result = await sendToTab<{ ok: boolean; error?: string }>(tabRef.current, { type: 'gutter:insert', text: out.trim() });
      if (!result?.ok) throw new Error(result?.error ?? "I couldn't reach the chat tab.");
      flash("Dropped into the chat box. Edit it, then send when you're ready.");
      setMood('happy');
    } catch (err) {
      if (!abort.signal.aborted) {
        flash(errorText(err));
        setMood('oops');
      } else setMood('idle');
    } finally {
      abortRef.current = null;
      busyRef.current = false;
      setBusy(false);
    }
  };

  const removeThread = async (thread: Thread) => {
    const gone: Thread = { ...thread, deleted: true, messages: [], quote: '', title: '', updatedAt: Date.now() };
    upsert(gone);
    if (activeId === thread.id) setActiveId(null);
    await persist();
    void push(authRef.current, gone);
  };

  const jump = (quote: string) => {
    if (tabRef.current == null) return;
    void sendToTab<{ ok: boolean }>(tabRef.current, { type: 'gutter:jump', quote }).then((r) => {
      if (!r?.ok) flash("I couldn't find that spot in the chat anymore.");
    });
  };

  const goHome = () => {
    setActiveId(null);
    setDraft(null);
  };

  // ----- render -----
  if (!settings) return null;

  const inThread = !!active || !!draft;
  const quote = active?.quote ?? draft?.quote ?? '';
  const count = ctx?.messages.length ?? 0;

  return (
    <div className="app">
      <header className="top">
        <button className="brand" onClick={() => { setView('main'); goHome(); }} aria-label="Gutter home">
          <Gutter mood={mood} size={46} />
          <span>Gutter</span>
        </button>
        <button className="icon-btn" onClick={() => setView(view === 'settings' ? 'main' : 'settings')} aria-label="Settings" title="Settings">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
            <circle cx="16" cy="7" r="2.2" />
            <circle cx="8" cy="17" r="2.2" />
          </svg>
        </button>
      </header>

      {view === 'settings' ? (
        <main className="scroll">
          <Settings settings={settings} auth={auth} hosted={hosted} onSettings={changeSettings} onAuth={changeAuth} onBack={() => setView('main')} />
        </main>
      ) : !ctxReady ? (
        <main className="scroll" />
      ) : !ctx ? (
        <main className="scroll center">
          <Gutter mood="oops" size={120} />
          <div className="bubble">
            <b>I can't see a chat here.</b>
            <p>Open ChatGPT, Claude, Gemini or Grok. If you just installed me, refresh that tab once.</p>
            <button className="btn" onClick={() => void refreshCtx()}>
              Look again
            </button>
          </div>
        </main>
      ) : (
        <>
          <div className="context">
            <span className="chip" title={ctx.title || ctx.url}>
              <i className="dot" />
              {ctx.siteName} · {ctx.fallback ? 'reading page text' : `${count} message${count === 1 ? '' : 's'}`}
            </span>
            <button className="link" onClick={() => void refreshCtx()} title="Re-read the chat">
              Refresh
            </button>
          </div>

          <main className="scroll" ref={scrollRef}>
            {inThread ? (
              <>
                <button className="link back" onClick={goHome}>
                  ← All side notes
                </button>
                {quote && (
                  <button className="quote" onClick={() => jump(quote)} title="Jump to this spot in the chat">
                    <span className="quote-label">From the chat</span>
                    <span className="quote-text">{quote}</span>
                  </button>
                )}
                {active?.messages.map((m, i) =>
                  m.role === 'user' ? (
                    <div className="msg user" key={i}>
                      {m.content}
                    </div>
                  ) : (
                    <div className={`msg bot${m.error ? ' error' : ''}`} key={i}>
                      {m.content ? (
                        m.error ? (
                          <p>{m.content}</p>
                        ) : (
                          <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                        )
                      ) : (
                        <span className="typing" aria-label="Gutter is thinking">
                          <i />
                          <i />
                          <i />
                        </span>
                      )}
                      {m.via && m.content && !m.error && <span className="via">{m.via}</span>}
                    </div>
                  )
                )}
                {!active && draft && (
                  <div className="chips">
                    {QUOTE_CHIPS.map((c) => (
                      <button key={c.label} className="chip-btn" disabled={busy} onClick={() => void send(c.text)}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                )}
                {active && !busy && historyOf(active).length > 0 && (
                  <button className="btn to-main" onClick={() => void sendToMain(active)} title="Write a follow-up and put it in the main chat box (it won't send)">
                    Send to main ↗
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="hello">
                  <Gutter mood={mood} size={84} />
                  <div className="bubble">
                    <b>Psst. Ask me on the side.</b>
                    <p>Highlight anything in the chat and hit “Ask Gutter”, or type below. The main thread never hears about it.</p>
                  </div>
                </div>
                <div className="chips">
                  <button className="chip-btn" disabled={busy} onClick={() => void send('Explain the last answer in the main chat in simple terms.', { fresh: true })}>
                    Explain the last answer
                  </button>
                  <button className="chip-btn alt" disabled={busy} onClick={() => void secondOpinion()}>
                    Second opinion
                  </button>
                  <button className="chip-btn" disabled={busy} onClick={() => void send('Summarize the main chat so far in a few short bullets.', { fresh: true })}>
                    Summarize so far
                  </button>
                </div>
                {threads.length > 0 && (
                  <>
                    <h3 className="section">Side notes on this chat</h3>
                    <ul className="threads">
                      {[...threads].reverse().map((t) => (
                        <li key={t.id}>
                          <button className="thread" onClick={() => setActiveId(t.id)}>
                            <b>{t.title || 'Side note'}</b>
                            {t.quote && <span className="thread-quote">“{t.quote.slice(0, 90)}”</span>}
                          </button>
                          <button className="icon-btn small" onClick={() => void removeThread(t)} aria-label="Delete side note" title="Delete">
                            ×
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </>
            )}
          </main>

          <footer className="composer">
            <textarea
              ref={inputRef}
              rows={2}
              value={input}
              placeholder={active ? 'Follow up…' : quote ? 'Ask about the highlighted bit…' : 'Ask a side question…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <div className="composer-row">
              {options.length ? (
                <select
                  value={current?.id ?? ''}
                  onChange={(e) => changeSettings({ ...settings, choice: e.target.value })}
                  aria-label="Who answers"
                  title="Who answers"
                >
                  {options.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : (
                <button className="link" onClick={() => setView('settings')}>
                  Sign in or add a key →
                </button>
              )}
              {busy ? (
                <button className="btn stop" onClick={() => abortRef.current?.abort()}>
                  Stop
                </button>
              ) : (
                <button className="btn primary" disabled={!input.trim()} onClick={() => void send(input)}>
                  Ask
                </button>
              )}
            </div>
          </footer>
        </>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
