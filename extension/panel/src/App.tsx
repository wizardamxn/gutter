import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostedInfo, PageContext, Thread } from '../../../shared/types';
import { Gutter, type Mood } from './Gutter';
import { Settings } from './Settings';
import { ask, CANT_FIND, shownLabel, type AnswerLabel, buildOptions, historyOf, NANO_OPTION, secondOpinionOption, warmIndex, type Option } from './lib/ai';
import { api, ApiError, UPGRADE_URL } from './lib/api';
import { watchIndexing } from './lib/embed';
import { nanoStatus, type NanoStatus } from './lib/nano';
import { renderMarkdown } from './lib/markdown';
import type { Likely } from './lib/retrieve';
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
  // "Might answer it" passages, by "threadId:message index". Chat text: kept in memory only, never stored.
  const [likely, setLikely] = useState<Record<string, Likely>>({});
  const [nano, setNano] = useState<NanoStatus | 'checking'>('checking');
  const [status, setStatus] = useState(''); // e.g. model download progress
  const [indexing, setIndexing] = useState<number | null>(null); // share of a long chat indexed so far
  useEffect(() => {
    watchIndexing(setIndexing);
    return () => void watchIndexing(null);
  }, []);

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
    warmIndex(c); // long chats start indexing in the background
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
      void nanoStatus().then(setNano);
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
  const options = useMemo(() => (settings ? buildOptions(settings, auth, hosted, nano) : []), [settings, auth, hosted, nano]);
  const current = options.find((o) => o.id === settings?.choice) ?? options[0];
  // Free accounts get a few smart answers, ever. After that the smart models are locked.
  const smartLocked = !!hosted && hosted.plan === 'free' && hosted.used >= hosted.freeLimit;
  const lockedNow = smartLocked && current?.source === 'hosted';
  const usable = options.filter((o) => !(o.source === 'hosted' && smartLocked));
  const canCompare = !!ctx && !!secondOpinionOption(usable, current, ctx.site);

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
  const send = async (raw: string, o: { quote?: string; option?: Option; fresh?: boolean; whole?: 'last' | 'chat'; anyway?: boolean } = {}) => {
    const text = raw.trim();
    if (!text || busyRef.current || !settings) return;
    const option = o.option ?? current;
    if (!option) {
      setView('settings');
      flash(nano === 'checking' ? 'One moment, still starting up.' : 'Sign in to use a smart model.');
      return;
    }
    if (option.source === 'hosted' && smartLocked) {
      // The paywall above the question box already explains this when it is showing.
      if (!lockedNow) flash(`You've used your ${hosted?.freeLimit ?? 3} free smart answers.`);
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

    let sources: { label: string; snippet: string }[] = [];
    let unverified = false;
    let label: AnswerLabel | null = null;
    let maybe: Likely | null = null;
    const setAnswer = (content: string, error = false) => {
      working = {
        ...working,
        updatedAt: Date.now(),
        messages: [
          ...working.messages.slice(0, -1),
          {
            role: 'assistant',
            content,
            via: option.label,
            ...(error ? { error: true } : { ...(sources.length ? { sources } : {}), ...(unverified ? { unverified } : {}), ...(label ? { label } : {}) })
          }
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
      const stream = ask({
        option,
        settings,
        auth: authRef.current,
        ctx: c,
        messages: history,
        quote: working.quote,
        whole: o.whole,
        anyway: o.anyway,
        cite: true,
        signal: abort.signal,
        onStatus: setStatus,
        onDone: (checked) => {
          answer = checked.text;
          sources = checked.sources;
          unverified = checked.unverified;
          label = checked.label;
          maybe = checked.likely;
        }
      });
      for await (const chunk of stream) {
        answer += chunk;
        setAnswer(answer);
      }
      setAnswer(answer); // without the citation line, with verified sources
      const found = maybe as Likely | null;
      if (found) setLikely((l) => ({ ...l, [`${working.id}:${working.messages.length - 1}`]: found }));
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
      setStatus('');
      await persist();
      void push(authRef.current, working);
      if (option.source === 'hosted') void refreshHosted();
      if (option.source === 'nano') void nanoStatus().then(setNano);
    }
  };

  const secondOpinion = async () => {
    const c = await refreshCtx();
    const last = c ? [...c.messages].reverse().find((m) => m.role === 'assistant') ?? c.messages[c.messages.length - 1] : null;
    if (!c || !last) {
      flash("There's no answer in the main chat to check yet.");
      return;
    }
    const option = secondOpinionOption(usable, current, c.site);
    if (!option) {
      setView('settings');
      flash('A second opinion needs a smart model. Sign in to try one.');
      return;
    }
    await send(SECOND_OPINION, { quote: last.text.slice(0, 4000), option, fresh: true });
  };

  const sendToMain = async (thread: Thread) => {
    if (busyRef.current || !settings || !current) return;
    if (lockedNow) {
      flash(`You've used your ${hosted?.freeLimit ?? 3} free smart answers.`);
      return;
    }
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
      const stream = ask({ option: current, settings, auth: authRef.current, ctx, messages, quote: thread.quote, signal: abort.signal, onStatus: setStatus });
      for await (const chunk of stream) {
        out += chunk;
      }
      if (!out.trim()) throw new Error("I couldn't write a follow-up. Try again?");
      const result = await sendToTab<{ ok: boolean; error?: string }>(tabRef.current, { type: 'gutter:insert', text: out.trim() });
      if (!result?.ok) throw new Error(result?.error ?? "I couldn't reach the chat tab.");
      flash("Follow-up added to the chat box. It hasn't been sent.");
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
      setStatus('');
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
  const showChat = view === 'main' && ctxReady && !!ctx;
  const chips = draft
    ? QUOTE_CHIPS.map((c) => ({ label: c.label, alt: false, run: () => void send(c.text) }))
    : [
        { label: 'Explain the last answer', alt: false, run: () => void send('Explain the last answer in the main chat in simple terms.', { fresh: true, whole: 'last' }) },
        ...(canCompare ? [{ label: 'Get a second opinion', alt: true, run: () => void secondOpinion() }] : []),
        { label: 'Summarize so far', alt: false, run: () => void send('Summarize the main chat so far in a few short bullets.', { fresh: true, whole: 'chat' }) }
      ];

  return (
    <div className="app">
      <header className="top">
        <div className="reading" title={view === 'main' ? ctx?.title || ctx?.url || '' : ''}>
          {view === 'settings' ? (
            <b>Settings</b>
          ) : ctx ? (
            <>
              <b>{ctx.siteName}</b>
              <span>{ctx.fallback ? 'reading page text' : `${count} message${count === 1 ? '' : 's'}`}</span>
              {indexing !== null && <span className="indexing">indexing this chat, {Math.round(indexing * 100)}%</span>}
            </>
          ) : (
            <b>Gutter</b>
          )}
        </div>
        <div className="top-actions">
          {showChat && (
            <button className="icon-btn" onClick={() => void refreshCtx()} aria-label="Re-read the chat" title="Re-read the chat">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
              </svg>
            </button>
          )}
          <button
            className="icon-btn settings-btn"
            onClick={() => setView(view === 'settings' ? 'main' : 'settings')}
            aria-label={view === 'settings' ? 'Close settings' : 'Settings'}
            title={view === 'settings' ? 'Close settings' : 'Settings'}
          >
            {view === 'settings' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 8h9M19 8h1M4 16h1M11 16h9" />
                <circle cx="16" cy="8" r="2.5" />
                <circle cx="8" cy="16" r="2.5" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {view === 'settings' ? (
        <main className="scroll">
          <Settings settings={settings} auth={auth} hosted={hosted} nano={nano} onSettings={changeSettings} onAuth={changeAuth} />
        </main>
      ) : !ctxReady ? (
        <main className="scroll" />
      ) : !ctx ? (
        <main className="scroll empty">
          <Gutter mood="oops" size={64} />
          <h1>No chat in this tab</h1>
          <p>Open ChatGPT, Claude, Gemini or Grok. If you just installed Gutter, refresh that tab once.</p>
          <button className="btn" onClick={() => void refreshCtx()}>
            Check again
          </button>
        </main>
      ) : (
        <>
          <main className="scroll" ref={scrollRef}>
            {inThread ? (
              <article className="note">
                <button className="back" onClick={goHome}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M15 5l-7 7 7 7" />
                  </svg>
                  All notes
                </button>
                {quote && (
                  <button className="quote" onClick={() => jump(quote)} title="Show this in the chat">
                    <span className="quote-text">{quote}</span>
                  </button>
                )}
                {active?.messages.map((m, i) =>
                  m.role === 'user' ? (
                    <h2 className="q" key={i}>
                      {m.content}
                    </h2>
                  ) : (
                    <div className={`a${m.error ? ' error' : ''}`} key={i}>
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
                          {status && <em>{status}</em>}
                        </span>
                      )}
                      {m.sources && m.sources.length > 0 && !m.error && (
                        <div className="sources">
                          <span>Based on</span>
                          {m.sources.map((s, n) => (
                            <button key={n} onClick={() => jump(s.snippet)} title={s.snippet}>
                              {s.label}
                            </button>
                          ))}
                        </div>
                      )}
                      {likely[`${active.id}:${i}`] && !m.error && <MightAnswer l={likely[`${active.id}:${i}`]} onJump={jump} />}
                      {!m.error && shownLabel(m.content, m.label ?? (m.general ? 'general' : null)) && (
                        <span className="general-label" title={LABEL_TITLE[m.label ?? 'general']}>
                          {LABEL_TEXT[m.label ?? 'general']}
                        </span>
                      )}
                      {!busy && !m.error && i > 0 && (m.label === 'chat' || (!m.label && !m.general && CANT_FIND.test(m.content))) && (
                        <button
                          className="anyway"
                          onClick={() => void send(active.messages[i - 1].content, { anyway: true })}
                          title="Ask again, allowing general knowledge"
                        >
                          Answer anyway
                        </button>
                      )}
                      {m.unverified && !m.error && (
                        <span className="unverified" title="The answer didn't point to any part of the chat that was given to the model. Check it against the chat.">
                          Unverified: no part of the chat backs this
                        </span>
                      )}
                      {m.via && m.content && !m.error && <span className="via">{m.via}</span>}
                    </div>
                  )
                )}
                {active && !busy && historyOf(active).length > 0 && (
                  <button className="btn to-main" onClick={() => void sendToMain(active)} title="Writes a follow-up into the main chat box. It is not sent.">
                    Draft a follow-up in the main chat
                  </button>
                )}
              </article>
            ) : threads.length > 0 ? (
              <>
                <h1 className="list-title">Side notes</h1>
                <ul className="threads">
                  {[...threads].reverse().map((t) => (
                    <li key={t.id}>
                      <button className="thread" onClick={() => setActiveId(t.id)}>
                        <b>{t.title || 'Side note'}</b>
                        {t.quote && <span>{t.quote.slice(0, 120)}</span>}
                      </button>
                      <button className="icon-btn remove" onClick={() => void removeThread(t)} aria-label="Delete this note" title="Delete">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                          <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <div className="intro">
                <h1>Ask about this chat, on the side</h1>
                <p>Highlight text in the chat and choose Ask Gutter, or type below. Nothing you ask here is added to the main chat.</p>
              </div>
            )}
          </main>

          <footer className="dock">
            {lockedNow && (
              <div className="paywall">
                <b>You've used your {hosted?.freeLimit} free smart answers</b>
                <p>
                  {UPGRADE_URL ? 'Upgrade to keep asking the smart models.' : "Paid plans aren't open yet."}
                  {options.includes(NANO_OPTION) ? ' The built-in model stays free.' : ''}
                </p>
                <div className="row">
                  {UPGRADE_URL && (
                    <a className="btn primary" href={UPGRADE_URL} target="_blank" rel="noreferrer">
                      Upgrade
                    </a>
                  )}
                  {options.includes(NANO_OPTION) && (
                    <button className="btn" onClick={() => changeSettings({ ...settings, choice: NANO_OPTION.id })}>
                      Use the built-in model
                    </button>
                  )}
                </div>
              </div>
            )}
            {!active && !lockedNow && (
              <div className="chips">
                {chips.map((c) => (
                  <button key={c.label} className={`chip-btn${c.alt ? ' alt' : ''}`} disabled={busy} onClick={c.run}>
                    {c.label}
                  </button>
                ))}
              </div>
            )}
            <div className="composer">
              <Gutter mood={mood} size={52} className="peek" />
              <i className="paw left" />
              <i className="paw right" />
              <textarea
                ref={inputRef}
                rows={2}
                value={input}
                placeholder={active ? 'Ask a follow-up' : quote ? 'Ask about the highlighted text' : 'Ask a side question'}
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
                    onChange={(e) => {
                      if (e.target.value === 'signin') setView('settings');
                      else changeSettings({ ...settings, choice: e.target.value });
                    }}
                    aria-label="Model that answers"
                    title="Model that answers"
                  >
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                    {!auth && <option value="signin">Smart model (sign in, 3 free)</option>}
                  </select>
                ) : nano === 'checking' ? (
                  <span />
                ) : (
                  <button className="text-btn" onClick={() => setView('settings')}>
                    Sign in to use a smart model
                  </button>
                )}
                {busy ? (
                  <button className="send stop" onClick={() => abortRef.current?.abort()} aria-label="Stop" title="Stop">
                    <svg width="12" height="12" viewBox="0 0 12 12">
                      <rect width="12" height="12" rx="2.5" fill="currentColor" />
                    </svg>
                  </button>
                ) : (
                  <button className="send" disabled={!input.trim() || lockedNow} onClick={() => void send(input)} aria-label="Ask" title="Ask">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
                    </svg>
                  </button>
                )}
              </div>
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

/** Under a "can't find" answer: the part of the chat code thinks might answer it. */
function MightAnswer({ l, onJump }: { l: Likely; onJump: (quote: string) => void }) {
  return (
    <div className="likely">
      <span>This part of the chat might answer it:</span>
      <blockquote>{l.passage}</blockquote>
      <button onClick={() => onJump(l.passage)} title="Show this in the chat">
        {l.source.label}
      </button>
    </div>
  );
}

const LABEL_TEXT = { chat: 'From the chat', mixed: 'From the chat + general knowledge', general: 'General knowledge' };
const LABEL_TITLE = {
  chat: 'Code found most of this answer in the parts of the chat the model was given.',
  mixed: 'Code found some of this answer in the chat; the rest comes from general knowledge.',
  general: "Code found nothing in this answer that came from the chat. It's the model's general knowledge."
};
