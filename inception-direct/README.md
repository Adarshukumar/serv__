# Mercury · Inception Direct

A typographic chat for **Mercury**, Inception's diffusion language model, that talks to
**chat.inceptionlabs.ai straight from your own browser**:

- no server of ours and no proxy
- your own IP and your own browser session
- every word is streamed live from the model and typeset as it arrives

It is a TypeScript port of `My PREVIOUS ENTIRE SERVER/API/providers/Inception.py`. The
Python provider ran on a server through a hard-coded proxy. This version moves the whole
thing into the browser and fixes the provider's bugs (see [What changed](#what-changed-from-inceptionpy)).

---

## Why it is a browser extension

A normal web page **cannot** do this. When a page on one site calls
`chat.inceptionlabs.ai`, the browser blocks the call (CORS). The site also sits behind
**Vercel's bot checkpoint**, which only lets real browsers through. A plain request from a
server gets `429` + `x-vercel-mitigated: challenge` (checked on 2026-09-24).

An **extension page** is allowed to make those requests. Chrome's documentation:

> Requests from an extension to a third-party are treated as same-site if the extension has
> host permissions for the third-party.

So the extension's chat page calls Inception directly, and the browser attaches the site's
own cookies, including the checkpoint clearance. Every request leaves your computer,
from your IP, just as if you were using chat.inceptionlabs.ai yourself.

Works in Chromium browsers: Chrome, Edge, Brave, Arc, Opera and Vivaldi (version 116 or newer).

## Install

```bash
cd inception-direct
npm install
npm run build          # type-check + build the extension into dist/
```

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the `inception-direct/dist` folder.
4. Click the **Mercury** icon in the toolbar. The chat opens in a tab, and the session is created right away.

To update later, run `npm run build` again and press the reload icon on the extension card.
`npm run zip` packs `dist/` into `inception-direct-<version>.zip` if you want to share it.

## How it works

```
open the page ──► GET /api/session ──► token + session cookie (stored by the browser)
                        │
                        ├── every 10 min while the page is visible: new token
                        │   (the web app itself renews every 13 min; we renew a bit earlier)
                        │
you send ───────► POST /api/chat  (x-session-token, your history, thinking mode, web search)
                        │
                        ◄── Server-Sent Events: thinking · sources · answer tokens · finish
                        │
                        └── POST /api/follow-ups ──► suggested next questions (from the server)
```

Recovery, all automatic:

| What happens | What the app does |
| --- | --- |
| Security checkpoint (`429` + `x-vercel-mitigated: challenge`) | Shows **Run the security check**. It opens chat.inceptionlabs.ai in a tab, where your browser passes the check. The tab closes by itself when the site answers, and the failed message is retried. |
| `429` rate limit | Retries after 1.5 s, then after 3 s, like the web app does. |
| `401`/`403` | Creates a new session once and retries. |
| Direct calls refused (Automatic mode) | Switches to the **site-tab route**. The request runs *inside* a chat.inceptionlabs.ai tab through a small content script, so it is truly same-origin. It still runs only in your browser. |
| Connection lost / offline | Shows **Reconnect**, and reconnects by itself when the browser comes back online. |

**Header rule.** A `declarativeNetRequest` rule gives the extension's own requests to
`chat.inceptionlabs.ai/api/*` the site's `Origin` and `Referer`, which are the same values the web app
sends. The rule is limited to requests made *by this extension* (`initiatorDomains: [extension id]`).
It never touches requests from web pages.

## The typography UI

- **Typefaces:** Fraunces for display type, Newsreader for reading (or Inter, if you prefer sans), Inter small caps for labels, and JetBrains Mono for code. All fonts are bundled, so nothing is downloaded from font CDNs.
- **Conversation layout:** your question is set in large italic display type, like an interview. Answers are set in book type at a comfortable measure, with old-style figures, balanced headings, hanging punctuation, optional drop caps, and an asterism (⁂) between exchanges.
- **Streaming:** a caret sits after the last word while tokens arrive. **Thinking** appears as a collapsible note with a live one-line ticker. **Sources** are listed like footnotes, deduplicated. **Follow-ups** come from the server.
- **Markdown:** tables, task lists, highlighted code with copy buttons, and TeX math via KaTeX. The math parser is strict, so "$5 and $10" stays text.
- **Controls:**
  - Paper and Night themes
  - reading size from 15 to 24 px
  - thinking mode: Instant, Low, Medium or High
  - web search on or off
  - custom instructions
  - keyboard: `Enter` sends, `Shift+Enter` adds a new line, `Esc` stops, `Ctrl/⌘+Shift+O` starts a new chat
- **Storage:** conversations are saved in your browser (IndexedDB) and nowhere else.

## Protocol notes

Taken from the live web app's own client code on **2026-09-24**. It is a Next.js app that uses the
Vercel AI SDK.

- **Session:** `GET /api/session` returns `{ "ok": true, "token": "<unix>.<32 hex>.<64 hex>" }` and sets a session cookie. The web app renews it every 780 000 ms and sends it as `x-session-token`.
- **Chat:** `POST /api/chat` with the body below. `messages` is a list of `{ id, role, parts: [{ type: "text", text }] }`; assistant parts also have `state: "done"`.
  ```json
  { "reasoningEffort": "instant|low|medium|high", "webSearchEnabled": true, "voiceMode": false,
    "timezone": "Asia/Calcutta", "id": "<chat id>", "messages": [...], "trigger": "submit-message" }
  ```
