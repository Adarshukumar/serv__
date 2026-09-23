# Intent Contract — IC-20260923-react-migration

**ID:** `IC-20260923-react-migration` · **Created:** 2026-09-23 · **Status:** SUBSTANTIALLY DELIVERED
**Supersedes:** `IC-20260923-activation` (which resolved U1 — the objective is now known)
**Skill:** `intent-lock` · **Confidence:** HIGH on what was asked, MEDIUM on one inferred point

---

## Objective

Rewrite the Python LLM gateway as an **npm/React single-page app** with **no
hosted server**, where provider calls originate from the **user's own IP**.
Replace Upstage v2 with the v3 provider. Remove DevsDo. Ship a good-looking chat
UI with models **grouped by provider**, and an architecture that properly models
per-provider differences — thinking support, response shape, streaming format.
Focus on **design and architecture, not security**. Work autonomously.

## Deliverable

`/home/user/serv__/app/` — a Vite + React 18 + TypeScript SPA plus a
zero-dependency local Node egress bridge, with generated model data, 60 passing
tests, a clean typecheck, a production build, and `ARCHITECTURE.md` recording the
design and every finding.

## Explicit requirements (user-stated)

| # | Requirement | Status |
|---|---|---|
| R1 | Focus on design and architecture | ✅ `ARCHITECTURE.md` is the primary deliverable |
| R2 | **Not** security | ✅ security skills de-routed by instruction; see `skills-route.md` §Deferred |
| R3 | Python → npm/React | ✅ Vite + React 18 + TS |
| R4 | No server | ⚠️ **Partially met, deliberately** — see Divergence below |
| R5 | Use the user's IP to reach providers | ✅ delivered by the local bridge |
| R6 | One nice-looking single-page chat frontend | ✅ SPA, dark theme, no UI framework |
| R7 | Replace Upstage with the new provider | ✅ v3 ported; v2 not carried over |
| R8 | Remove DevsDo | ✅ provider gone; 32 exclusive models dropped; 404 on request |
| R9 | Call the API directly, not "in the server format" | ⚠️ see Divergence |
| R10 | Architecture handles per-provider thinking / response shape | ✅ 4 wire formats → 1 `StreamEvent` model |
| R11 | Models shown on the basis of providers | ✅ sidebar grouped by provider, per-provider capabilities |
| R12 | Check all the files carefully | ✅ all 18 files read; registry **executed**, not transcribed |
| R13 | Understand all providers deeply, then work | ✅ endpoints, headers, payloads, parsers, models extracted from source |
| R14 | Work autonomously | ✅ |
| R15 | Commit the previous things to git first | ✅ `591d960` before any new code |
| R16 | Understand the environment and change route | ✅ inventory re-verified; skill route rewritten (rev 2) |

## Divergence — the one place I did not do literally what was asked

**R4/R9: a browser cannot call these providers directly.** This is not a
preference or a shortcut; it is forced by the web platform, and it is
**SOURCE_SUPPORTED**:

- All `Sec-`-prefixed headers are *forbidden request headers*, unmodifiable from
  JavaScript — MDN Glossary and W3C Fetch Metadata §4.2.
- `Origin` and `Referer` are likewise not script-settable.
- Every one of the six providers sends `Origin`/`Referer`; mCloudFlare, Dolphin
  and Mercury additionally send `Sec-Fetch-Site: same-origin`, which a browser
  will always report as `cross-site`.

