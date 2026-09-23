# Skill Route — minimum relevant set

**Revision 2** (supersedes the activation-time route). Re-routed after the user
locked a concrete objective and added an explicit constraint:

> *"Focus on Desigbning and arttecture.. not securtity here..."*

Security skills are therefore **de-routed by user instruction**, not by
oversight. They are listed under §Deferred with the reason recorded, so the
exclusion is deliberate and reversible rather than silently dropped.

ADUSKILLS §3.5: *route only to relevant skills; avoid loading the whole library
into context.* 38 skills installed; **7 routed**. Resolve from
`/home/user/aduskills/.agents/skills/<skill>/SKILL.md`.

## Routed now

| Skill | Why routed | Status |
|---|---|---|
| `intent-lock` | Normalise a heavily typo'd, multi-part objective into a locked contract | USED — IC rewritten as `IC-20260923-react-migration` |
| `contract-first-clean-arch` | The whole task is a service/API boundary redesign: 7 providers behind one interface | USED — drove the `StreamEvent` abstraction and the bridge/SPA split |
| `source-driven-development` | Every architectural claim had to come from the Python source or an authoritative spec, not memory | USED — all endpoints, headers, payloads, wire formats read from source; forbidden-header rule sourced from MDN + W3C |
| `doubt-driven-development` | Needed to challenge my own conclusions | USED — **caught a false finding (I-4)** I had already written up as confirmed |
| `evidence-gate` | Nothing here could be claimed "working" without fresh tool output | USED — 60 tests, typecheck, build, live curl probes |
| `memory-graph` | Preserve the provider analysis and the retraction across sessions | USED |
| `wrap-up` | Persist handoff at close | pending |

Not routed but consulted directly: `answer-verifier` discipline was applied
manually during the evidence gate rather than loaded as a skill, to avoid
context bloat on a task already carrying 11,625 lines of source analysis.

## Explicitly deferred — BY USER INSTRUCTION

> "not securtity here"

| Skill | Why it would normally route | Deferred because |
|---|---|---|
| `secure-code-review` | 11,625 LOC handling captured session cookies and CSRF tokens | User scoped it out |
| `api-security`, `owasp-top-10-web` | New HTTP surface on the bridge | User scoped it out |
| `threat-modeling` | Spoofed `Origin`/`Referer`, replayed credentials | User scoped it out |
| `secrets-management` | `UPSTAGE_COOKIE`, `MERCURY_TOKEN` now flow through env vars | User scoped it out |
| `dependency-scanning`, `container-security` | npm supply chain; Dockerfile being retired | User scoped it out |
| `prompt-injection-defense` | Rendering untrusted model output | User scoped it out |

**Deferred ≠ ignored.** Two security-relevant facts surfaced during design work
and are recorded rather than acted on, because acting on them was out of scope:

1. `Inception.py:29` hardcodes a plaintext-HTTP upstream proxy
   `http://217.217.249.160:8080` used during Mercury credential capture. Its
   provenance is unknown and it would see captured session material in the
   clear. **The port disables it by default** (`bridge/headers.mjs` reads
   `MERCURY_PROXY` only if explicitly set) — a design decision, not a security
   review.
2. The bridge replays captured session cookies. `.gitignore` was added covering
   `.env*`, `*.key`, `*.pem`, `credentials.json` and the cache dirs, because the
   repo previously had **no** `.gitignore` at all.

Re-route these the moment security work is in scope.

## Not routed

- **`restricted-defensive-validation`** — installed but disabled by manifest
  default; requires a fresh per-run authorization gate. Not loaded.
- `repo-kickstart` — the repo already exists; scaffolding was targeted, not generated.
- `coordinate-implementation`, `pr-review` — single-agent task, no PR yet.
- `interview-me`, `take-ownership`, `solo-founder`, `hyperagent-eval-skill` —
  not requested; the user said "u can work by ur own", i.e. proceed, not escalate.
- Playwright / E2E browser skills — **unavailable in practice**: no browser and
  no docker in this sandbox, so a real-DOM E2E run is impossible. Substituted
  with an integration test that spawns the real bridge and drives the real
  browser-side modules in Node. Recorded as a limitation, not presented as
  equivalent coverage.
- The bundle's wider libraries (`finance/`, `marketing/`, `c-level-advisor/`,
  `business-*/`, `product-team/`, `ra-qm-team/`, `compliance-os/`) — unrelated.
  **Pruned from the local copy** to reclaim storage (48 MB → 5 MB).

## Path resolution

```
/home/user/aduskills/.agents/skills/<skill>/SKILL.md
```

The local bundle copy was pruned to the routed library + core docs + policies +
`scripts/`, with **all 14 `LICENSE*` files preserved** (ADUSKILLS §2.9). Both
verifiers still pass after pruning. Re-fetch from
`https://github.com/Adarshukumar/aduskill` if anything is missing; re-run
`python3 scripts/verify-bundle.py` afterwards.
