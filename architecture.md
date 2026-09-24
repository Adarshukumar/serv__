# architecture.md — upstage-solar-npm

> Entire system: a single Node.js process that speaks the **same wire protocol**
> as the original Python v3 provider (`New Upstage Change Logs`), connects
> **directly to Upstage from the user’s machine**, and optionally serves a
> loopback-only UI. **No mock, no offline mode, no intermediate server IP.**

---

## 1 · Design principles

1. **User IP everywhere** — every HTTPS socket to `console.upstage.ai` and
   `ap-northeast-2.apistage.ai` is opened by *this* process on *this* machine.
   Outbound source IP = the user’s public IP. No proxy env, no relay, no
   upstream tunnel.
2. **Same process as Python** — one long-lived process owns credentials,
   cookie jar, history, and the SSE stream (exactly like `UpstageProvider`
   in Python). The browser never talks to Upstage (CORS/TLS); it only talks
   to the local process over loopback.
3. **No server IP exposed** — the HTTP listener is a local convenience for
   the UI (`127.0.0.1:8486` by default). It is not published, not a
   multi-tenant API, and never egresses on someone else’s IP.
4. **Real only** — production URLs by default; failures return real errors.

```
┌────────────────────────── user’s machine (user’s public IP) ─────────────────────────┐
│                                                                                      │
│  Browser ── HTTP over loopback (127.0.0.1:8486) ──▶ Node process (src/server.js)     │
│     │                                         │                                      │
│     │  UI: model picker, SSE chat, usage      │  UpstageProvider (src/provider.js)   │
│     │                                         │    ├─ Credentials  (src/creds.js)     │
│     │                                         │    │    tough-cookie jar + disk cache │
│     │                                         │    └─ protocol.js (SSE, think-split)  │
│     │                                         │                                      │
│     │                                         │  ALL outbound sockets open HERE ─┐   │
└─────┴─────────────────────────────────────────┴──────────────────────────────────┼───┘
                                                                                   │
                                          direct TLS, source = user IP            │
                                                                                   ▼
                              ┌─────────────────────────────────────────────┐
                              │ console.upstage.ai                         │
                              │   GET  /playground/chat                    │
                              │   GET  /_next/static/chunks/*.js           │
                              │   POST /playground/chat  (next-action)     │
                              │ ap-northeast-2.apistage.ai                 │
                              │   POST /v1/web/demo/chat/completions       │
                              │        ?include_think=true   (SSE)         │
                              └─────────────────────────────────────────────┘
```

There is **no** box between the user’s machine and Upstage. That is the
“no server IP” guarantee.

---

## 2 · Repo layout (clone-and-run)

```
.
├── package.json          # npm install && npm start
├── README.md
├── architecture.md
├── bin/upstage.js        # CLI (direct chat, same provider)
├── src/
│   ├── index.js          # public exports
│   ├── config.js         # endpoints + 6-model registry (env-overridable)
│   ├── protocol.js       # pure: SSE, ThinkSplitter, Sources, usage, payload
│   ├── creds.js          # real credential capture (got-scraping + tough-cookie)
│   ├── provider.js       # UpstageProvider.stream()/chat()
│   └── server.js         # loopback HTTP API + static UI
├── public/index.html     # browser UI
└── test/
    ├── protocol.test.js  # offline-safe pure tests
    └── live.test.js      # UPSTAGE_LIVE=1 → real network
```

Nothing else ships: no Python, no mocks, no previous-server tree.

---

## 3 · Python v3 → NPM module map

| Python | NPM | Role |
|---|---|---|
| constants / `_MODELS` / `_resolve_model` | `src/config.js` | Hosts + models (`solar-pro4`, `solar-pro3`, `solar-pro2`, `syn-pro`, `solar-mini-4`, `upstage/solar-1-mini-chat`) |
| `_SSE`, `_Sources`, `ThinkSplitter`, `TurnUsage`, `SessionUsage`, `_build_payload` | `src/protocol.js` | Pure logic |
| `_find_action_id`, `_Creds` | `src/creds.js` | Browser-free credential pipeline |
| `UpstageProvider.stream/chat` | `src/provider.js` | Realtime async generators, auth-retry, usage finalize |
| (REPL / demos) | `src/server.js` + `public/index.html` + `bin/upstage.js` | UI + CLI |

---

## 4 · One chat turn (identical to Python)

1. **Credentials**
   - load disk cache → `verify()` via RSC POST; else **capture**:
     1. `GET /playground/chat` → session cookies  
     2. `GET` + `RSC: 1` → extra chunk refs  
     3. scan `/_next/static/chunks/*.js` for  
        `createServerReference)("<32–80 hex>",…,"getConsoleCsrfToken")`  
     4. `POST /playground/chat` with `next-action` + body `[]`  
     5. parse flight line `{"token":"…"}` → CSRF token  