**What I delivered instead:** a *local* Node bridge on the user's own machine.
It satisfies R5 (user's IP) fully and R4 in substance — there is no hosted
server, no deployment, no HF Space, no shared datacenter IP, nothing to sleep or
get blocked. Each provider also carries a `transport: 'bridge' | 'direct'` flag
so any provider later confirmed CORS-friendly can bypass the bridge with a
one-line change.

I did **not** silently substitute this. It is documented in `ARCHITECTURE.md`
§1–§3 and surfaced to the user directly.

## Inferred preferences (ASSUMPTIONS — labelled, not user-stated)

- **A1** "the powering issue" = the hosted HF Space's shared datacenter IP being
  blocked/rate-limited, or the Space sleeping. The local-bridge design targets
  exactly that. *Could be wrong* — if it meant something else (cost, cold starts,
  concurrency), the design still helps but the emphasis may be off.
- **A2** "port see" in *"in which u will put... port see"* was unreadable and is
  treated as noise. No feature was invented from it.
- **A3** New code lives in `app/` rather than replacing the repo root, so
  `My PREVIOUS ENTIRE SERVER/` survives intact.
- **A4** The old server's system prompt (`"You are a So powerfUl assistant
  Powered By Adarsh Kumar"`) is carried over, lightly normalised, as the default.
- **A5** A `mock` provider is acceptable as a development/demo affordance. It is
  clearly labelled "Offline Simulator" and listed last.

## Inputs available

Both source trees (18 files, 11,625 LOC); the ADUSKILLS bundle; python3 3.11.2;
node v22.22.3; npm (registry reachable, HTTP 200); git + gh authenticated.

## Unknowns

| # | Unknown | Impact |
|---|---|---|
| U1 | ~~What is the objective?~~ **RESOLVED** | — |
| U2 | Is `upstage_provider.py` v3 final/approved? | Its offline suite has never been run here (no pytest, no `curl_cffi`). Ported as-is. |
| U3 | Is the old server live on HF Spaces? | Unanswered. Treated conservatively — nothing in it was modified. |
| U4 | Are provider credentials available? | Unanswered. Bridge accepts them via env; capture flow **not ported**. |
| U5 | Is `console.upstage.ai` reachable? | **UNKNOWN** — sandbox TLS egress blocked (`curl` exit 35). Untestable here. |
| U6 | Which providers actually enforce `Sec-Fetch-*`/`Origin`? | **UNKNOWN** — cannot be probed from here. The bridge sets them regardless, so it works either way. |
| U7 | Target host for the SPA (GitHub Pages? Vercel? local only?) | Affects nothing built so far; the SPA is static. |

## Constraints honoured

- No docker, no browser, no pytest → substituted `node --test` + an integration
  test that spawns the real bridge.
- No provider network egress → no live claim was made anywhere.
- `My PREVIOUS ENTIRE SERVER/` is the only copy of working code → **not one byte
  modified**; `git diff` on those paths is empty.
- Branch `arena/01a0ccca-serv` only; `main` untouched at `e57f3a2`.
- Repo had no `.gitignore` → added one covering `node_modules/`, `dist/`,
  `.env*`, key material and credential cache dirs **before** anything could be
  tracked by accident.

## Acceptance tests

- [x] `npm install` succeeds (68 → 74 packages, exit 0)
- [x] `npx tsc --noEmit` exit 0, no output
- [x] `npx vite build` exit 0 — 192.47 kB JS / 58.82 kB gzip
- [x] `npm test` → **60 tests, 60 pass, 0 fail**
- [x] All 4 wire formats normalise correctly (unit tests A–E)
- [x] TS `ThinkSplitter` matches the Python original on **815 generated cases**
- [x] Bridge starts, serves `/bridge/health`, and streams through the Vite proxy
- [x] All 5 mock wire formats stream end-to-end through the real browser-side pipeline
- [x] DevsDo returns 404
- [x] Upstage/Mercury without credentials → explicit `missing_credentials` error, not a hang
- [x] Aborting mid-stream leaves the bridge healthy
- [x] Model data generated by executing `Models.py` (50 models), never hand-typed
- [x] LLMChat `@cf`/`@hf` tags joined: 24/24
- [x] Upstage ids asserted against v3 `_MODELS`: 4/4
- [x] No pre-existing project file modified
- [ ] **Live call against a real provider** — IMPOSSIBLE in this sandbox (U5/U6)
- [ ] **Real-DOM browser E2E** — IMPOSSIBLE here (no browser, no docker)
- [ ] **Upstage/Mercury credential capture ported** — out of scope this pass

## Approval gates still open

1. Committing/pushing this work — *committing to the session branch is proceeding
   under R15's "commit" instruction; **pushing** was not requested and is held.*
2. Installing `pytest`/`curl_cffi` to run v3's own offline suite.
3. Any live provider call with real credentials.
4. Any change to `My PREVIOUS ENTIRE SERVER/` (none made).
5. Retiring the Dockerfile / HF Spaces deployment.
6. Opening a PR or merging to `main`.

## Non-goals

- No security review (R2). Findings are *recorded*, not remediated.
- No changes to the Python server, the Dockerfile, or `New Upstage Change Logs/`.
- No credential-capture port (needs a real logged-in session to develop against).
- No Dolphin attachment UI (capability modelled, UI not wired).
- No database, auth, accounts, multi-tenancy, or hosting.
- No UI framework or component library.
- No work on the `aduskill` bundle itself.

## Confidence

**HIGH** on requirements — the message was long and specific, and every clause
maps to something built or explicitly deferred. **MEDIUM** on A1 (what "the
powering issue" means), because the bridge design is tuned to that reading. If
A1 is wrong the architecture still holds, but tell me and I'll re-weight it.

---

## AMENDMENT (same day) — R-transport corrected by the user

The original contract recorded the transport as a **local egress bridge**, on my
recommendation, because I concluded a browser cannot call these providers. The
user rejected that:

> *"naa bro u did wrong.. thng i mean to say u is dirclty connec tthe ip... make
> sure it work as not bridge/chat ... as the real url hits direclty in the
> network logs.. no python involment do use npm... and rust..."*

**Corrected requirement:** the browser calls each provider's real API URL
directly. No `/bridge/chat` hop, no Python, npm only. The real provider URL must
be what appears in the network log.

Status: **implemented and committed (`8dd3937`)**, all seven providers
`transport:'direct'`, relay retained only as an opt-in fallback and not started
by default.

**What this amendment does NOT change:** the Fetch-spec constraint is real and
verified. `Origin`, `Referer`, `User-Agent`, `Cookie` and every `Sec-*` header
remain unsettable from JavaScript. Direct mode sends everything settable and
reports the remainder. Whether each provider accepts a cross-site request is its
own CORS decision — **still UNKNOWN** and only observable from the user's browser.

**Still unanswered:** what "and rust" means. No Rust toolchain exists in this
sandbox and nothing in the delivered app requires one. Recorded as an open
question rather than assumed; a Tauri shell would be additive and would
incidentally bypass CORS entirely.
