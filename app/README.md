# Aduskills Chat

One page. Six providers. **No hosted server** — provider calls leave from a
bridge running on *your* machine, so providers see *your* IP.

Replaces `My PREVIOUS ENTIRE SERVER/` (Python/FastAPI). That directory is left
untouched.

**Read [`ARCHITECTURE.md`](./ARCHITECTURE.md) first.** It records why a browser
cannot call these providers directly, the four wire formats, and every finding
from reading the Python source — including one I got wrong and retracted.

---

## Quick start

```bash
cd app
npm install

# terminal 1 — the local egress bridge (Node ≥20, zero dependencies)
npm run bridge

# terminal 2 — the SPA
npm run dev
```

Open the printed Vite URL. If the bridge is down the UI says so and offers the
**Offline Simulator**, which streams realistic SSE in every wire format with no
network and no credentials.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server; proxies `/bridge` → `127.0.0.1:8787` |
| `npm run bridge` | Local egress bridge |
| `npm test` | 60 tests: unit + differential + integration |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Type-check + production bundle |
| `npm run gen:models` | Regenerate `src/data/models.ts` from the Python registry |

## What changed from the Python server

| | Python (`My PREVIOUS ENTIRE SERVER/`) | This |
|---|---|---|
| Runtime | FastAPI + uvicorn, 10 deps | Vite + React 18 + TS; bridge has **zero** deps |
| Deploy | HF Spaces Docker image, port 7860 | Static SPA + a local process |
| Outbound IP | One shared datacenter IP | **Each user's own IP** |
| Heavy deps | Chromium, xvfb, `chromium-driver`, DrissionPage, cloudscraper, curl-cffi | none |
| Providers | 7 (incl. DevsDo) | 6 — **DevsDo removed** |
| Upstage | v2: DrissionPage + threads + `requests` | **v3**: pure async, ported to JS |
| Models | 64 in registry, DeepInfra unreachable | 50, DeepInfra's 18 recovered |
| Provider quirks | Re-handled in `Completion.py` *and* `Server.py` | One normaliser per wire format, UI is format-agnostic |

## Credentials

Upstage and Mercury authenticate with **captured browser session material**
(cookies + CSRF / `x-session-token`), not API keys. Credential *capture* is not
ported yet. Until it is, pass them to the bridge as environment variables:

```bash
UPSTAGE_COOKIE='...' UPSTAGE_CSRF='...' npm run bridge
MERCURY_TOKEN='...'  MERCURY_UA='...'   npm run bridge
```

Without them the bridge returns a `missing_credentials` error event rather than
hanging or silently emitting nothing. `GET /bridge/health` reports which
providers are currently credential-ready.

Keep them out of Git — the repo `.gitignore` covers `.env*` and the cache dirs.

## Layout

```
bridge/          local egress bridge — the only thing that talks to providers
  server.mjs     http + SSE relay, binds 127.0.0.1
  headers.mjs    forbidden-header sets lifted verbatim from the Python source
  payloads.mjs   per-provider request bodies, ported line by line
  mock.mjs       offline simulator emitting all four wire formats
src/
  data/          models.ts (GENERATED) + providers.ts (metadata)
  lib/           sse.ts, envelope.ts, normalizers.ts, thinkSplitter.ts, bridge.ts, markdown.tsx
  components/    Sidebar (models by provider), Message, Composer
scripts/
  dump_registry.py                 executes Models.py → src/data/models.ts
  gen_thinksplitter_fixtures.py    executes Python ThinkSplitter → 815 differential cases
tests/
  normalizers.test.ts              50 unit tests over the wire formats
  thinksplitter-differential.test.ts   TS port vs the Python original
  integration.test.ts              spawns the real bridge, drives the real pipeline
```

## Known limits

- **No live provider call has been verified.** The sandbox I built this in
  cannot reach any provider host (TLS handshake killed; `curl` exit 35). The
  offline simulator and the differential tests are the substitute, and they are
  clearly labelled as such.
- **CORS/`Sec-Fetch` enforcement per provider is unknown.** Flip a provider's
  `transport` to `'direct'` in `src/data/providers.ts` only after confirming
  from a real browser that it works.
- Dolphin attachments (images/text) are modelled in the capability system; the
  upload UI is not wired.
- Security review was deliberately deferred. Two things are flagged in
  `ARCHITECTURE.md` §10 and still need a look: the bridge replays captured
  session cookies, and `Inception.py` hardcodes a plaintext-HTTP proxy
  (`217.217.249.160:8080`) whose provenance is unknown. It is **disabled by
  default** here — `bridge/headers.mjs` reads `MERCURY_PROXY` only if you set it.
