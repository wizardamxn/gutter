# Network interception — notes for later

**Status:** parked. V1 reads the chat from the page's HTML (DOM). Revisit when long chats or broken selectors become a real complaint.

## Why consider it
- Gets the **full, clean conversation**, including messages that are not rendered on screen (long or virtualized chats).
- Data formats change **less often** than CSS / page structure (but they still change).

## How it works
1. **Get into the page's own JS world.** Content scripts run in an isolated world and can't see the page's JavaScript. Inject a script into the page instead:
   - Manifest V3: a content script entry with `"world": "MAIN"` and `"run_at": "document_start"`, or
   - `chrome.scripting.executeScript({ world: "MAIN", ... })`.
2. **Wrap `fetch` (and `XMLHttpRequest`)** before the app captures its own reference:
   ```js
   const realFetch = window.fetch;
   window.fetch = async (...args) => {
     const res = await realFetch(...args);
     try {
       const url = typeof args[0] === 'string' ? args[0] : args[0].url;
       if (/\/backend-api\/conversation\/[\w-]+$/.test(url)) {
         res.clone().json().then((data) =>
           window.postMessage({ source: 'aside', type: 'conversation', data }, '*')
         );
       }
     } catch (_) {}
     return res; // the app gets the original response, untouched
   };
   ```
3. **Content script listens** for `window.postMessage` (check `event.source === window` and `data.source === 'aside'`) and forwards to the extension.
4. **Rebuild the active thread.** ChatGPT's conversation JSON is a tree (`mapping` of nodes with `parent` / `children`, plus `current_node`). Walk from `current_node` up to the root and reverse it to get the visible branch.

## Catches
- **Streaming replies** arrive as server-sent events. Parsing the tee'd stream is messy, so use a **hybrid**: network data for history on chat load, the DOM for live new messages.
- **Per-site difficulty** (to verify before building):
  - ChatGPT: clean JSON, easiest.
  - Claude: JSON from its API, moderate.
  - Gemini: nested-array "batchexecute" format, hard.
  - Grok: unknown, investigate.
- **Still needs upkeep.** Private endpoints and formats change without notice.
- **Store review scrutiny.** Patching `fetch` in the page's world gets a closer look. Keep the injected script tiny, read-only, and documented in the listing's privacy section.
- **Not viable alternatives:** `webRequest` in MV3 can't read response bodies; `chrome.debugger` can, but shows a "debugging this browser" banner to the user.

## Security rules if we build it
- Never modify requests or responses; only read clones.
- Only match exact conversation endpoints; ignore everything else (auth, billing, files).
- Validate `postMessage` origin and shape; never pass tokens or headers out of the page.
