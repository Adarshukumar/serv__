# Mercury · Inception Direct

A typographic chat for **Mercury**, Inception's diffusion language model. It is a **plain
website**, with no server, proxy or browser extension. It talks to **Inception's official API
straight from your own browser**:

- every request goes from your browser to `api.inceptionlabs.ai`, on your own connection and IP
- the session is checked the moment the page opens; after that everything just runs
- every word is streamed live from the model and typeset as it arrives (nothing canned)
- it builds to static files, so any web host (or `npm start` on your own machine) can serve it

It started as a TypeScript port of `My PREVIOUS ENTIRE SERVER/API/providers/Inception.py`
(see [What changed](#what-changed-from-inceptionpy)).

---

## Quick start

```bash
cd inception-direct
npm install
npm start            # builds, then serves the site at http://localhost:4173
```

Open the page, paste your **Inception API key** once, and chat.

**No key yet?** Create one at [platform.inceptionlabs.ai](https://platform.inceptionlabs.ai/dashboard/api-keys).
Every new account gets **100 million free tokens, with no card needed** (per Inception's Quick Start).
The key is stored only in your browser: in `localStorage` if you tick *Remember on this device*,
otherwise just for the tab. It is sent only to `api.inceptionlabs.ai`.

### Put it online

`npm run build` writes a static site to `dist/`. Upload that folder to any static host, such as
Netlify, Vercel, Cloudflare Pages, GitHub Pages, or nginx. It needs no backend or environment
variables. Every visitor uses their own key in their own browser.

Behind a proxied or custom host during development, allow the host explicitly:
`VITE_ALLOWED_HOSTS=.example.com npm run preview -- --host 0.0.0.0`.

## Why the official API (and why no extension)

A web page may only read responses from another site if that site allows it (CORS).

| | `chat.inceptionlabs.ai` (Inception's own chat site) | `api.inceptionlabs.ai` (the official API) |
| --- | --- | --- |
| Other websites may call it | **No**: no CORS headers, and a Vercel bot checkpoint (`429` + `x-vercel-mitigated: challenge`) | **Yes**: it reflects the page's `Origin` in `Access-Control-Allow-Origin` |
| Built for apps | No, it is a private backend of their web app | Yes: OpenAI-compatible, documented, with an official browser-capable SDK |
| Needs | A real browser session on their site | An API key (free tier: 100M tokens) |

Version 1 of this project reached the chat site through a browser extension. Version 2 uses the
official API, so it runs as an ordinary website with nothing to install. The CORS behaviour
was checked on 2026-09-25 against the live API: responses and a bare `OPTIONS` both carry the
reflected origin. Inception's TypeScript SDK also lists web browsers as supported; in a browser
it sends custom `X-Inception-*` headers, which only works if preflights are allowed.

## How it works

```
open the page ─► key saved? ── no ──► key card (paste once; kept in this browser)
                    │ yes
                    ▼
     handshake: one real, minimal completion (≈15 tokens)
     ─ proves CORS + key + credit + model in one round trip ─► Live · 212 ms
                    │
     send ─► POST /v1/chat/completions (stream) ─► blocks of text appear as they decode
               │   429 / 5xx before the first byte → exponential backoff (1 s, 2 s, 4 s) with a visible note
               │   401 → the key card comes back · 402 → billing notice · offline → reconnects when back online
               ▼
     finish ─► reasoning summary · token usage · tok/s ─► follow-ups (a small structured-output request)
```

- **Diffusion view** (the *Diffuse* toggle) sends `diffusing: true`. The API then streams the
  *whole* text at every denoising step. The page redraws it in place and inks the words that
  changed since the previous frame, so you watch the answer settle out of noise. When it
  finishes, the typeset answer replaces the canvas.
- **Timeouts:** a request whose headers take more than 120 s, or a stream that goes silent
  for 90 s, is ended with a clear message. A stream that ends without `finish_reason` or
  `[DONE]` is reported as cut off. The partial answer is kept either way.
- **Retry and Rewrite** re-run an answer with the current settings. An answer that failed
  because of a bad key or missing credit is retried automatically once that's fixed.

## Protocol notes (from docs.inceptionlabs.ai + the OpenAPI spec)

- **Models:** `GET /v1/models` is public and returns id, name, context length, maximum output
  and pricing. It currently lists `mercury-2.5` (260K context, $0.04 / $0.15 per M tokens) and
  `mercury-2` (128K). The app falls back to that built-in list if the request fails.
- **Chat:** `POST /v1/chat/completions` with `Authorization: Bearer <key>`. The body is
  `model`, `messages` (custom instructions go in a real `system` message), `stream: true`,
  `stream_options.include_usage`, `reasoning_effort` (`instant`/`low`/`medium`/`high`) and
  `max_completion_tokens` (4K / 16K / 64K, capped at the model's maximum). `diffusing` and
  `reasoning_summary` are added when turned on. Only documented parameters are sent.
- **Stream:** SSE `chat.completion.chunk` objects with `choices[0].delta.content`, then a
  final chunk with `finish_reason` and `reasoning_summary`, then a usage chunk
  (`choices: []`), then `data: [DONE]`. Errors inside the stream arrive as `{ "error": { … } }`.
- **Errors:** `{ "error": { message, type, param, code } }`: 400 invalid (for example
  `context_length_exceeded`), 401 key, 402 billing, 404 model, 429 rate limit, 500/503.
- **Rate limits (free tier):** 1,000 requests, 1M input tokens and 100K output tokens per minute.

## The typography UI

- **Typefaces:** Fraunces for display, Newsreader for reading (or Inter), Inter small caps
  for labels, and JetBrains Mono for code. All fonts are bundled, so nothing loads from font CDNs.
- **Layout:** your question is set in large italic display type, like an interview. Answers
  are book-set at a comfortable measure, with old-style figures, balanced headings, optional
  drop caps, and an asterism (⁂) between exchanges.
- **While Mercury works:**
  - a live *Thinking 0.8 s* timer runs until the first block arrives;
  - a caret follows the text as it streams in;
  - *Thought for 0.4 s · 312 reasoning tokens* is shown, with the reasoning summary as italic marginalia;
  - every answer carries a colophon: words · tokens · tok/s · first word · total time.
- **Markdown:** tables, task lists, highlighted code with copy buttons, and TeX maths via
  KaTeX (strict, so "$5 and $10" stays text). Images become links instead of loading.
- **Controls:**
  - model, thinking effort (Instant · Low · Medium · High), diffusion view, reasoning summary, follow-ups, length limit and custom instructions;
  - Paper, Night or System theme, and a reading size of 15–24 px;
  - `Enter` sends, `Shift+Enter` adds a new line, `Esc` stops, and `Ctrl/⌘+Shift+O` starts a new chat.
- **Storage:** conversations stay in your browser (IndexedDB) and nowhere else.

## What changed from Inception.py

| Inception.py | Here |
| --- | --- |
| Ran on a server, through a hard-coded proxy (`217.217.249.160:8080`) | Runs in your browser, on your connection. No proxy, no server. |
| Scraped the chat site with `cloudscraper`, which can't pass its current Vercel checkpoint | Uses the official API, which is built for this and allows browser calls |
| Refreshed a site token every 90 s from a background thread | One handshake when the page opens; the key needs no refreshing |
| Reasoning, a JSON blob of sources, and the answer mixed into one text stream | Typed events: text, diffusion canvas, reasoning summary, usage, finish, warning and error |
| Dropped `error` events silently | Shows them on the message, keeping the partial answer |
| Decoded each network chunk separately, so split characters became `���` | Streaming UTF-8 decoder, tested byte by byte with Devanagari and emoji |
| `reasoningEffort` hard-coded to `"high"` | All four efforts, per message |
| A fixed conversation id and shared state; instances kept alive by `atexit` | Per-conversation history; any request can be cancelled with `AbortController` |
| A 1.5–4 s sleep before every token fetch | No artificial delays |

## Privacy and security

- **Network:** the page contacts one host, `api.inceptionlabs.ai`. Fonts and scripts are
  bundled, and images in answers become links instead of loading.
- **Content-Security-Policy:** production builds pin that in the browser. `connect-src` is
  `'self'` plus the API only, and there are no inline scripts. Even if some markup slipped
  past the sanitiser, the stored key could not be sent anywhere else. The e2e test checks
  this by trying to `fetch` another host from the built page.
- **Model output:** it is sanitised with DOMPurify before it is shown (no scripts, event
  handlers, iframes, or `javascript:` links).
- **The key:** it is kept in your browser only, and shown masked (`sk_l…9fQ2`) in the UI.
  **Settings → Forget key** erases it.

## Development

```bash
npm run dev          # dev server with hot reload (http://localhost:5173)
npm test             # unit + integration tests (Vitest)
npm run typecheck    # TypeScript 7
npm run build        # type-check + production build into dist/
npm run check        # all of the above
npm run preview      # serve dist/ (http://localhost:4173)
npm start            # build + preview
CHROME_PATH=/path/to/chrome npm run test:e2e   # drive the real site in Chromium, with screenshots
```

```
src/
  core/        framework-free client for Inception's API
    config.ts      endpoints, models, efforts, limits, retry and timeout policy
    client.ts      InceptionClient: chat() → async stream of typed events; verify(), models(), followUps()
    sse.ts         incremental, spec-compliant SSE decoder
    events.ts      chat.completion.chunk → typed events (append vs. diffusing replace)
    messages.ts    history → API messages; request bodies; follow-up parsing
    http.ts        error mapping, backoff, abort-aware sleep, linked abort signals
    errors.ts      InceptionError with a `kind` the UI acts on
  app/         React UI: controller.ts runs the flow; components/ and styles/ are the typography
    diffusion.ts   word-by-word canvas diff for the diffusion view
tests/         Vitest suites, a strict local API simulator (tests only), and the browser E2E script
```

### Tests

- **Unit and integration (Vitest):**
  - SSE parsing at every chunk boundary, including UTF-8 split byte by byte;
  - chunk → event mapping, and the diffusion canvas diff;
  - request bodies and follow-up parsing;
  - backoff on 429/503, and every error kind (401, 402, 404, 400, network, cut-off, idle and response timeouts, abort);
  - key and settings storage;
  - CORS preflight behaviour.
- **Browser E2E (real Chromium):** runs against the simulator on another origin, so the
  browser enforces CORS and sends real preflights. It covers:
  - the key card (a wrong key, then the right one);
  - the handshake, streaming, maths and code, and follow-ups with full history;
  - model, effort and length settings, and the diffusion view;
  - stop, stream errors, and rate-limit backoff;
  - persistence and reload, themes, and mobile;
  - no credit, and forgetting the key;
  - a production build under its CSP.

`tests/fixtures/mock-inception.mjs` is a strict **simulator of the official API** (same wire
format and CORS behaviour, and unknown parameters are refused). It exists only for tests; the
app never uses it.

## Troubleshooting

- **"That key didn't work."** Inception returned 401. Create a new key at platform.inceptionlabs.ai and paste it again.
- **"Needs credit."** Inception returned 402. The free tokens are used up, or billing is inactive.
- **"Can't reach api.inceptionlabs.ai."** Check your connection. A content blocker, VPN or firewall that blocks `api.inceptionlabs.ai` has the same effect.
- **Rate limited:** the app waits and retries by itself, and shows it's doing so.
- **"Reached the length limit":** ask Mercury to continue, or raise the limit in Settings.

## Disclaimer

This is an unofficial client for Inception's official API. Your use of the API is governed by
Inception's [terms of use](https://docs.inceptionlabs.ai/support/tou) and your own account.
