# Architecture — Python server → React SPA calling providers directly

**Status:** design locked, implemented, 82/82 tests green

## 0. REVISION 2 — the transport is DIRECT (this supersedes Revision 1)

Revision 1 of this document concluded that a browser cannot call these providers
and designed a local Node relay instead. **The user rejected that.** The
instruction was explicit: hit the real provider API directly, no `/bridge/chat`,
no Python, npm only, and the real URL must be what appears in the network log.

Direct is now the default for all seven providers and the relay is not started.

**What the reversal changed, and what it did not.** The evidence in §2 is still
correct — `Origin`, `Referer`, `User-Agent`, `Cookie` and every `Sec-*` header
are forbidden header names that no JavaScript can set, in any architecture. What
Revision 1 got wrong was treating that as a reason to *insert a relay*. It is
not. Those five headers are the only thing a relay adds; everything the provider
actually parses — the endpoint, the JSON body, the wire format, the credentials —
is fully constructible in the browser, and `payloads.ts` constructs it.

So the honest framing is: **direct mode sends everything that can be sent.** The
five forbidden headers are filled in by the browser itself, which means the
provider sees `Sec-Fetch-Site: cross-site` and this page's origin. Whether it
answers anyway is that provider's CORS decision — and that is an empirical
question about each provider, not a reason to pre-emptively route around it.

The relay survives only as an opt-in per-provider fallback (§3.3), for any
provider the user confirms actually blocks cross-site reads.

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
| **"No server" — browser calls the provider APIs directly** | ✅ **Done** | `direct.ts` POSTs to each provider's real URL. No relay hop, verified with the bridge process stopped. Five forbidden headers are browser-filled — see §0 and §2. |
| Use the **user's IP** for provider calls | ✅ **Achieved** | The browser IS the client, so requests carry the user's own IP by construction |
| Real URL visible in the network log | ✅ **Done** | DevTools shows the provider host. The UI echoes the last URL hit, and tests assert `resolveRequest()` returns the true endpoint per provider |

## 2. What the browser still cannot control (evidence, unchanged)

> This section's *facts* are correct and verified. Its Revision-1 *conclusion* —
> that they necessitate a relay — was wrong and is superseded by §0. Kept intact
> because the constraint is real and any future reader needs it.

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

## 3. The design: static SPA → provider, directly

```
┌────────────────────── the user's own machine ──────────────────────┐
│                                                                    │
│   Browser tab                                        Provider APIs │
│  ┌─────────────────────────────────────┐                          │
│  │  React SPA                          │      user's own IP       │
│  │                                     │  ───────────────────────►│ DeepInfra
│  │  payloads.ts  builds the exact body │                          │ LLMChat
│  │  headers.ts   keeps what JS may set │  ◄───────────────────────│ Dolphin
│  │  direct.ts    POSTs the real URL    │        raw SSE           │ mCloudFlare
│  │  normalizers  4 wire formats → 1    │                          │ Mercury
│  │  mock.ts      offline, zero network │                          │ Upstage
│  └─────────────────────────────────────┘                          │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
   No hosted server. No relay. No Python. The provider host in DevTools
   is the provider host the code called — nothing sits in between.
```

### 3.1 Request formation is the part that had to be right

`resolveRequest(req)` returns the URL, method, headers and body a provider
expects, and is a pure function — no DOM, no network — so it is unit-testable.
Each builder in `payloads.ts` names the Python source lines it was ported from:

| Provider | Endpoint (real, from source) | Body quirks preserved |
|---|---|---|
| DeepInfra | `api.deepinfra.com/v1/openai/chat/completions` | `stream_options.include_usage` requested then ignored, as the Python parser does; temperature clamped 0–2 |
| mCloudFlare | `multi-modal.ai.cloudflare.com/api/inference` | bare OpenAI-ish body; response is `{"response":…}` with no `choices` |
| Dolphin | `chat.dphn.ai/api/chat` | **no system role** — folded into a user turn as `[SYSTEM] YOU HAVE TO ACT AS :`; `template:"creative"` |
| LLMChat | `llmchat.in/inference/stream?model={tag}/{name}` | model in the **query string**, not the body; `temperature` omitted entirely when unset |
| Mercury | `chat.inceptionlabs.ai/api/chat` | system → prefixed user turn; **consecutive user turns merged** with `\n\n`; `{id, role, parts:[{type,text,state:"done"?}]}` |
| Upstage | `ap-northeast-2.apistage.ai/…?include_think=true` | `mode:["search"]` on the **last** user turn only; effort auto-derived (search→high, else low), explicit wins **only if that model accepts it**; `search_provider:"tavily"` |

