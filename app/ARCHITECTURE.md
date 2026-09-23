# Architecture — Python server → React + local bridge

**Status:** design locked, implementation in progress
**Supersedes:** `My PREVIOUS ENTIRE SERVER/` (Python/FastAPI) — kept intact, not modified
**Scope of this doc:** design and architecture. Security review deliberately deferred at the user's instruction.

---

## 1. What was asked, and what the evidence allows

| Ask | Verdict | Why |
|---|---|---|
| Python → npm/React | ✅ Done | Vite + React 18 + TS, `npm install` verified (68 pkgs, exit 0) |
| One nice single-page chat UI | ✅ Done | SPA, models grouped by provider |
| Upstage v2 → v3 provider | ✅ Done | v3 ported; v2 dropped |
| Remove DevsDo | ✅ Done | Provider deleted; 32 DevsDo-exclusive models removed |
| Models listed per provider | ✅ Done | Registry already keyed provider-first; preserved |
| Per-provider thinking / response-shape handling | ✅ Done | 4 distinct wire formats normalised to one event model |
| **"No server" — browser calls the provider APIs directly** | ⚠️ **Not achievable as stated** | See §2. This is the one place the design diverges from the request, and it is forced by the web platform, not by preference. |
| Use the **user's IP** for provider calls | ✅ **Achieved** | Delivered by the local bridge (§3), which is the actual goal behind "no server" |

## 2. Why the browser cannot call these providers directly

This is the load-bearing finding. It is **SOURCE_SUPPORTED**, not opinion.

Every provider in the Python codebase sends headers that a browser **forbids
JavaScript from setting**:

| Provider | `Origin` | `Referer` | `Sec-Fetch-*` | TLS impersonation |
|---|---|---|---|---|
| mCloudFlare | `https://multi-modal.ai.cloudflare.com` | ✓ | `Site: same-origin`, `Mode: cors`, `Dest: empty` | `curl_cffi impersonate="chrome120"` |
| Dolphin | `https://chat.dphn.ai` | ✓ | `Site: same-origin`, `Mode: cors`, `Dest: empty` | `curl_cffi` |
| LLMChat | `https://llmchat.in` | ✓ | — | `curl_cffi` |
| DeepInfra | ✓ | ✓ | — | `cloudscraper` (Cloudflare challenge solver) |
| Mercury | ✓ | ✓ | — | `cloudscraper` + captured cookies + `x-session-token` |
| Upstage v3 | `https://console.upstage.ai` | ✓ | — | `curl_cffi AsyncSession` + captured cookies + CSRF |

The rules:

