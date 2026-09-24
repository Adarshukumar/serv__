# architecture.md — upstage-solar-npm

> Full Node.js/NPM conversion of **`New Upstage Change Logs`** (the Python v3
> provider). **Real Upstage only** — no mock server, no offline mode, no
> canned responses anywhere in the runtime path.

---

## 1 · Goals

| Requirement | How it is met |
|---|---|
| Entire Python implementation → NPM project | `src/` is a line-for-line semantic port of `upstage_provider.py` (v3): same credential pipeline, same SSE event types, same think-splitter, same usage department, same payload builder |
| Work online against the real server | Every chat/connect path calls `https://console.upstage.ai` + `https://ap-northeast-2.apistage.ai` directly. Failures surface as real network/auth errors |
| No offline / prewritten things | Zero mock endpoints. `/api/usage` starts as `(no turns yet)`. Tests that need a network are gated `UPSTAGE_LIVE=1` and hit production |
| Extract credentials | Pure-HTTP capture: page GET → JS-chunk scan → RSC action POST → `{"token":…}` → disk cache (`UPSTAGE_CACHE_DIR`) |
| Connection over **user's IP** | The npm process runs **on the user's machine**; all outbound sockets open from that host. No proxy, no relay, no third-party hop. UI shows the egress IP via `/api/ip` |
| UI to interact with the API | `public/index.html` served by `src/server.js` — model picker (all models), search, reasoning, temperature, max-tokens, system prompt, SSE streaming, sources, usage, live connection status |
| Check headers yourself | See §5 — every header is explicit in `creds.js` / `provider.js` |

---

## 2 · Topology

```
┌───────────────────── user's machine (user's public IP) ─────────────────────┐
│                                                                             │
│  Browser ──HTTP 1.1──▶ npm server (src/server.js, 0.0.0.0:8486)             │
│     │                      │                                                │
│     │  UI (public/index)   │  UpstageProvider (src/provider.js)             │
│     │  /api/chat/stream    │      │                                         │
│     │                      │      ├─ Credentials (src/creds.js)             │
│     │                      │      │     cookie jar (tough-cookie)           │
│     │                      │      │     action-id cache on disk             │
│     │                      │      └─ SSE parser + ThinkSplitter             │
│     │                      │            (src/protocol.js)                   │
│     └──────────────────────┴──────────────┬─────────────────────────────────┘
│                                           │ HTTPS (got-scraping, browser TLS)
└───────────────────────────────────────────┼─────────────────────────────────┘
                                            ▼
                    ┌───────────────────────────────────────────┐
                    │  console.upstage.ai                      │
                    │   GET  /playground/chat      (HTML+RSC)   │
                    │   GET  /_next/static/chunks/*.js          │
                    │   POST /playground/chat       (next-action)│
                    │                                           │
                    │  ap-northeast-2.apistage.ai               │
                    │   POST /v1/web/demo/chat/completions      │
                    │        ?include_think=true   (SSE)       │
                    └───────────────────────────────────────────┘
```

**Key invariant:** the browser never talks to Upstage directly (CORS /
TLS-fingerprint). It only talks to the local npm server. The npm server
never tunnels through anyone else — **outbound = the user's IP**.

---

## 3 · Module map (Python v3 → NPM)

| Python (`New Upstage Change Logs/`) | NPM (`npm-upstage/`) | Role |
|---|---|---|
| constants + `_MODELS` + `_resolve_model` | `src/config.js` | Env-resolved hosts, model registry (6 models incl. Pro 4 / Mini 4) |
| `_SSE` / `_Sources` / `ThinkSplitter` / `TurnUsage` / `SessionUsage` / `_build_payload` | `src/protocol.js` | Pure logic, no I/O |
| `_find_action_id` + `_Creds` | `src/creds.js` | Browser-free credential capture (`got-scraping` + `tough-cookie`) |
| `UpstageProvider` (`stream`/`chat`) | `src/provider.js` | Realtime async generators, auth-retry, usage finalization |
| *(none — REPL/demo scripts)* | `src/server.js` + `public/index.html` | HTTP API + browser UI |
| *(none)* | `bin/upstage.js` | CLI (`npx upstage-solar "…"` ) |
| `test_upstage.py` | `test/protocol.test.js` + `test/live.test.js` | Unit + real-network tests |

Public entry: `src/index.js` (re-exports everything).

---

## 4 · Processing pipeline (one chat turn)

1. **Ensure credentials** — `connect()`:
   - load `upstage_creds.json` → if present, `verify()` via RSC POST;
   - else `capture()`:
     1. `GET /playground/chat` → session cookies (`session_id`, …)
     2. `GET /playground/chat` with `RSC: 1` → extra chunk refs
     3. for each `/_next/static/chunks/*.js` (≤80): regex
        `createServerReference)("<42hex>",…,"getConsoleCsrfToken")`
     4. `POST /playground/chat` with `next-action: <id>`, body `[]`
     5. parse flight line containing `{"token":"…"}` → CSRF token
2. **Build payload** (`buildPayload`): `conversation_id`, `stream:true`,
   messages (+ optional injected system), `model`, `temperature`,
   `max_tokens`, `reasoning_effort` (search→high else low, explicit wins),
   `search_provider:"tavily"` + `mode:["search"]` on last user message,
   `metadata` for `syn-pro`.
3. **POST completions** with headers (§5) via `gotScraping.stream`
   (browser TLS fingerprint, incremental reads, 300 s response envelope).
4. **Parse SSE lines** → events:
   `r-delta` (reasoning) · `t-delta` (content) · `source` (Tavily JSON) ·
   `usage` (non-zero only) · `done` (`finish_reason=stop` or `[DONE]`).
