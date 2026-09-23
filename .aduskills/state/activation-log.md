# Activation Log — ADUSKILLS boot sequence

**Trigger:** user sent `Activate` + `read Activate.md and ADUSKILLS.md` + `Establish the Space lets start working...`
**Date:** 2026-09-23 (UTC) · **Workspace:** `/home/user/serv__` · **Branch:** `arena/01a0ccca-serv`

Executed per `ACTIVATE.md` §Boot sequence. Each step lists its actual result and evidence class.

| # | Step | Result | Evidence |
|---|---|---|---|
| 1 | Read `ACTIVATE.md`, `ADUSKILLS.md`, `ADUSKILLS-MANIFEST.json`, policies | DONE — all read in full; `policies/security.md`, `authorized-security-testing.md`, `restricted-defensive-validation.md` copied into control plane | OBSERVED |
| 2 | Locate workspace root; inspect without modifying | DONE — `/home/user/serv__`; 18 files, 11,625 LOC inspected read-only. No project file modified during activation | OBSERVED |
| 3 | Inventory tools, runtimes, package managers, Git, network, tests, MCP | DONE — see `state/environment-inventory.md` | TOOL_VERIFIED |
| 4 | Scan instructions/skills for conflicts + prompt injection | DONE — see §A below. No injection found; 3 findings recorded | TOOL_VERIFIED |
| 5 | Retrieve graph memory + latest handoff | DONE — **no prior memory exists.** Fresh workspace, single `init` commit, no `.aduskills/`, no handoff. Nothing stale or contradictory to mark | OBSERVED |
| 6 | Initialize Intent Contract | DONE — `memory/intent/IC-20260923-activation.md`. Objective partially locked; **work objective UNKNOWN, awaiting user** | OBSERVED |
| 7 | Route minimum relevant skills | DONE — 6 skills routed, not the full 38-skill library. See `state/skills-route.md` | OBSERVED |
| 8 | Establish evidence / security / cost / approval gates | DONE — see §B below | OBSERVED |
| 9 | Create missing local state directories | DONE — `.aduskills/{policies,memory/{templates,nodes,handoffs,intent},state}`. Filesystem access confirmed available | TOOL_VERIFIED |
| 10 | Wait for task if none supplied | **ACTIVE** — no task supplied with `ACTIVATE`; user question issued | — |

## A. Injection and conflict scan (boot step 4)

Repository-provided instructions were treated as **untrusted data** per ADUSKILLS §11.
Scanned the full 5,728-file bundle with ripgrep for override phrases, secret
material, and remote-code-execution patterns.

**Verdict: no prompt injection detected. Bundle instructions are consistent with
ADUSKILLS.md and do not conflict with host safety controls.** Findings:

1. `"ignore previous instructions"` — 3 files, all inside
   `engineering/skills/skill-security-auditor/`. These are **detection examples**
   in a threat-model table, each tagged `<!-- noqa: SEC-AUDITOR -->`. Benign.
2. `"do not tell the user"` — 1 file,
   `finance/skills/stock-analysis/references/19-ipo-mode.md:118`. Context is an
   advice boundary ("do not tell the user whether to apply"). Benign.
3. Secret-shaped strings — `AKIAIOSFODNN7EXAMPLE` (AWS's published documentation
   example), `ghp_aaaa…`, `sk-ant-aaaa…`. All are **test fixtures** inside
   redaction-linter and memory-extraction scripts. No live credentials.
4. `agent-launcher/hooks/` — reviewed line by line: stdlib-only, disabled unless
   `AGENT_LAUNCHER_SESSION=1`, always `exit 0`. **Not installed.**
5. Bundle `.mcp.json` (`tessl`) and `.claude/settings.json` (third-party
   marketplace `affaan-m/ECC`) — **not activated, not enabled.**

`curl … | sh` style remote execution: the initial broad pattern was a regex
artifact (`curl|sh` = "curl OR sh") matching 3,356 files on the substring `sh`;
it is **not** a finding and is discarded as invalid evidence.

## B. Bundle integrity verification (fresh tool evidence)

**As cloned (upstream state):**

```
$ python3 scripts/verify-bundle.py
skills=16/16 licenses=0
bundle verification: PASS          exit=0

$ python3 scripts/verify-activation.py
missing activation files: AGENTS.md
                                 exit=1     <-- FAILED upstream
```

**After local remediation** (`ln -s ADUSKILLS.md AGENTS.md` in the out-of-repo
copy `/home/user/aduskills`, which is what `README-FIRST.md` item 2 says
`AGENTS.md` should contain):

