# Intent Contract — IC-20260923-activation

**ID:** `IC-20260923-activation` · **Created:** 2026-09-23 · **Status:** PARTIALLY LOCKED
**Skill:** `intent-lock` · **Confidence:** MEDIUM

Activation itself is locked and complete. The *work* objective is not — the user
sent `ACTIVATE` with no task, which `ACTIVATE.md` step 10 handles by waiting.

---

## Objective

**Locked part:** Initialize ADUSKILLS for `/home/user/serv__` and "establish the
space" — a durable, inspected, gated working environment — then begin work.

**Unlocked part:** *What* to work on. The user said "lets start working..." but
named no deliverable. Three candidates are inferable from repository state
(labelled INFERRED, not user-stated):

- **C1 — Integrate the v3 Upstage provider into the server.** `New Upstage Change
  Logs/upstage_provider.py` (1,374 lines) appears to be a rewrite of
  `My PREVIOUS ENTIRE SERVER/API/providers/Upstage.py` (1,185 lines). Evidence:
  identical class name `UpstageProvider`, and the v3 public method set is a
  strict **superset** of v2's (all 40 v2 methods present, plus `stream`,
  `_events_with_retry`, `_cookies_from`, and usage tracking). v3's own docstring
  states "NO requests · NO DrissionPage · NO threads". Integrating it would let
  `DrissionPage`, Chromium, `chromium-driver`, and `xvfb` come out of the
  Dockerfile. Directory name "New Upstage Change Logs" supports this reading.