2. **Payload** — `conversation_id`, `stream:true`, messages, model,
   `temperature`, `max_tokens`, `reasoning_effort` (search→high else low),
   `search_provider:"tavily"` + `mode:["search"]`, `syn-pro` metadata.
3. **POST completions** — `gotScraping.stream` (browser TLS fingerprint,
   incremental body). Headers in §5. Timeouts: 20 s connect / 300 s read.
4. **SSE events** — `r-delta` · `t-delta` · `source` · `usage` · `done`.
5. **Assembly** — ThinkSplitter peels inline `<think>…##` across token
   boundaries; first `source` → `sources` event; `done` then `usage` trailer.
6. **Finalize** (always, even on early abort) — elapsed, TTFB, tokens
   (API or chars/4), history append, session usage.

**Auth retry:** 401/403 → one re-capture → one retry → `UpstageAuthError`.

---

## 5 · Wire headers (what the real console expects)

### Capture

```
GET /playground/chat
  User-Agent: Mozilla/5.0 … Chrome/146…
GET /playground/chat          # RSC
  RSC: 1
GET /_next/static/chunks/<file>.js
  User-Agent: Chrome…
POST /playground/chat
  accept: text/x-component
  content-type: text/plain;charset=UTF-8
  next-action: <id from JS bundle>
  origin: https://console.upstage.ai
  referer: https://console.upstage.ai/playground/chat
  Cookie: session_id=…; …
  body: []
```

### Completions

```
POST https://ap-northeast-2.apistage.ai/v1/web/demo/chat/completions?include_think=true
  content-type: application/json
  origin: https://console.upstage.ai
  referer: https://console.upstage.ai/
  x-csrf-token: <token>
  x-session-id: <session_id>
  x-upstage-logging-enabled: true
  user-agent: Chrome…
  Cookie: session_id=…; …
```

Source IP of these packets = **user’s IP** (the Node process opened them).

---

## 6 · Local HTTP API (loopback only)

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | UI |
| GET | `/api/health` | Liveness + resolved production endpoints |
| GET | `/api/ip` | **Your egress IP** (proof: outbound = you) |
| GET | `/api/models` | Full model list + active flag |
| GET | `/api/status` | CSRF / history / usage |
| POST | `/api/connect` | Real credential capture |
| POST | `/api/chat` | One-shot JSON answer |
| POST | `/api/chat/stream` | SSE: sources → thinking → content → done → usage → eof |
| GET | `/api/usage` | Session report |
| POST | `/api/session/reset` | Clear state |

Default bind: `127.0.0.1` (`HOST`/`PORT` env can change it for advanced use).
Binding is **only** so the browser can reach this same machine — it is not a
public API and carries no other IP’s traffic.

---

## 7 · Models

| id | reasoning | search | max_tokens |
|---|---|---|---|
| `solar-pro4` | low/med/high | ✓ | 65536 |
| `solar-pro3` (default) | low/med/high | ✓ | 65536 |
| `solar-pro2` | low/high | ✓ | 16383 |
| `syn-pro` (+ metadata) | low/high | ✓ | 16384 |
| `solar-mini-4` | low/med/high | ✓ | 32768 |
| `upstage/solar-1-mini-chat` | — | ✓ | 16383 |

Aliases: `pro4`, `pro3`, `pro2`, `syn`, `mini`, `solar3`, …

---

## 8 · Environment

| Variable | Default | Meaning |
|---|---|---|
| `UPSTAGE_CONSOLE_URL` | `https://console.upstage.ai` | Real console |
| `UPSTAGE_API_BASE` | `https://ap-northeast-2.apistage.ai` | Real completions |
| `UPSTAGE_CACHE_DIR` | `<tmp>/.cache/upstage` | Cookie/action cache (your disk) |
| `HOST` | `127.0.0.1` | UI bind (loopback — no public exposure) |
| `PORT` | `8486` | UI port |
| `UPSTAGE_LIVE` | — | `1` enables real-network tests |

No `PROXY`, no relay URL — if you set `HTTPS_PROXY` yourself, Node/undici
may honor it; the app never configures one.

---

## 9 · Trust / security

- Tokens & cookies live only in the user’s cache directory.
- No API keys, no telemetry, no third-party analytics.
- UI is loopback-first so a LAN scanner never sees a “server”.
- Live tests hit production only — asserting fake success is impossible.

---

## 10 · Runbook

```bash
npm install
npm start                          # http://127.0.0.1:8486  (your IP outbound)
npm test                           # 15 pure tests
UPSTAGE_LIVE=1 npm run test:live   # real capture + stream from this machine
node bin/upstage.js "What is 2+2?" --model pro3
```

**Sandbox note:** some CI networks kill TLS to `*.upstage.ai` (SNI filter).
There you will see the real `ECONNRESET` / “socket disconnected before TLS”
from `/api/connect` — by design, never a fabricated success. On a normal
network the same process captures credentials and streams completions using
the user’s IP exclusively.