- **Stream:** SSE lines of the form `data: {json}`, in the AI SDK UI-message format:
  - `reasoning-delta`
  - `text-delta`
  - `source-url`. A source titled `__searching__` means a search is running; `__search_error__` means the search failed.
  - `error`
  - `finish`
  - the stream ends with `data: [DONE]`
- **Follow-ups:** `POST /api/follow-ups` with `{ messages: [{ role, parts }] }` returns `{ follow_ups: [...] }`.
- **No system role:** custom instructions are prepended to the first user message as `[SYSTEM INSTRUCTION] …`. This is the same approach the Python provider used.

This is the web app's *internal* API, not a published one, so it can change without notice.
All protocol details live in `src/core/config.ts`.

## What changed from Inception.py

| Inception.py | Here |
| --- | --- |
| Runs on a server, through a hard-coded proxy (`217.217.249.160:8080`) | Runs in your browser, on your IP. No proxy. |
| `cloudscraper`, which cannot pass Vercel's current checkpoint | A real browser passes it; the app detects the checkpoint and walks you through it |
| Refreshed the token every 90 s from a background thread | Renews every 10 min (the site uses 13), right before sending if needed, and once on 401/403 |
| Reasoning, a JSON blob of sources, and the answer mixed into one text stream | Typed events: reasoning, text, source, searching, error, finish |
| Kept only the **first** web source | Keeps every source, deduplicated by URL |
| Dropped `error` events silently | Shows them on the message, keeping the partial answer |
| Decoded each network chunk separately, so split characters became `���` | Streaming UTF-8 decoder; tested byte by byte with Devanagari and emoji |
| `reasoningEffort` hard-coded to `"high"`; no `timezone` | All four thinking modes; sends `timezone` like the web app |
| Shared state across calls, a fixed conversation id, and instances kept alive by `atexit` | Per-conversation ids and history; a request can be cancelled at any time with `AbortController` |
| A 1.5–4 s sleep before every token fetch | No artificial delays |

## Privacy and security

- **Network:** the only host this app contacts is chat.inceptionlabs.ai. Fonts are bundled. Images in answers become links instead of being loaded, so no third-party requests happen.
- **Model output:** it is sanitized with DOMPurify before it is shown (no scripts, event handlers, iframes, or `javascript:` links).
- **Content script:** it only runs *same-origin* requests for the extension and does nothing until the extension asks. Web pages cannot talk to it.
- **Permissions:** host access to `chat.inceptionlabs.ai` and `declarativeNetRequestWithHostAccess`. Nothing else.

## Development

```bash
npm run dev          # the UI as a normal web page (http://localhost:5173)
npm test             # unit + integration tests (Vitest)
npm run typecheck    # TypeScript 7
npm run build        # type-check + extension build into dist/
npm run check        # all of the above
CHROME_PATH=/path/to/chrome npm run test:e2e   # drive the real UI in Chromium, with screenshots
```

As a normal web page (`npm run dev`), the app shows why it can't reach Inception from there and
how to install the extension. Nothing is faked.

```
src/
  core/        framework-free client, the actual port of Inception.py
    config.ts      protocol constants (endpoints, header, thinking modes)
    session.ts     SessionManager: create, single-flight, freshness, reset
    client.ts      InceptionClient.chat() → async stream of typed events; followUps()
    sse.ts         incremental, spec-compliant SSE decoder
    events.ts      stream payload → typed events; SourceCollector
    messages.ts    history → the web app's message format; request body
    http.ts        checkpoint detection, error mapping, abortable sleep
  platform/    how requests leave the browser
    transport.ts   direct · site tab · web
    headerRules.ts Origin/Referer rule for the extension's own requests
    bridge.ts      site-tab bridge (app side)
    siteTab.ts     probing tabs, the security-check flow
  extension/
    background.ts  service worker: toolbar button, installs the header rule
    content-bridge.ts  content script on chat.inceptionlabs.ai (probe + same-origin fetch)
  app/         React UI: controller.ts runs the flow; components/ and styles/ are the typography
tests/         Vitest suites, a local protocol simulator (tests only), and the browser E2E script
```

### Tests

The suites cover:
- **Protocol handling:** SSE parsing at every possible chunk boundary, UTF-8 split byte by byte, event mapping, and the message format.
- **Session behaviour:** single-flight, freshness, the checkpoint, and 429/401 recovery.
- **Streaming and control:** streaming, aborting, and dropped connections.
- **Extension glue:** the header rule, the site-tab bridge talking to the real content script through simulated ports, and the security-check flow.
- **Markdown:** rendering and sanitizing.

The integration and browser tests use `tests/fixtures/mock-inception.mjs`, a local
**protocol simulator** that speaks the same wire format as the site. It exists only for tests, and the app never uses it.

## Troubleshooting

- **"Security check" never finishes:** look at the chat.inceptionlabs.ai tab. Some checks need a click. The tab closes by itself once the site answers.
- **Rate limited:** Inception limits requests per IP. Wait a moment and retry.
- **"Via site tab" in the status:** direct calls were refused, so the app is routing through a chat.inceptionlabs.ai tab. You can pick the route in **Settings → Connection**.
- **Firefox:** not supported yet. It needs a different background-script setup.

## Disclaimer

This is an unofficial client for Inception's public chat website, for personal use. Please respect
Inception's [terms of use](https://www.inceptionlabs.ai/docs/terms-of-use). For apps and automation,
Inception offers an official API with keys at [platform.inceptionlabs.ai](https://platform.inceptionlabs.ai).
