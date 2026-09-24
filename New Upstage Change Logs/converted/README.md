# ☀️ Upstage Kit — converted from `New Upstage Change Logs` (v3)

Deep re-read + conversion + full end-to-end API test of the four files:

| Original (v3) | Converted |
|---|---|
| `upstage_provider.py` (1375-line monolith) | `upstage_kit/config.py` · `protocol.py` · `creds.py` · `provider.py` |
| `test_upstage.py` | `test_converted.py` (offline + live-chain + live-API) |
| `upstage_usage.py` / `upstage_interactive.py` | HTTP API + browser test page at `/` |
| *(none)* | `mock_upstage.py` — protocol-faithful Upstage double |

## What the original does (processing pipeline)

1. **Credential capture (browser-free)** — GET `/playground/chat` → scan its
   Next.js JS chunks for `createServerReference("<42hex>",…,"getConsoleCsrfToken")`
   → RSC POST with that action id → parse `{"token": JWT}` → cache cookies+ids
   to `/tmp/.cache/upstage/upstage_creds.json`.
2. **Completion** — POST
   `https://ap-northeast-2.apistage.ai/v1/web/demo/chat/completions?include_think=true`
   with `x-csrf-token`, session cookie, Chrome TLS impersonation (curl_cffi).
3. **SSE events** — `r-delta` (reasoning) · `t-delta` (content, may contain
   inline `<think>…##`) · `source` (tavily results) · `usage` · `done`.
4. **Assembly** — `ThinkSplitter` peels think markup even when tags split
   across tokens; `Sources` dedups URLs; `TurnUsage`/`SessionUsage` record
   timing/tokens; `chat()` yields plain strings, `stream()` yields typed
   `StreamEvent`s.

## What changed in the conversion ("according to me")

- **Endpoints from env** (`UPSTAGE_CONSOLE_URL`, `UPSTAGE_API_BASE`,
  `UPSTAGE_CACHE_DIR`) resolved at call time → same code talks to real
  Upstage *or* any mock/staging. Real hosts remain the defaults.
- **Split by concern**: config / pure protocol / credentials / provider.
- **Fixed a latent regex bug**: the original chunk scanner used a raw-string
  class `[^\\\"\\s\\],]` which accidentally excluded the letter `s`
  (harmless in production only because real chunk names are hex hashes).
  Now `[^"\s\],]` — correct negation of quote/whitespace/`]`/`,`.
- **HTTP API layer** (`api_server.py`):
  - `GET  /health` · `GET  /v1/models`
  - `POST /v1/chat` → one JSON object (response, reasoning, sources, usage)
  - `POST /v1/chat/stream` → SSE frames `event: sources|thinking|content|done|usage|error`
  - `GET  /` → browser test page that streams into the DOM
  - Stateless per request (fresh history each call; pass full `messages` for multi-turn).
- **Mock Upstage** (`mock_upstage.py`, :8485) implements the exact wire
  contract: HTML+RSC chunk refs → JS action-id extraction → RSC token flight →
  CSRF-gated SSE completions with search events, reasoning, inline think
  blocks, non-zero usage, `[DONE]`. Plus `/__test/flaky_auth` and
  `/__test/rotate_token` to exercise the provider's auth-retry path.

## Why a mock?

This sandbox's egress allowlist completes TCP to `console.upstage.ai` but
**kills the TLS handshake** (same for google.com/example.com; github/pypi
pass). The real console itself was verified alive out-of-band. So the full
chain — credential capture → CSRF → streaming completion → think-splitting →
sources → usage — is proven end-to-end against the protocol double, and the
identical code hits real Upstage when run outside the sandbox (defaults).

## Run

```bash
# terminal 1 — mock backend
python3 mock_upstage.py --port 8485

# terminal 2 — API (points at mock)
UPSTAGE_CONSOLE_URL=http://127.0.0.1:8485 \
UPSTAGE_API_BASE=http://127.0.0.1:8485 \
python3 api_server.py --port 8484

# tests
python3 -m pytest test_converted.py -v                 # offline
KIT_LIVE=1 python3 -m pytest test_converted.py -v      # offline + live chain + API

# against REAL Upstage (no env needed — defaults are production):
python3 api_server.py --port 8484
```

## Test results (this sandbox)

- Original suite: **73 passed** (6 live skipped — no route to real Upstage TLS)
- Converted suite: **38/38 passed** including 6 live-chain + 4 live-API tests
- Live curl: `/v1/chat` JSON ✅ · `/v1/chat/stream` SSE ✅ · `/v1/models` ✅ · `/health` ✅
