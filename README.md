# Gutter

Side questions for AI chats. Gutter is a browser side panel that reads the chat you have open on
ChatGPT, Claude, Gemini or Grok and answers side questions about it, so the main thread stays clean.
Gutter is also the mascot: a little strip of notebook margin who lives at the edge of the page.

## What V1 does

- **Side panel** on ChatGPT, Claude, Gemini and Grok (toolbar icon or `Alt+Shift+S`).
- **Reads the open chat** from the page's HTML, using per-site selectors.
- **Highlight → "Ask Gutter"**: the highlighted text is quoted in a new side note.
- **Side notes**: follow-ups, streaming answers, saved per chat.
- **Second opinion**: checks the main chat's last answer with a model from a *different* company.
- **Quick actions**: explain simply, second opinion, summarize so far.
- **Send to main**: writes a follow-up and drops it in the main chat box. It never sends by itself.
- **Jump to source**: click a side note's quote to scroll back to that spot.
- **Two ways to get answers**: your own API key (direct to the provider), or sign in for free daily
  answers hosted by the Gutter server. Signed-in users also get side notes synced across devices.

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
4. Click the Gutter icon, open settings (top right), paste an OpenAI, Claude or Gemini API key.
5. Highlight something in the chat → **Ask Gutter**.

To rebuild after changes:

```bash
cd extension
npm install
npm run build          # GUTTER_API_URL=https://your-server npm run build  for production
npm test               # end-to-end test in Chrome (set CHROME_PATH if needed)
```

## Run the server (accounts, sync, hosted answers)

Needs Node 20+ and MongoDB (local, or a free MongoDB Atlas cluster).

```bash
cd server
npm install
cp .env.example .env   # set JWT_SECRET, MONGODB_URI, and any model API keys
npm run dev            # http://localhost:4000
npm test               # API tests (downloads an in-memory MongoDB the first time)
```

The extension build in this zip points at `http://localhost:4000`. With the server running, the
panel's settings let you create an account; hosted models appear in the model picker for each
API key set in `.env`.

| Endpoint | What it does |
|---|---|
| `POST /api/auth/signup`, `/login`, `GET /me` | Email + password accounts, JWT (30 days) |
| `GET /api/threads?convKey=`, `PUT /api/threads/:id` | Side-note sync; newest copy wins; deletes leave a marker |
| `GET /api/ai/providers`, `POST /api/ai/chat` | Hosted answers, streamed; per-user daily limit (`FREE_DAILY_LIMIT`) |
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

Tested here (`extension/test/e2e.mjs`, 13 checks, real Chrome with the built extension):
reading all four sites **from fixture pages**, the Ask Gutter button, quote hand-off, streaming,
markdown, send to main, second opinion routing, jump to source, local saving.

Not yet tested, do these first:

- **Selectors against the live sites.** The fixtures copy the markup the selectors expect; the real
  pages need checking, Grok most of all. If a site reads as "reading page text", its selectors need a fix.
- **Real model calls.** Provider calls were tested against mocked responses. Default model ids
  (`shared/providers.ts`) were taken from the providers' docs in Nov 2026 and are editable in settings.
- **Server with a database.** The server typechecks, builds, and its no-database routes were
  smoke-tested, but `server/test/api.test.ts` could not run in the build sandbox (no MongoDB
  available). Run `npm test` in `server/` once.
- **The real side panel.** Tests open the panel as a tab; the toolbar/shortcut opening path is untested.

## Privacy and security notes

- The chat is read only when you ask. It goes to the model you picked: straight to the provider
  with your own key, or through the Gutter server for hosted models. The server does not store chat context.
- Signed-in users' side notes (question, answer, quote) are stored in MongoDB for sync.
- API keys are kept in `chrome.storage.local` on the device, unencrypted, and sent only to their provider.
- Model output is sanitized (DOMPurify) before rendering. Chat text is passed to the model as
  reference material with an instruction not to follow instructions inside it.
- Server: bcrypt password hashes, validated inputs (zod), rate limits on auth and AI, CORS limited
  to extension origins (set `EXTENSION_ID` in production), helmet headers.
- Before a public launch: password reset, email verification, a privacy policy, and HTTPS for the server.

## Known limits

- Very long chats: sites may only keep recent messages on the page, so older ones can be missing.
  See `docs/network-interception.md` for the planned fix.
- Side notes made on a brand-new chat (before it has its own URL) stay attached to the home page.
- Chrome and other Chromium browsers only. No mobile.