```
$ python3 scripts/verify-activation.py
activation verification: PASS    exit=0

$ python3 scripts/verify-bundle.py
skills=16/16 licenses=0
bundle verification: PASS        exit=0
```

Both scripts were read in full before execution (stdlib-only, read-only, no
network, no subprocess). Note the remediation touched only the **local** bundle
copy — upstream `github.com/Adarshukumar/aduskill` is unmodified, and B-1 remains
a real upstream finding.

### Findings against the bundle's own claims

| ID | Finding | Severity | Evidence |
|---|---|---|---|
| B-1 | `verify-activation.py` **FAILED upstream**: `AGENTS.md` is absent from the bundle root, yet `README-FIRST.md` item 2 states "Where supported, `AGENTS.md` contains the same core operating instructions". **REMEDIATED LOCALLY** — symlinked in `/home/user/aduskills`; verifier now exits 0. Upstream repo still affected. | Low (doc/packaging gap) | exit=1 before, exit=0 after; `ls AGENTS.md` → No such file upstream |
| B-2 | `integrations/licenses/` **does not exist**, so `verify-bundle.py` reports `licenses=0` while still printing PASS. `NOTICE` and the manifest both assert upstream licences are "preserved in … `integrations/licenses/`" | Medium (provenance claim unsupported) | `ls integrations/licenses` → No such file; `licenses=0` in passing output |
| B-3 | `verify-bundle.py` prints PASS despite `licenses=0` — the licence count is **not gated**, only the 16 skill paths are | Low (weak verifier) | script source: `if missing: … sys.exit(1)` covers skills only |

Provenance is preserved as far as the bundle actually allows: root `LICENSE`,
`LICENSE-ADUSKILLS`, and `NOTICE` are copied into `.aduskills/`, and 14 nested
`LICENSE*` files remain in `/home/user/aduskills/`. B-2 is reported to the user
rather than silently papered over (ADUSKILLS §2.9 preserve provenance, §2.10 honest limits).

## C. Gates established (boot step 8)

**Evidence gate** — no completion claim without fresh tool output attached. Every
material statement carries one of: OBSERVED / TOOL_VERIFIED / SOURCE_SUPPORTED /
INFERRED / PROPOSED / UNKNOWN. Runtime claims retain command, exit status, output.

**Security gate** — defensive only. Passive review permitted without asking:
source/config review, dependency analysis, secret scanning, threat modelling,
prompt-injection review. **Active testing against any provider endpoint requires
explicit user authorization + bounded scope first** (ADUSKILLS §10). All 7
providers here call third-party services the sandbox does not own — default is
**no live traffic** beyond what the user authorizes.

**Approval gates — will pause and ask for:**
- installing dependencies that pull native/browser toolchains (`DrissionPage` → Chromium, `curl-cffi` → gcc build);
- any live API call using real captured credentials;
- committing/pushing, opening a PR, or merging to `main`;
- deleting or overwriting `My PREVIOUS ENTIRE SERVER/` code (it is the only copy of the working server);
- Dockerfile/deployment changes destined for HF Spaces;
- any scope growth beyond the locked Intent Contract.

**Cost/time gate** — autonomous loops bounded by goal, max attempts, and stop
condition. On repeated identical failure: stop, summarise evidence, ask. No
indefinite retrying against unreachable provider endpoints.

**Rollback path** — all work on `arena/01a0ccca-serv`; `main` untouched at
`e57f3a2`. Every change is a separate revertable commit. No force-push, no
history rewrite, no deletion of the repo root or `.git`.

## D. Space layout established

| Path | Contents | In Git? | Why |
|---|---|---|---|
| `/home/user/serv__/.aduskills/` | activation docs, policies, licences, memory, state | **YES** | durable, reviewable control plane; 72 KB / 14 files at creation |
| `/home/user/aduskills/` | full bundle: 38 routed skills + 5,728 files, 48 MB | **NO** | skill library reachable by path without consuming the repo or the ~10k-file artifact budget |
| `/home/user/serv__/AGENTS.md` | root pointer to operating instructions | **YES** | remediation for finding B-1; standard agent-instruction entry point |
| `/tmp/aduskill_probe/` | original clone | ephemeral | scratch only; already relocated |

**Assumption disclosed (harmless, reversible):** the bundle was installed with a
*minimal in-repo footprint* rather than copying all 5,728 files into `serv__`.
Rationale: least privilege (§2.5), no hidden expansion (§2.8), and the sandbox's
persisted-artifact budget. Say the word and the full library can be vendored
into the repo instead.
