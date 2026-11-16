# Gutter

Side questions for AI chats. Gutter is a browser side panel that reads the chat you have open on
ChatGPT, Claude, Gemini or Grok and answers side questions about it, so the main thread stays clean.
Gutter is also the mascot: a small blue fellow who peeks over the edge of the question box.
The panel itself is deliberately quiet (light and dark mode); he is the only playful thing in it.

How it all works, and why each choice was made: see `ARCHITECTURE.md`.

## What V1 does

- **Side panel** on ChatGPT, Claude, Gemini and Grok (toolbar icon or `Alt+Shift+S`).
- **Reads the open chat** from the page's HTML, using per-site selectors.
- **Highlight → "Ask Gutter"**: the highlighted text is quoted in a new side note.
- **Side notes**: follow-ups, streaming answers, saved per chat.
- **Second opinion**: checks the main chat's last answer with a cloud model from a *different*
  company. Only offered when a smart model or an own key is usable.
- **Quick actions**: explain simply, second opinion, summarize so far.
- **Send to main**: writes a follow-up and drops it in the main chat box. It never sends by itself.
- **Jump to source**: click a side note's quote to scroll back to that spot.
- **Long chats**: code picks the parts of the chat that match your question (by words and by
  meaning) so answers stay quick and focused. Each answer lists the parts it was based on.
- **Huge answers**: "Explain the last answer" reads an over-long answer in parts.
- **Three ways to get answers**
  - **Built-in (free, always)**: Chrome's on-device model (Gemini Nano, Prompt API). No sign-in, no
    key, nothing leaves the computer. It is small: about 9,000 tokens of context, so Gutter sends
    the highlighted text plus the most recent messages that fit. Good for explaining and
    summarizing; unreliable for fact-checking.
  - **Smart models (3 free answers per account, then paid)**: cloud models through the Gutter
    server. They read the whole chat and power "second opinion". Needs sign-in.
  - **Your own API key** (Settings → Advanced): direct to the provider, no limit.
- Signed-in users also get side notes synced across devices.

## Layout

```
extension/   Chrome extension (Manifest V3). React + TypeScript side panel, content script, worker.
server/      Express + MongoDB (Mongoose) + TypeScript. Accounts, thread sync, hosted AI, selector config.
shared/      Types, model-provider streaming, and the site selectors. Used by both.
docs/        Notes for later (network interception).
```

## Try the extension (2 minutes, no server needed)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → pick `extension/dist` (already built in this zip).
3. Open a chat on chatgpt.com, claude.ai, gemini.google.com or grok.com. Refresh the tab once.
4. Click the Gutter icon. If your Chrome can run the built-in model, just ask; the first question
   may trigger a one-time model download (about 4 GB). Settings shows its status.
5. Highlight something in the chat → **Ask Gutter**.

No built-in model on your machine? Settings → Advanced → paste an OpenAI, Claude or Gemini key.

To rebuild after changes:

```bash
cd extension
npm install
npm run build          # GUTTER_API_URL=https://your-server GUTTER_UPGRADE_URL=https://... npm run build
npm test               # end-to-end test in Chrome (set CHROME_PATH if needed)
```

## Run the server (accounts, sync, smart answers)

Needs Node 20+ and MongoDB (local, or a free MongoDB Atlas cluster).

```bash
cd server
npm install
cp .env.example .env   # set JWT_SECRET, MONGODB_URI, and any model API keys
npm run dev            # http://localhost:4000
npm test               # API tests (downloads an in-memory MongoDB the first time)
```

The extension build in this zip points at `http://localhost:4000`. With the server running, the
panel's settings let you create an account; a "Smart: …" entry appears in the model picker for each
API key set in `.env`.

### Free and paid

A free account gets `FREE_SMART_ANSWERS` (default 3) smart answers in total. After that the panel
shows a paywall and the server answers `402`. There is no billing yet: mark an account paid by hand.

```bash
curl -X PUT $API/api/admin/plan -H "x-admin-token: $ADMIN_TOKEN" \
     -H "content-type: application/json" -d '{"email":"someone@example.com","plan":"paid"}'
```

