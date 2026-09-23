# ADUSKILLS Handoff — HANDOFF-20260923-react-migration

**Objective:** Python LLM gateway → npm/React SPA, no hosted server, provider
calls from the user's own IP. Upstage v2→v3. DevsDo removed. Models grouped by
provider. Design/architecture focus, **not** security. Work autonomously.

---

## REVISION 3 — READ THIS BEFORE ANYTHING ELSE

**The transport is DIRECT, and the earlier bridge design was WRONG.** The user
rejected it explicitly:

> *"naa bro u did wrong.. thng i mean to say u is dirclty connec tthe ip... make
> sure it work as not bridge/chat ... as the real url hits direclty in the
> network logs.. no python involment do use npm"*

The browser now builds each request (`payloads.ts`) and POSTs it straight to the
provider's real endpoint (`direct.ts`). All seven providers carry
`transport:'direct'`. The Node relay is retained only as an opt-in fallback and
**is not started by default** — verified with the relay process stopped: nothing
on `:8787`, `/bridge/health` 500s, while the SPA, all nine modules and the
in-browser simulator still work.

Anything below written before Revision 3 that describes the bridge as *the*
design is **stale**. Trust `app/ARCHITECTURE.md` §0 and §3 instead.

**The mistake, precisely:** I verified correctly that a browser cannot set
`Origin`/`Referer`/`User-Agent`/`Cookie`/`Sec-*`. I then inferred that therefore
a browser cannot call the API at all, and built infrastructure around an
untested inference. Those five headers are the *only* thing a relay adds. The
endpoint and body — what a provider actually parses — are fully settable
client-side. Whether a provider rejects cross-site is an empirical per-provider
CORS question that belongs in the user's browser, not in a redesign.
`DECISION-20260923-local-egress-bridge` is marked **superseded**; see
`DECISION-20260923-direct-transport` and the new first fact in
`LEARNING-20260923-verify-dont-infer`.

**Current state:** 82/82 tests (was 60), `tsc --noEmit` exit 0 strict, `vite
build` 211.54 kB JS / 64.41 kB gzip. Committed `8dd3937`.

**The one open question that matters now:** per-provider CORS enforcement is
**UNKNOWN** — this sandbox kills TLS to all six hosts. Only the user's browser
can settle it. A refusal yields an error naming the host; flip that provider to
`transport:'bridge'` if it genuinely blocks.

**Unresolved:** the user's message ended *"do use npm... as for all.... and
rust..."*. No Rust toolchain exists here (`cargo`/`rustc` absent) and nothing
requires one. If a Rust shell was meant — e.g. **Tauri**, whose HTTP plugin
bypasses CORS entirely and would settle the open question above — that is a
separate additive decision and should be confirmed, not assumed.

**Date:** 2026-09-23 · **Branch:** `arena/01a0ccca-serv` · **Base:** `main` @ `e57f3a2`
**Status:** **SUBSTANTIALLY COMPLETE** — built, tested, verified offline. Live
provider verification is impossible in this sandbox and is **not claimed**.