### 3.2 Headers: what is sent, and what is reported instead of sent

`headers.ts` partitions each provider's header set against the Fetch spec's
forbidden names (exact list **plus** the `Sec-`/`Proxy-` prefix rule, which
covers `Sec-Fetch-*` and `sec-ch-ua*`). Direct mode sends everything settable —
`Accept`, `Accept-Language`, `Content-Type`, `Cache-Control`, `x-request-id`,
`x-session-token`, `x-csrf-token` — and **surfaces the remainder** rather than
pretending. A test asserts no provider's settable set contains a forbidden name
and that the split is lossless.

The three providers whose Python code asserts `Sec-Fetch-Site: same-origin`
(mCloudFlare, Dolphin, Mercury) will instead receive `cross-site`, because a
provider is a different site from this page. That is not hideable from any
client-side code, and it is the single most likely cause of a refusal.

### 3.3 Failure is loud, and the relay remains as an escape hatch

A CORS or network failure produces an `error` event naming the exact host and
pointing at DevTools → Network, never a silent hang. HTTP 401/403 adds a
provider-specific hint (Upstage → CSRF panel, Mercury → fetch a session).

Every provider still carries `transport: 'direct' | 'bridge'`. All seven are
`direct`. Should one be confirmed to block cross-site reads, flipping that single
field routes it through `bridge/server.mjs` — the relay code is retained and
covered by `tests/integration.test.ts`, not deleted. The UI, event model and
normalisers are identical either way; only the fetch differs.

### 3.4 Credentials without a relay

A browser will not let JavaScript read another site's cookies, so direct mode
cannot capture a logged-in Upstage or Mercury session automatically. Instead the
**Keys** panel stores a pasted Upstage CSRF token and Mercury session token in
`localStorage` only; each is sent solely to its own provider, and "Fetch
session" POSTs straight to `chat.inceptionlabs.ai/api/session`. Upstage's
session cookie rides along automatically when the user is signed into the
console in the same browser (`credentials:'include'`).

`Inception.py` routes Mercury credential capture through a hardcoded
plaintext-HTTP proxy at `217.217.249.160:8080`, whose provenance is unknown and
which would see session material in the clear. **That proxy is not used.**
Requests go to Inception's real host over TLS.

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
├── package.json                 dev · build · test · bridge (fallback) · gen:models
├── vite.config.ts               SPA build; /bridge proxy retained for the fallback only
├── scripts/dump_registry.py     executes Models.py → src/data/models.ts
├── src/
│   ├── types.ts                 StreamEvent, Model, Provider, Capability, Transport
│   ├── data/{models,providers}.ts   generated registry + provider metadata
│   ├── lib/
│   │   ├── stream.ts            THE entry point: routes mock / direct / bridge
│   │   ├── direct.ts            ★ resolveRequest() + streamDirect() → real URL
│   │   ├── payloads.ts          ★ per-provider request bodies (browser-side)
│   │   ├── headers.ts           ★ forbidden-vs-settable header partition
│   │   ├── mock.ts              ★ offline simulator, in-browser, zero network
│   │   ├── thinkSplitter.ts     verbatim port of v3 ThinkSplitter
│   │   ├── normalizers.ts       wire formats A–E → StreamEvent
│   │   ├── sse.ts               SSE line framing
│   │   ├── envelope.ts          bridge envelope framing (fallback path only)
│   │   └── bridge.ts            relay client (fallback path only)
│   ├── components/              Sidebar (grouped by provider), Message, Composer
│   ├── App.tsx                  thread + topbar + Keys credential panel
│   └── styles.css
├── bridge/                      OPT-IN FALLBACK, not started by default
│   ├── server.mjs               relay (streamHttp bug fixed — see §6b)
│   ├── headers.mjs · payloads.mjs · mock.mjs
└── tests/                       node:test — 82 tests
```

★ = added in Revision 2. Zero runtime dependencies anywhere: the SPA is
React + Vite only, and the fallback relay uses Node ≥20 built-in `http`/`fetch`.
No `curl_cffi` equivalent is needed — Node's TLS stack is not fingerprint-
filtered the way Python's is.

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
# tests 82   # pass 82   # fail 0        duration ~10 s

$ npx tsc --noEmit
(no output)                              exit 0

$ npx vite build
✓ 47 modules transformed
dist/index.html                   0.62 kB │ gzip:  0.39 kB
dist/assets/index-*.css          14.81 kB │ gzip:  3.81 kB
dist/assets/index-*.js          211.54 kB │ gzip: 64.41 kB
✓ built in 1.21s                         exit 0

$ python3 scripts/dump_registry.py
FINAL: 50 models · LLMChat tags joined 24 · Upstage ids verified vs v3: 4

$ python3 scripts/gen_thinksplitter_fixtures.py
815 cases · lossless invariant 400/400 balanced cases passed   exit 0
```