The paywall's Upgrade button only appears when the extension is built with `GUTTER_UPGRADE_URL`.

| Endpoint | What it does |
|---|---|
| `POST /api/auth/signup`, `/login`, `GET /me` | Email + password accounts, JWT (30 days) |
| `GET /api/threads?convKey=`, `PUT /api/threads/:id` | Side-note sync; newest copy wins; deletes leave a marker |
| `GET /api/ai/providers`, `POST /api/ai/chat` | Smart answers, streamed; free accounts stop at `FREE_SMART_ANSWERS`, then `402` |
| `PUT /api/admin/plan` | Mark an account `paid` or `free` (needs `x-admin-token`) |
| `GET /api/config/selectors` | Site selectors the extension polls every 6 hours |
| `PUT /api/config/selectors` | Publish a selector fix (needs `x-admin-token`) |

### When a chat site changes its page

Edit the selectors (see `shared/selectors.ts` for the shape), bump `version`, and publish:

```bash
curl -X PUT $API/api/config/selectors -H "x-admin-token: $ADMIN_TOKEN" \
     -H "content-type: application/json" -d @selectors.json
```

Extensions pick it up within 6 hours, with no Chrome Web Store release.

## Tested, and not yet tested

Tested here (`npm test` in `extension/`: 12 unit tests, then 18 checks in real Chrome with the
built extension): reading all four sites **from fixture pages**, the Ask Gutter button, streaming,
side notes, send to main, second opinion, the paywall, long-chat selection, fitting the built-in
model's token limit, multi-step reading with the quote check, and the meaning matcher running
inside the extension. The built-in model and the embedding model are stand-ins in these tests.

Not yet tested, do these first:

- **Selectors against the live sites.** The fixtures copy the markup the selectors expect; the real
  pages need checking, Grok most of all. If a site reads as "reading page text", its selectors need a fix.
- **The real built-in model.** The test uses a stand-in for Chrome's `LanguageModel` API. The real
  thing (availability check, download progress, streaming, the context budget in
  `panel/src/lib/nano.ts`) needs trying on a machine that can run Gemini Nano.
- **The real embedding model.** Tests use a tiny stand-in (`test/fake-model`). The real one is
  downloaded from Hugging Face on first need; its speed and match quality are unmeasured.
- **Real model calls.** Provider calls were tested against mocked responses. Default model ids
  (`shared/providers.ts`) were taken from the providers' docs in Nov 2026 and are editable in settings.
- **Server with a database.** The server typechecks, builds, and its no-database routes were
  smoke-tested, but `server/test/api.test.ts` could not run in the build sandbox (no MongoDB
  available). Run `npm test` in `server/` once.
- **The real side panel.** Tests open the panel as a tab; the toolbar/shortcut opening path is untested.

## Privacy and security notes

- The chat is read only when you ask. With the built-in model it never leaves the computer. With a
  smart model it goes through the Gutter server (which does not store it); with your own key it
  goes straight to the provider.
- Signed-in users' side notes (question, answer, quote) are stored in MongoDB for sync.
- API keys are kept in `chrome.storage.local` on the device, unencrypted, and sent only to their provider.
- Model output is sanitized (DOMPurify) before rendering. Chat text is passed to the model as
  reference material with an instruction not to follow instructions inside it.
- Server: bcrypt password hashes, validated inputs (zod), rate limits on auth and AI, CORS limited
  to extension origins (set `EXTENSION_ID` in production), helmet headers.
- Before a public launch: billing, password reset, email verification, a privacy policy, and HTTPS
  for the server. Free smart answers are counted per account, so email verification matters: without
  it, anyone can make new accounts for 3 more.

## Known limits

- Very long chats: sites may only keep recent messages on the page, so older ones can be missing.
  See `docs/network-interception.md` for the planned fix.
- Side notes made on a brand-new chat (before it has its own URL) stay attached to the home page.
- Chrome and other Chromium browsers only. No mobile.