1. **All `Sec-`-prefixed headers are forbidden request headers.** "As such, they
   cannot be modified from JavaScript" — MDN, *Fetch metadata request header*
   glossary; confirmed by the W3C Fetch Metadata spec §4.2 ("prefixed with
   `Sec-`, which makes them all forbidden … unmodifiable from JavaScript").
   A browser sets `Sec-Fetch-Site` itself. From your page it will always be
   `cross-site`. Your providers assert `same-origin`. **You cannot make a browser
   say `same-origin`.**
2. **`Origin` and `Referer` are likewise not script-settable.** The browser
   derives `Origin` from the real page origin. You cannot send
   `Origin: https://llmchat.in` from a page hosted anywhere else.
3. **CORS is separate and additional.** Even with correct headers, the provider
   must return `Access-Control-Allow-Origin` matching your origin or the browser
   discards the response.

Corroboration from a practitioner source: *"If you are calling one of these
endpoints from frontend JavaScript — a client-side integration — your requests
get rejected. The server sees `Sec-Fetch-Site: cross-site` and
`Sec-Fetch-Mode: cors`, and blocks you. From the browser, you can't change these
headers. A server-side proxy can."* And: *"Server-side code (Node.js, Python,
Go, etc.) has no forbidden header restrictions … You can set them manually if
the target server requires them."*

**Honest limit:** I could **not** empirically test CORS from this sandbox. All six
provider hosts fail the TLS handshake (`curl` exit 35, `SSL_ERROR_SYSCALL`) while
`github.com` and `pypi.org` return 200/404 — a targeted egress allowlist. So
*which* providers actively enforce `Sec-Fetch-*`/`Origin` is **UNKNOWN**; only
that the code sends them, and that a browser cannot reproduce them, is proven.
Some providers might ignore those headers and work directly. The design
accommodates that (§3.3) instead of assuming.

## 3. The design: static SPA + **local** egress bridge

```
┌──────────────────────────── the user's own machine ────────────────────────────┐
│                                                                                │
│   Browser tab                     Local Node bridge              Provider APIs │
│  ┌──────────────┐   localhost    ┌──────────────────┐   user's  ┌────────────┐ │
│  │  React SPA   │ ─────────────► │  bridge/server   │ ─── IP ──►│ DeepInfra  │ │
│  │  one page    │   SSE stream   │  · sets Origin    │           │ LLMChat    │ │
│  │              │ ◄───────────── │    Referer        │ ◄────────│ Dolphin    │ │
│  │  model picker│   unified       │    Sec-Fetch-*    │   SSE     │ mCloudFlare│ │
│  │  chat view   │   events        │  · holds cookies  │           │ Mercury    │ │
│  └──────────────┘                 │    / CSRF         │           │ Upstage    │ │
│                                   │  · normalises     │           └────────────┘ │
│                                   │    4 wire formats │                          │
│                                   └──────────────────┘                          │
└────────────────────────────────────────────────────────────────────────────────┘
        There is NO hosted server. No HF Space. No datacenter IP. No sleeping.
```

### 3.1 Why this satisfies the real requirement

The point of "no server" was: *stop routing everyone's traffic through one
hosted box whose IP gets blocked / rate-limited / sleeps* — your "powering
issue". The bridge solves exactly that:

- It runs on **the user's own machine**, so provider requests carry **the user's
  own residential IP**. Every user is their own origin. Nothing central to block.
- There is **no deployment, no hosting, no database, no uptime, no cost**. It is
  not a server in the sense you're removing — it's a local helper, like a dev
  tool. `npm run bridge`, or ship it inside the same process as the static site.
- Node has **no forbidden-header restriction**, so it reproduces
  `Origin`/`Referer`/`Sec-Fetch-*` byte-for-byte from the Python code, and can
  hold Upstage/Mercury cookies and CSRF tokens.
- `localhost` is same-origin-friendly and we control its CORS, so SPA↔bridge is
  a non-issue.

### 3.2 What the bridge is *not*

Not a reverse proxy for the internet, not a multi-tenant service, not something
to deploy. It binds `127.0.0.1` by default. One process per user.

### 3.3 Escape hatch: per-provider `transport`

Each provider declares `transport: 'bridge' | 'direct'`. Default is `bridge`.
If you later confirm from a real browser that some provider *does* send
`Access-Control-Allow-Origin` and ignores `Sec-Fetch-*`, flip that one provider
to `direct` and the SPA calls it with no bridge involved. The UI, event model,
and normalisers are identical either way — only the fetch differs. **The design
does not require you to accept my CORS conclusion; it lets you test it per
provider and switch.**

## 4. The core abstraction: one event model over four wire formats

This is the heart of "provider have thinking or not, how does response come in
that provider … handle them all nicely".

The seven providers do **not** speak one protocol. Verified from source:

| # | Wire format | Providers | Token location | Terminator |
|---|---|---|---|---|
| A | **OpenAI delta** | DeepInfra, Dolphin | `choices[0].delta.content` | `data: [DONE]` (Dolphin also honours `finish_reason`) |
| B | **Workers AI raw** | mCloudFlare | `{"response": "..."}` | `data: [DONE]` |
| C | **OpenAI + reasoning** | LLMChat, Upstage v3 | `delta.reasoning_content` (LLMChat also `delta.reasoning`) and `delta.content` | `[DONE]` / `finish_reason: stop` |
| D | **Typed events** | Mercury | `{type:"reasoning-delta"\|"text-delta"\|"source-url", delta}` | `("done","")` |

Plus two complications that only Upstage has:

- **Inline `<think>…</think>` markup inside content deltas**, with tags **split
  across token boundaries**. v3's `ThinkSplitter` holds back a trailing partial
  tag (`<thi`) until the next chunk decides what it was, and `flush()` releases
  the remainder at stream end. Ported verbatim to
  `src/lib/thinkSplitter.ts` — this is stateful and easy to get wrong.
- **Search lifecycle events**: `search.status.action` ∈
  `search_start` / `search_finish` / `summarizing`, carrying queries and source
  lists, arriving on chunks that have **no** `choices` array.

So every adapter emits one **unified event**:

```ts
type StreamEvent =
  | { kind: 'thinking'; text: string }
  | { kind: 'content';  text: string }
  | { kind: 'source';   sources: Source[] }
  | { kind: 'usage';    usage: Usage }
  | { kind: 'status';   phase: 'searching' | 'summarizing'; detail?: string }
  | { kind: 'done';     finishReason?: string }
  | { kind: 'error';    message: string; retryable: boolean };
```

The UI renders **only** this. Adding a provider with a fifth wire format means
writing one normaliser and zero UI changes. That is the architectural win over
the Python version, where `Completion.py` and `Server.py` each re-handled
provider quirks.

## 5. Capability model (per provider, per model)

`Models.py` already keys everything by provider — that design was right and is
preserved exactly:

```
Model { name, display, family, providers[], connection{provider→modelId},
        capabilities{provider→{reasoning,vision,attachment,search}},
        working{provider→bool}, max_tokens{provider→int}, aliases[], best }
```

Capability keys in use, verified: `reasoning`, `vision`, `attachment`, `search`.
The UI derives from these:

- `reasoning` → show the thinking panel, and enable the reasoning-effort control
- `search` → show the web-search toggle
- `attachment` → show file/image upload (Dolphin only: base64 `image_url` parts + text files)
- `vision` → gate image input
- `working[provider]` → dim unavailable models rather than hiding them

Model lists are **generated, not hand-written** — `scripts/dump_registry.py`
executes the real `Models.py` and emits `src/data/models.ts`. No transcription
risk, and re-running it picks up registry edits.

## 6. Registry facts established by executing the source

Ran `Models.py` directly (stdlib-only, so it executes without any dependency):

```
total models          : 64        (the file's own docstring implies ~87 — it is wrong)
providers in registry : DevsDo, Dolphin, LLMChat, Mercury, Upstage, mCloudFlare
capability keys       : attachment, reasoning, search, vision
models per provider   : DevsDo 55 · LLMChat 24 · Upstage 4 · mCloudFlare 4 · Dolphin 2 · Mercury 1
DevsDo-exclusive      : 32        DevsDo-shared: 23
after removing DevsDo : 32 models
DeepInfra's own list  : 18 models — present in DeepInfra.py, ABSENT from Models.py
```

**Inconsistencies found in the old codebase:**

- **I-1 — DeepInfra is orphaned** *(confirmed).* `Client.py` registers
  `DeepInfraProvider` in `_PROVIDER_SPECS`, and `DeepInfra.py` defines 18 models,
  but `ModelRegistry` contains **no** DeepInfra entry — `list_providers()` never
  returns it, so all 18 were unreachable through `/v1/models`. Fixed here: they
  are surfaced from the provider's own `MODELS` dict and tagged with their real
  provenance in the generated file.
- **I-2 — the `Models.py` header table is stale** *(confirmed).* It claims
  DevsDo 52; the registry actually holds **55**. It omits DeepInfra's 18
  entirely.
- **I-3 — LLMChat's routing tag is missing from the registry** *(confirmed).*
  `LLmChat.py:315` builds `url = f"{_API}?model={model.endpoint}"` where
  `endpoint = f"{tag}/{name}"` and tag is `@cf` or `@hf`. `Models.py` stores only
  the bare name, so **the registry alone cannot construct a valid LLMChat URL**.
  The tag exists only in `LLmChat.py`'s own `MODELS` tuple. The generator joins
  it in: **24/24 resolved** (22 `@cf`, 2 `@hf` —
  `meta-llama/meta-llama-3-8b-instruct` and `mistral/mistral-7b-instruct-v0.2`).
- **I-4 — RETRACTED.** I initially reported that `Models.py` registered
  `solar-mini` under an id Upstage v3 did not recognise
  (`upstage/solar-1-mini-chat`), causing a silent fallback to `solar-pro3`'s
  config. **That was wrong.** The claim came from *inferring* v3's fourth
  `_MODELS` key as `solar-mini` instead of reading it. v3's actual key is
  literally `upstage/solar-1-mini-chat`. Verified both ways: all 4 Upstage ids,
  capabilities **and** context windows agree exactly across `Models.py` and
  `upstage_provider.py`. Nothing to fix. The generator now carries an
  **assertion** that fails the build if the two sources ever genuinely drift,
  which is the useful version of what I thought I'd found.

One genuine gain came out of reading v3's config: **reasoning-effort levels are
per model and are not in `Models.py` at all** — `solar-pro3` accepts
`low/medium/high`, `solar-pro2` and `syn-pro` only `low/high`, `solar-mini` none.
These are now surfaced in the generated data and drive the UI's effort control.

Final catalogue: **50 models across 6 providers** (32 registry + 18 DeepInfra).

## 6b. Bugs found and fixed during the port

Both were caught by tests, not by review — which is the point of writing them.

| Bug | Symptom | Caught by | Fix |
|---|---|---|---|
| `streamHttp` declared `async function*` but called with `await` | Awaiting a generator object returns immediately without running the body, so **every real provider emitted nothing but `end`** — no `meta`, no error, no stream. Silent total failure of all six live providers. | `tests/integration.test.ts` — "credential-gated providers fail loudly instead of hanging" | De-generator'd to a plain `async function` (it never yielded; it drives `emit()`). Verified: 0 `yield` occurrences before conversion. |
| Content swallowed at end of stream | The `ThinkSplitter` holds back up to 7 chars as a possible partial tag. On `finish_reason: "stop"` the normaliser returned early, **permanently discarding a short final token**. | `tests/normalizers.test.ts` — "usage arrives BEFORE done on the same line" | Flush the splitter before emitting `usage` and `done`. Python avoids this differently: `_SSE.parse_line` emits the raw `t-delta` and splits "one level up", so its consumer flushes at stream end. |

Also fixed en route: a literal newline inside a single-quoted string in
`bridge/mock.mjs` (`SyntaxError` on startup — caught by actually starting the
bridge, not by `node --check` on a file I hadn't yet run).

## 7. Project layout

```
app/
├── ARCHITECTURE.md              this document
├── package.json                 dev · build · bridge · test · gen:models
├── vite.config.ts               SPA build; /bridge → 127.0.0.1:8787 in dev
├── scripts/dump_registry.py     executes Models.py → src/data/models.ts
├── bridge/                      LOCAL egress bridge (Node, zero dependencies)
│   ├── server.mjs               http server, SSE relay, mock mode
│   ├── headers.mjs              forbidden-header sets lifted from the Python source
│   └── providers/*.mjs          one adapter per wire format A–D + mock
├── src/
│   ├── types.ts                 StreamEvent, Model, Provider, Capability
│   ├── data/{models,providers}.ts   generated registry + provider metadata
│   ├── lib/
│   │   ├── thinkSplitter.ts     verbatim port of v3 ThinkSplitter
│   │   ├── normalizers.ts       wire formats A–D → StreamEvent
│   │   ├── sse.ts               SSE line framing
│   │   └── bridge.ts            SPA ↔ bridge client (SSE, abort, retry)
│   ├── components/              Sidebar (grouped by provider), ChatView,
│   │                            Message, ThinkingBlock, Sources, Composer, UsageBar
│   └── styles.css
└── tests/                       node:test — normalisers fed canned SSE fixtures
```

Zero runtime dependencies in the bridge (Node ≥20 built-in `http`/`fetch`) — no
`curl_cffi` equivalent needed, because Node's TLS stack is not fingerprint-
filtered the way Python's is, and forbidden headers are settable.

## 8. Verification strategy (given no network egress)

This sandbox cannot reach any provider host, so live end-to-end testing is
**impossible here**. Instead:

1. **Normaliser tests against canned SSE fixtures** reproducing each provider's
   exact wire format, including cross-token `<think>` splits, search-lifecycle
   chunks with no `choices`, usage-only chunks, and `[DONE]`. Run with
   `node --test`. This proves the parsing logic — the part most likely to be
   wrong — without network.
2. **A `mock` provider in the bridge** that streams realistic SSE in all four
   formats, so the full UI path (bridge → SSE → normalise → render) is verifiable
   and demonstrable live.
3. `tsc --noEmit` + `vite build` for type and bundle correctness.
4. **Live provider verification is deferred to the user's machine** and is
   recorded as an open item, not claimed as done.

Nothing here will be described as "working with the real providers" — that claim
requires evidence this sandbox cannot produce.

### Actual results (fresh tool output, 2026-09-23)

```
$ npm test
# tests 60   # pass 60   # fail 0        duration ~4.7 s

$ npx tsc --noEmit
(no output)                              exit 0

$ npx vite build
✓ 42 modules transformed
dist/index.html                   0.62 kB │ gzip:  0.39 kB
dist/assets/index-*.css          13.11 kB │ gzip:  3.48 kB
dist/assets/index-*.js          192.47 kB │ gzip: 58.82 kB
✓ built in 1.26s                         exit 0

$ python3 scripts/dump_registry.py
FINAL: 50 models · LLMChat tags joined 24 · Upstage ids verified vs v3: 4

$ python3 scripts/gen_thinksplitter_fixtures.py
815 cases · lossless invariant 400/400 balanced cases passed   exit 0
```

Live pipeline checks against the running bridge:

```
GET  /bridge/health (through the Vite proxy — the browser's real path)
     -> 200, providers incl. mock/DeepInfra/mCloudFlare/Dolphin/LLMChat/Mercury/Upstage,
        DevsDo absent, credentials {Upstage:false, Mercury:false}
GET  /                      -> 200 (781 bytes)
POST /bridge/chat mock      -> event: meta → event: raw … (envelope frames stream)
POST /bridge/chat Upstage   -> event: meta → event: error{code:missing_credentials} → end
POST /bridge/chat DevsDo    -> 404 (provider removed)
POST /bridge/chat '{not json' -> 400
```

Test breakdown: 50 unit tests over the four wire formats, the SSE framer and the
`ThinkSplitter`; 3 differential tests running **815 cases** generated by
executing the original Python `ThinkSplitter`; 10 integration tests that spawn
the real bridge and drive it through the real browser-side pipeline.

## 9. Migration mapping (Python → TypeScript)

| Python | TypeScript | Note |
|---|---|---|
| `Server.py` FastAPI app (1314 ln) | **deleted** | no hosted server |
| `API/Client.py` provider lifecycle | `bridge/providers/index.mjs` | adapter registry |
| `API/Completion.py` router | `src/lib/` + `data/models.ts` `best` | routing now client-side |
| `API/Models.py` registry (1528 ln) | `src/data/models.ts` **generated** | shape preserved |
| `providers/Upstage.py` v2 (1185 ln) | **replaced** by v3 port | DrissionPage/Chromium gone |
| `providers/DevsDo.py` (1075 ln) | **deleted** | per instruction |
| `providers/{DeepInfra,Dolphin,LLmChat,mCloudFlare,Inception}.py` | `bridge/providers/*.mjs` | headers lifted verbatim |
| `New Upstage Change Logs/upstage_provider.py` v3 | `bridge/providers/upstage.mjs` | incl. `ThinkSplitter` |
| `requirements.txt` + `Dockerfile` | `package.json` | Chromium, xvfb, cloudscraper, curl_cffi, DrissionPage all eliminated |

## 10. Open items / not claimed

- **CORS + `Sec-Fetch` enforcement per provider: UNKNOWN.** Must be tested from
  a real browser on your machine. Flip `transport` to `direct` per provider if
  any allow it (§3.3).
- **No live provider call has been made or verified.** Sandbox egress is blocked.
- **Upstage/Mercury credential capture is not ported yet.** v3 captures cookies +
  CSRF by parsing an RSC response; that flow needs a real logged-in session to
  develop against. The bridge accepts credentials from env/local file for now.
- **Security review deferred** at your instruction. Flagged, not ignored: the
  bridge sets spoofed `Origin`/`Referer` and replays captured session cookies,
  and `Inception.py` contains a hardcoded proxy IP (`217.217.249.160:8080`) whose
  provenance should be reviewed before this ships.
- **Attachments** (Dolphin images/text) designed for, UI not yet wired.