5. **Assemble**:
   - `ThinkSplitter` peels inline `<think>…##` even when tags split
     across tokens (hold-back + flush at end);
   - first `source` → `sources` event (deduped URLs, scores, snippets);
   - `done` is last consumer-visible stream event, then a `usage` trailer.
6. **Finalize** (in `finally`, so early-break/errors still run):
   elapsed, TTFB, token counts (API-reported or chars/4 estimate),
   history append, `session_usage` accumulation.

**Auth retry:** HTTP 401/403 on completions → one credential re-capture →
one retry → then raise `UpstageAuthError`.

---

## 5 · Exact wire headers (checked against the live console contract)

### Credential capture

```
GET /playground/chat
  User-Agent: Mozilla/5.0 … Chrome/146…
  (cookie jar persists Set-Cookie: session_id=…)

GET /playground/chat          # RSC variant
  RSC: 1
  User-Agent: Chrome…

GET /_next/static/chunks/<file>.js
  User-Agent: Chrome…

POST /playground/chat         # server-action call
  accept: text/x-component
  content-type: text/plain;charset=UTF-8
  next-action: <42-hex action id from the JS bundle>
  origin: https://console.upstage.ai
  referer: https://console.upstage.ai/playground/chat
  User-Agent: Chrome…
  Cookie: session_id=…; …
  body: []
```

### Completions (the model call)

```
POST https://ap-northeast-2.apistage.ai/v1/web/demo/chat/completions?include_think=true
  content-type: application/json
  accept: */*
  origin: https://console.upstage.ai
  referer: https://console.upstage.ai/
  x-csrf-token: <token from RSC flight response>
  x-session-id: <session_id cookie value>
  x-upstage-logging-enabled: true
  user-agent: Chrome…
  Cookie: session_id=…; …
  body: { conversation_id, stream:true, log_enabled:true,
          messages[], model, temperature, max_tokens,
          reasoning_effort?, search_provider?, metadata? }
```

Response: `text/event-stream` of `data: {json}` lines (see §4.4).

---

## 6 · HTTP API exposed by `src/server.js`

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Browser UI |
| GET | `/api/health` | Liveness + resolved endpoints |
| GET | `/api/ip` | Egress IP (proves outbound = this machine) |
| GET | `/api/models` | Full model registry + active flag |
| GET | `/api/status` | CSRF validity, history, usage totals |
| POST | `/api/connect` | Force real credential capture |
| POST | `/api/chat` | One-shot JSON answer + reasoning + sources + usage |
| POST | `/api/chat/stream` | SSE: `sources`→`thinking`→`content`→`done`→`usage`→`eof` |
| GET | `/api/usage` | Session usage report |
| POST | `/api/session/reset` | Clear history/state |

SSE frame example:

```
event: content
data: {"kind":"content","text":"4"}

event: done
data: {"kind":"done","text":""}

event: usage
data: {"model":"solar-pro3","ok":true,…,"tokens":50,…}
```

---

## 7 · Models

| id | reasoning | search | max_tokens | notes |
|---|---|---|---|---|
| `solar-pro4` | low/med/high | ✓ | 65536 | flagship agentic (live console) |
| `solar-pro3` | low/med/high | ✓ | 65536 | 102B MoE — **default** |
| `solar-pro2` | low/high | ✓ | 16383 | reasoning + tools |
| `syn-pro` | low/high | ✓ | 16384 | + quality metadata block |
| `solar-mini-4` | low/med/high | ✓ | 32768 | compact agentic (live console) |
| `upstage/solar-1-mini-chat` | — | ✓ | 16383 | lightweight chat (alias `mini`) |

Aliases (`pro3`, `pro2`, `pro4`, `syn`, `mini`, `solar3`…) resolved in
`config.resolveModel`.

---

## 8 · Configuration (env)

| Variable | Default |
|---|---|
| `UPSTAGE_CONSOLE_URL` | `https://console.upstage.ai` |
| `UPSTAGE_API_BASE` | `https://ap-northeast-2.apistage.ai` |
| `UPSTAGE_CACHE_DIR` | `<os.tmpdir>/.cache/upstage` |
| `PORT` | `8486` |
| `HOST` | `0.0.0.0` |
| `UPSTAGE_LIVE` | unset — set `1` to enable live tests |

Defaults = production. There is intentionally **no** mock base URL in the
product path.

---

## 9 · Security & trust notes

- Credentials (cookies + action ids) live only in the user's cache dir;
  CSRF tokens are short-lived and re-derived per verify.
- The npm server binds `0.0.0.0` for LAN/preview access; put it behind
  localhost-only (`HOST=127.0.0.1`) if you don't need remote UI.
- No API keys are stored: auth is the same console session pipeline the
  official playground uses.
- No telemetry, no third-party analytics.

---

## 10 · Runbook

```bash
cd "New Upstage Change Logs/npm-upstage"
npm install
npm start                 # UI → http://localhost:8486
npm test                  # 15 pure-logic tests (offline-safe)
UPSTAGE_LIVE=1 npm run test:live   # real console + completions

# CLI
node bin/upstage.js "What is 2+2?" --model pro3 --search
```

**Sandbox note:** some CI/sandbox networks kill TLS to `*.upstage.ai`
(mid-path SNI filter). In that environment `/api/connect` correctly
returns the real `ECONNRESET / socket disconnected before TLS` error —
by design, never a fake success. On a normal machine with unrestricted
egress, the same code captures credentials and streams completions
directly from the user's IP.