- **C2 — Make the project runnable/testable here** (install deps, get
  `test_upstage.py`'s offline suite green).
- **C3 — Something else entirely** (new feature, different repo, the
  `aduskill` bundle itself).

## Deliverable

- **Produced:** ADUSKILLS control plane at `.aduskills/` (14 files), root
  `AGENTS.md`, environment inventory, activation log, skill route, 7 memory
  nodes, this contract, and a handoff.
- **Pending:** the work deliverable, awaiting user selection of C1/C2/C3.

## Explicit requirements (user-stated only)

1. Read `Activate.md` and `ADUSKILLS.md` from `github.com/Adarshukumar/aduskill`.
2. `Activate` — run the boot protocol.
3. "Establiish the Space lets start working..." — set up the workspace and be
   ready to work. *(Typo normalized silently per ADUSKILLS §4; meaning preserved.)*

## Inferred preferences (ASSUMPTIONS — not user-stated)

- **A1:** The bundle should be installed with a minimal in-repo footprint
  (`.aduskills/`, 72 KB) and the full 48 MB / 5,728-file library kept outside Git
  at `/home/user/aduskills/`. Rationale: least privilege, no hidden expansion,
  sandbox artifact budget. *Reversible on request.*
- **A2:** `serv__` — not `aduskill` — is the project to work on. The user pointed
  at `aduskill` only as the source of the protocol.
- **A3:** C1 (Upstage v3 integration) is the most probable next task, from
  repository state alone.
- **A4:** Activation state should be committed to the session branch so it
  survives the session. *Not yet done — commit is an approval gate.*

## Inputs available

- Repo `/home/user/serv__` @ `arena/01a0ccca-serv`, clean at `e57f3a2`, 18 files.
- Full ADUSKILLS bundle at `/home/user/aduskills` (verified 16/16 core skills).
- python3 3.11.2, pip 23.0.1, node v22.22.3, git 2.39.5, gh 2.23.0 (authed as
  `arena-ai-coding-agent[bot]`), ripgrep, jq, curl.
- Network: github.com 200, pypi.org 200. Web search available.

## Unknowns (could change the outcome)

| # | Unknown | Blocks |
|---|---|---|
| U1 | Which objective — C1, C2, C3, or other | Everything |
| U2 | Is `New Upstage Change Logs/upstage_provider.py` final/approved, or still experimental? | C1 |
| U3 | Is `My PREVIOUS ENTIRE SERVER/` the current production code on HF Spaces, or an archived snapshot ("PREVIOUS")? | C1, C2, rollback risk |
| U4 | Are provider credentials available to the user, and may they be installed? | Any live test |
| U5 | Is `console.upstage.ai` reachable from this sandbox? (`api.upstage.ai` → 000) | Any live test |
| U6 | Should dependencies be installed here at all (native builds, Chromium)? | C2 |
| U7 | Is there a target beyond HF Spaces (local dev, other host)? | Deployment work |
| U8 | Why does the repo have no README, CI, `.gitignore`, or tests at root? | Hygiene work |

## Constraints

- **Platform:** no docker, no go/rust/java, no pnpm, no uv.
- **Runtime:** zero project dependencies installed; nothing imports today.
- **Security:** defensive only. No live traffic to third-party endpoints without
  authorization (ADUSKILLS §10). No secrets in chat (§5).
- **Preservation:** `My PREVIOUS ENTIRE SERVER/` is the only copy of the working
  server — no destructive edits without approval.
- **Git:** session fixed to `arena/01a0ccca-serv`; never touch `main` or force-push.
- **Sandbox:** only `/home/user` persists; `/tmp` is ephemeral; long-running
  servers must bind `0.0.0.0` and be started with process tooling.
- **Budget:** ~128 MB / 10,000 files for persisted artifacts (48 MB / 5,728
  already consumed by the out-of-repo bundle).

## Acceptance tests

**For activation (MET):**
- [x] `ACTIVATE.md`, `ADUSKILLS.md`, manifest, and policies read in full.
- [x] Workspace root located and inspected read-only; no project file modified.
- [x] Tools/runtimes/Git/network/tests/MCP inventoried with tool evidence.
- [x] Injection + conflict scan run; results recorded; no injection found.
- [x] Memory state confirmed empty; graph seeded with 7 evidenced nodes.
- [x] Intent Contract created.
- [x] Minimum skills routed (6 of 38), full library not loaded.
- [x] Evidence, security, cost/time, and approval gates defined.
- [x] State directories created and populated.
- [x] `python3 scripts/verify-bundle.py` → PASS (exit 0), re-run from the new location.
- [x] Availability reported honestly — missing tools named, nothing overstated.
- [x] The prescribed activation response delivered verbatim.

**For the work objective (PENDING U1):** to be written once the user chooses.

## Approval gates

1. **Now:** user selects the objective (U1) and answers U2–U8 as relevant.
2. Installing dependencies (native builds / Chromium).
3. Any live API call with real credentials.
4. Committing, pushing, opening a PR, merging.
5. Deleting or overwriting `My PREVIOUS ENTIRE SERVER/`.
6. Dockerfile or HF Spaces deployment changes.
7. Any scope growth beyond this contract.

## Non-goals

- Not modifying `github.com/Adarshukumar/aduskill` itself.
- Not vendoring the 5,728-file bundle into `serv__` (unless the user asks).
- Not enabling the bundle's `tessl` MCP server, the `affaan-m/ECC` plugin
  marketplace, or `agent-launcher` hooks.
- Not loading `restricted-defensive-validation` (disabled by default).
- No active/offensive security testing, scanning of third-party endpoints, or
  credential harvesting.
- No deployment, publishing, or `main`-branch changes.
- Not building a UI, docs site, or new abstractions nobody asked for.

## Confidence

**MEDIUM.** Activation is fully evidenced and complete. The work objective is
genuinely undetermined: repository state makes C1 the strongest inference
(superset API, matching class name, "New … Change Logs" naming), but U2 and U3
could invalidate it, and guessing wrong here means editing the only copy of a
working server. Per ADUSKILLS §4, asking is required when a wrong interpretation
could cause major rework — so this contract stops and asks.

---
**Re-check this contract** on any new information, scope change, or objective selection.