Direct-mode verification — **the relay was deliberately stopped first**, so
nothing below can be passing by accident via the bridge:

```
bridge process STOPPED          -> nothing listening on :8787
GET  /bridge/health             -> 500   (proxy target gone, as expected)
GET  /                          -> 200   (SPA unaffected)
Vite transform of all 9 modules -> 200, 0 transform errors
     main.tsx App.tsx stream.ts direct.ts payloads.ts headers.ts
     mock.ts Sidebar.tsx styles.css
```

Request formation is asserted per provider rather than eyeballed —
`tests/direct.test.ts` checks that all six real providers resolve to their own
`https://` endpoint with **no** `bridge`/`localhost`/`127.0.0.1`/`:8787`
anywhere in the URL, that no settable header set contains a forbidden name, and
that each body matches its Python original. Connection establishment is
exercised with `fetch` stubbed: SSE framing across chunk boundaries, a CORS
`TypeError`, an HTTP 403, and an abort that must flush held-back text.

Test breakdown: 72 unit tests over the five wire formats, the SSE framer,
`ThinkSplitter`, request formation and stubbed connections; 3 differential tests
running **815 cases** generated by executing the original Python `ThinkSplitter`;
10 integration tests that spawn the fallback relay and drive it through the real
browser-side modules.

**Two of the new tests failed on first run, and both failures were the test's
fault** — recorded rather than quietly adjusted: one asserted LLMChat's URL
equalled the bare endpoint when it legitimately appends `?model={tag}/{name}`;
one asserted a partial `<think>` tag must *not* reach content, when flushing it at
end-of-stream is precisely the holdback bug fixed in §6b. Discarding it was the
defect, so the assertion was inverted, not weakened.

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

- **CORS + `Sec-Fetch` enforcement per provider: STILL UNKNOWN, and now the
  critical open question.** Direct mode is implemented and correct at the request
  level, but whether each provider *answers* a cross-site browser request can
  only be observed from a real browser with real network access. This sandbox
  kills TLS to all six hosts. **This is the one thing to check first.** A refusal
  surfaces as an error naming the host; flip that provider's `transport` to
  `'bridge'` if it genuinely blocks (§3.3).
- **No live provider call has been made or verified.** Sandbox egress is blocked.
- **Upstage/Mercury credentials must be pasted by the user** (§3.4). Automatic
  capture is impossible in direct mode — a browser will not let JS read another
  site's cookies. v3's RSC-parsing capture flow is therefore not ported.
- **Security review deferred** at your instruction. Flagged, not ignored: tokens
  live in `localStorage` (readable by any script on this origin, so no third-party
  script may ever be added without review); the fallback relay spoofs
  `Origin`/`Referer` and replays captured cookies; `Inception.py` hardcodes a
  plaintext-HTTP proxy (`217.217.249.160:8080`) of unknown provenance — **not
  used here**.
- **Attachments** (Dolphin images/text) designed for, UI not yet wired.
- **"and rust" is unresolved.** The request mentioned Rust after npm. No Rust
  toolchain exists in this sandbox (`cargo`/`rustc` absent), and nothing here
  requires one — the SPA is pure npm/TypeScript. If a Rust shell (e.g. Tauri,
  whose HTTP plugin bypasses CORS entirely and would settle the open question
  above) was intended, that is a separate, additive decision.