**Supersedes:** `HANDOFF-20260923-activation` (that one resolved to "wait for
objective"; the objective arrived).

---

## Read these first

| File | Why |
|---|---|
| `app/ARCHITECTURE.md` | The design. **§0 REVISION 2 first**; §2 is the load-bearing evidence; §6b lists two real bugs; §6 records a finding I **retracted** |
| `.aduskills/memory/intent/IC-20260923-react-migration.md` | Locked requirements R1–R16, assumptions A1–A5, acceptance tests |
| `.aduskills/memory/nodes/DECISION-20260923-direct-transport.json` | **CURRENT** — why direct, what it can and cannot send |
| `.aduskills/memory/nodes/DECISION-20260923-local-egress-bridge.json` | **SUPERSEDED** — kept for the reasoning that was wrong |
| `.aduskills/memory/nodes/LEARNING-20260923-verify-dont-infer.json` | Three times I interpreted a tool result past what it proved |
| `.aduskills/state/skills-route.md` | Rev 2 — security skills de-routed **by user instruction** |

## What was built

`app/` — 32 tracked files, ~4,512 hand-written lines + 689 generated.

- **SPA:** Vite 5 + React 18 + TS 5.6, strict. One page. Sidebar groups models
  **by provider**; per-provider capabilities drive which controls appear.
- **Bridge:** `bridge/server.mjs` + `headers.mjs` + `payloads.mjs` + `mock.mjs`.
  **Zero runtime dependencies.** Binds `127.0.0.1:8787`. Relays raw provider SSE
  verbatim — normalisation happens in the browser, so there is one parser, not two.
- **Core abstraction:** 4 wire formats (`openai-delta`, `workers-raw`,
  `reasoning-delta`, `typed-events`) + `upstage-v3` → one `StreamEvent` union.
  `Message.tsx` never branches on provider.
- **Generated data:** `scripts/dump_registry.py` **executes** `Models.py` and
  emits `src/data/models.ts`. 64 → 32 after dropping DevsDo, +18 recovered
  DeepInfra = **50 models / 6 providers**.
- **Offline Simulator:** 5 synthetic models, one per wire format, so every
  normaliser is reachable from the UI with no network and no credentials.

## The one divergence — flagged, not hidden

**The browser cannot call these providers directly.** Every one of the six is
sent `Origin`/`Referer`; mCloudFlare, Dolphin and Mercury also send
`Sec-Fetch-Site: same-origin`. All `Sec-*` headers are **forbidden request
headers**, unmodifiable from JavaScript (MDN Glossary; W3C Fetch Metadata §4.2),
and `Origin`/`Referer` are not script-settable either. A browser will always
report `cross-site`.

Delivered instead: a **local** Node bridge on the user's machine. No hosted
server, no deployment, no shared datacenter IP, nothing to sleep or be blocked —
which is the actual goal behind "no server" and "use the user ip". Each provider
carries `transport: 'bridge' | 'direct'`, so any provider later confirmed
CORS-friendly bypasses the bridge with a one-field change.

**A1 (unconfirmed):** "the powering issue" = the hosted Space's datacenter IP
being blocked/rate-limited, or the Space sleeping. If it meant something else,
say so and I'll re-weight the design.

## Verification evidence (all fresh, 2026-09-23)

```
npm test            # tests 60  # pass 60  # fail 0        (~4.7 s)
npx tsc --noEmit    exit 0, no output                      (strict)
npx vite build      42 modules · 192.47 kB JS / 58.82 kB gzip · exit 0
dump_registry.py    50 models · LLMChat tags 24/24 · Upstage ids 4/4
gen_fixtures.py     815 differential cases · invariant 400/400 balanced

GET  /bridge/health (via the Vite proxy = the browser's real path)
     200 · 6 providers + mock · DevsDo absent · creds {Upstage:false,Mercury:false}
GET  /                     200
POST /bridge/chat mock     event:meta → event:raw … (streams)
POST /bridge/chat Upstage  meta → error{missing_credentials} → end
POST /bridge/chat DevsDo   404
POST /bridge/chat '{bad'   400
```

Test split: 47 unit (4 wire formats, SSE framer, ThinkSplitter) · **3
differential over 815 cases generated by executing the original Python
`ThinkSplitter`** · 10 integration that spawn the real bridge and drive it
through the real browser-side modules.

Both processes are running now: bridge `egress-bridge-7763d19b` (8787),
Vite `chat-app-786656c4` (5173, `0.0.0.0`).

## Two real bugs found and fixed

| Bug | Impact | Caught by |
|---|---|---|
| `streamHttp` declared `async function*` but called with `await` | Awaiting a generator object returns without running the body → **all six real providers emitted nothing but `end`**. Silent total failure. | integration test "credential-gated providers fail loudly instead of hanging" |
| `ThinkSplitter` holdback not flushed on `finish_reason:"stop"` | A short final token (≤7 chars) was **permanently discarded** | unit test "usage arrives BEFORE done on the same line" |

Plus a literal newline inside a single-quoted string in `bridge/mock.mjs` —
caught by actually starting the bridge, not by `node --check`.

## A finding I retracted

**I-4 was wrong.** I reported that `Models.py` mapped `solar-mini` to an id v3
didn't recognise, causing a silent fallback to `solar-pro3`'s config. I had
**inferred** v3's fourth `_MODELS` key as `solar-mini` from the registry name
instead of reading it. It is literally `upstage/solar-1-mini-chat`. All 4 ids,
capabilities and context windows agree across both sources. Retracted in place in
`ARCHITECTURE.md` §6 with the reasoning; the bogus "reconcile" rewrite was
replaced by a build-failing assertion against genuine future drift.

Also corrected: a first CORS probe reported "ACAO absent → browser blocks" for
all six hosts when curl had actually received **no response at all** (`exit 35
SSL_ERROR_SYSCALL`) — sandbox egress is allowlisted. "Host unreachable" ≠ "header
missing". Real status of per-provider CORS enforcement: **UNKNOWN**.

## Genuine findings in the old codebase (kept)

- **I-1** DeepInfra is orphaned — registered in `Client.py`, 18 models in
  `DeepInfra.py`, **zero** entries in `ModelRegistry`. Unreachable via `/v1/models`.
- **I-2** `Models.py` header table is stale — claims DevsDo 52, actually 55; omits DeepInfra.
- **I-3** LLMChat's `@cf`/`@hf` routing tag exists **only** in `LLmChat.py`; the
  registry alone cannot build a valid URL. Joined in, 24/24 (22 `@cf`, 2 `@hf`).
- **New:** Upstage reasoning-effort levels are per model and absent from
  `Models.py` — pro3 `low/medium/high`, pro2 & syn-pro `low/high`, mini none. Now surfaced.

## Security items recorded, NOT actioned (deferred by R2)

1. `Inception.py:29` hardcodes a plaintext-HTTP proxy `http://217.217.249.160:8080`
   used during Mercury credential capture — unknown provenance, would see session
   material in the clear. **Disabled by default** in the port (`MERCURY_PROXY`
   opt-in). A design decision, not a security review.
2. The bridge replays captured session cookies. A root `.gitignore` was added —
   the repo had **none** — covering `.env*`, `*.key`, `*.pem`,
   `credentials.json`, and the cache dirs.

## Open tasks

1. **User to confirm A1** and try the UI against the Offline Simulator.
2. **Run v3's own offline pytest suite** — needs `pip install pytest curl_cffi`;
   approval gate, not yet taken. Would independently validate the Upstage port.
3. **Port Upstage/Mercury credential capture** — needs a real logged-in session;
   cannot be developed blind.
4. **Verify per-provider CORS/`Sec-Fetch` enforcement from a real browser**, then
   flip `transport` to `'direct'` where possible.
5. Dolphin attachment UI (capability already modelled).
6. Decide the SPA's host (static anywhere) and whether to retire the Dockerfile.
7. **Push** — not requested; only local commits made.

## Blockers

- **No provider network egress** in this sandbox (`curl` exit 35 for all six
  hosts; controls github/pypi exit 0). Live end-to-end verification is
  impossible here and must happen on the user's machine.
- **No browser, no docker** → no real-DOM E2E. Substituted with an integration
  test that spawns the real bridge and drives the real browser-side modules in
  Node. Recorded as a limitation, **not** as equivalent coverage.
- **No credentials** → Upstage/Mercury cannot be exercised even with network.

## Rollback path

`main` untouched at `e57f3a2`. All work is on `arena/01a0ccca-serv` in new paths
(`app/`, `.gitignore`, `.aduskills/`, `AGENTS.md`). **Not one byte of
`My PREVIOUS ENTIRE SERVER/` or `New Upstage Change Logs/` was modified** —
`git diff` on those paths is empty. Revert = delete `app/` and the two commits.

## Exact next recommended action

**Ask the user to open the preview and try the Offline Simulator**, and confirm
assumption A1. Then, in order: get approval for `pip install pytest curl_cffi`
and run v3's offline suite to independently validate the Upstage port; then
tackle credential capture, which is the only thing standing between this and a
real provider call.

**First action in any new session:** read this handoff, then re-verify
`.aduskills/state/environment-inventory.md` — sandbox state does not persist, and
the two background processes will be gone.

### Restart procedure (learned the hard way, 2026-09-23)

Background processes **and `node_modules` are both reaped between turns.**
`node_modules` is gitignored, so it is excluded from snapshots and does not come
back. Starting Vite without reinstalling fails confusingly: `npx` fetches a
*fresh* `vite@8.x` instead of the local 5.4, then dies with
`ERR_MODULE_NOT_FOUND: Cannot find package 'vite' imported from vite.config.ts`
— which looks like a config bug but is just a missing install.

```bash
cd app
npm ci                 # 74 packages, ~2s, reproducible from the committed lockfile
node bridge/server.mjs # -> 127.0.0.1:8787
npx vite --host 0.0.0.0 --port 5173
```

Always `npm ci` **first**. `package-lock.json` is committed, so the restore is
exact and fast.

Verify before declaring it up — `curl` on `/` returning 200 proves nothing about
the app, because the shell is static HTML. Request the transformed modules
instead, which surfaces real compile errors:

```bash
for m in /src/main.tsx /src/App.tsx /src/lib/normalizers.ts /src/data/models.ts; do
  curl -s -o /tmp/o -w "%{http_code} " "http://127.0.0.1:5173$m"; wc -c < /tmp/o
done
curl -s http://127.0.0.1:5173/bridge/health   # must go THROUGH the proxy
```

Last verified: all 9 app modules → 200 with 0 transform errors; bridge via proxy
`ok=True providers=7 DevsDo=False`; mock stream 2495 bytes / 1 meta / 15 raw /
1 end; Upstage without creds → `"code":"missing_credentials"`.
