# Mercury · Inception Direct

A typography-first chat companion for **Inception's Mercury**. It uses the **chat site's own session and stream**, not the official API or an API key. The site requests originate in a dedicated Chrome/Edge/Chromium window **on your computer**, from **your IP**. A small local-only companion serves the UI and relays the site's stream to it; there is no extension or remote chat proxy.

> **The hosted link is only a design preview.** An ordinary webpage cannot read `chat.inceptionlabs.ai/api/session` or send the site's `x-session-token` header across origins: the chat site does not allow that CORS access. A remote server would use its *own* IP, not yours. To chat, run the companion locally as described below. The preview will never fabricate an answer.

## Start on your computer

You need **Node.js 22.12+** and an installed desktop **Chrome, Edge or Chromium**. The browser must be able to open a window; this is not a headless web scraper.

```bash
# In the cloned repository:
cd inception-direct
npm ci
npm start
```

`npm start` builds the page, binds the companion to **127.0.0.1:4173**, opens a separate Chrome window on `chat.inceptionlabs.ai` with a **dedicated profile**, and opens the UI at **http://127.0.0.1:4173**. If your desktop doesn't open the UI automatically, copy the printed URL into your browser. The session is created on startup; type when the status says **Live**. No key or login form is required by this app.

If the site shows a security checkpoint, **complete it yourself in the site window**. Mercury shows *Security check* and reconnects automatically when the site permits the session. The app does not bypass, solve or hide checkpoints. If you close that window, choose **Reconnect** to reopen it. To stop the companion, press **Ctrl+C** in the terminal.

If Chrome isn't discovered, set `CHROME_PATH` to the installed executable (a full path), for example:

```bash
CHROME_PATH="/path/to/chrome" npm start   # macOS / Linux
# PowerShell: $env:CHROME_PATH = 'C:\Path\To\chrome.exe'; npm start
```

By default the site profile lives in `~/.local/share/mercury-direct/chrome` (Linux), `~/Library/Application Support/Mercury Direct/Chrome` (macOS), or `%LOCALAPPDATA%\Mercury Direct\Chrome` (Windows). It is **not** your everyday browser profile. To reset its cookies, stop the companion, remove *that dedicated folder*, then restart. Use `MERCURY_PROFILE_DIR` to choose a different dedicated folder. `MERCURY_PORT=4180 npm start` changes the local port. `MERCURY_NO_OPEN=1 npm start` keeps the UI from opening automatically. After the first build, `npm run local` starts without rebuilding.

## What happens when you send a message

```text
Your UI (http://127.0.0.1:4173)
    │ same-origin /_local/chat, streamed SSE
    ▼
Node companion (loopback only, on your computer)
    │ Puppeteer controls a dedicated site-origin Chrome window
    ▼
chat.inceptionlabs.ai (from that computer's connection and IP)
    GET  /api/session      → token + browser cookie (automatically refreshed)
    POST /api/chat         → the site's UI-message SSE (text, reasoning, sources, errors)
    POST /api/follow-ups   → optional suggested questions
```

The chat body follows the site's current UI-message shape: conversation ID, message history, thinking mode, web-search toggle, voice mode off, timezone and submit trigger. The browser sends its own cookies and the session header; the **site token is kept in the companion process**, not returned to the UI. We use the site's *actual* SSE bytes, decode split UTF-8 chunks, and forward typed text/reasoning/source events as they arrive. The UI never substitutes a canned or simulator answer. The companion refreshes sessions before they expire, retries normal rate limits, handles a stale session, and reports stream cuts, HTTP errors and checkpoints. **Stop** aborts the upstream request.

The reading UI offers themes, type size, system instructions, optional web search, source links, follow-up questions, retry/rewrite and locally saved conversation history. Chats and settings are stored in the UI browser's IndexedDB/localStorage. Browser profiles and chat-site cookies stay on your computer. The old official-API key, if present at the *same UI origin*, is deleted on startup; this version never reads or sends it.

### Security boundaries

- The companion listens on **127.0.0.1 only**. It requires the expected localhost Host and Origin plus a same-origin local CSRF secret on every write route. It does not set permissive CORS headers. The status response never includes site tokens or cookies.
- The companion's programmable site fetch is restricted to the **three chat-site API endpoints** above, on the configured site origin. Chrome must also load the site's homepage (and any assets or scripts the site itself loads). It does not attach to an existing browser profile. The production CLI always uses `https://chat.inceptionlabs.ai`; a local simulator origin may be injected in tests only.
- The production page's CSP permits scripts, fonts and network requests from **itself only**. All fonts and libraries are bundled. This project includes no external analytics or official-API SDK. The *chat site itself* is external and may have its own scripts, cookies or logging; your prompts and the site's responses go to that site.
- This uses a **private, undocumented** web-app protocol. Inception may change it or deny access at any time. A checkpoint or an upstream refusal is not silently converted to a fake answer. Follow Inception's terms and any applicable usage policies.

## Testing

```bash
npm run check             # typecheck, 64+ unit tests, and production build
CHROME_PATH=/path/to/chrome npm run test:e2e
```

The Chromium end-to-end test runs **two isolated browsers** and a **strict local protocol simulator** (10 checks: hosted-preview limits, loopback/CSRF, session cookies, streaming, sources, follow-ups, 429 retry, stop, error, challenge/recovery, persistence). Its generated answers are *test fixtures only*, **not proof of a live-site response**. This sandbox could not complete a real chat against the live site; a real run on your machine depends on the site's availability and its security checks. The only way to verify a live reply is to run `npm start` locally, pass any checkpoint, and ask a question.

For local design work, `npm run dev` serves a **UI-only preview** (no chat) on Vite's dev port. `npm run preview` serves the built UI as a **preview only**; neither command is the companion. Use **`npm start`** for actual local chat.
