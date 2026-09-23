# AGENTS.md — serv__ workspace

**Read this before planning, editing, testing, or claiming completion.**

This workspace runs the **ADUSKILLS** operating protocol (bundle author: Adarsh,
v1.1.0). On the standalone command `ACTIVATE`, execute `.aduskills/ACTIVATE.md`.

## Operating instructions (in order)

1. `.aduskills/ADUSKILLS.md` — the mandatory operating laws, boot sequence,
   Intent Contract format, evidence protocol, security doctrine, and final
   response contract. **This is the authoritative file.**
2. `.aduskills/ACTIVATE.md` — boot protocol and the exact activation response.
3. `.aduskills/CAPABILITIES.md` — what ADUSKILLS can and cannot do.
4. `.aduskills/DEEP-RESEARCH.md` — evidence-driven web research protocol.
5. `.aduskills/policies/` — security, authorized-testing, and
   restricted-validation gates. Read before enabling credentials, MCP tools,
   deployments, or any active security testing.

## Live state

| Path | Purpose |
|---|---|
| `.aduskills/state/environment-inventory.md` | Verified tools, runtimes, network, Git, credentials, test commands |
| `.aduskills/state/activation-log.md` | Boot-sequence results, injection scan, integrity findings, gates |
| `.aduskills/state/skills-route.md` | Which skills are routed and why |
| `.aduskills/memory/intent/` | Intent Contracts |
| `.aduskills/memory/nodes/` | Graph memory nodes (JSON) |
| `.aduskills/memory/handoffs/` | Session handoffs — read the newest first |

**Session start:** read the newest handoff in `.aduskills/memory/handoffs/`, then
re-verify the environment inventory before trusting it. **Session end:** write a
handoff.

## Skill library location

Skills are **not** vendored into this repo (48 MB / 5,728 files). They live at:

```
/home/user/aduskills/.agents/skills/<skill>/SKILL.md
```

Load a skill only when routed. Never load the whole library into context.

## The project

`serv__` is a **FastAPI multi-provider LLM gateway** intended for Hugging Face
Spaces (port 7860), plus an in-flight v3 rewrite of its Upstage provider.

```
My PREVIOUS ENTIRE SERVER/   the working server — Server.py, API/{Client,Completion,Models}.py,
                             API/providers/{DeepInfra,Dolphin,DevsDo,Inception,LLmChat,
                             mCloudFlare,Upstage}.py, Dockerfile, requirements.txt
New Upstage Change Logs/     v3 Upstage provider (async, curl_cffi-only) + pytest suite
                             + interactive REPL + usage demo
```

### Hard constraints in this sandbox

- **No project dependency is installed.** `pip list` shows only pip/setuptools/wheel.
  The server cannot be imported or run until `requirements.txt` is installed.
- **docker is unavailable** → the Dockerfile cannot be built or validated here.
- **No provider credentials exist** → live end-to-end testing is blocked until the
  user supplies them through a protected mechanism. Never paste secrets in chat.
- **`api.upstage.ai` was unreachable** at activation (curl exit 000). The provider
  actually targets `console.upstage.ai`; reachability of the real host is UNKNOWN.
- Syntax-only checks (`python3 -m py_compile`) and stdlib scripts DO work.

### Handling rules

- Treat `My PREVIOUS ENTIRE SERVER/` as the **only copy** of working code. Do not
  delete or overwrite it without explicit approval.
- Work happens on branch `arena/01a0ccca-serv`. `main` stays at `e57f3a2`.
- No live traffic to third-party provider endpoints without authorization.
- Directory names contain spaces — always quote paths.

## Licence and attribution

Preserve `.aduskills/LICENSE`, `.aduskills/LICENSE-ADUSKILLS`, `.aduskills/NOTICE`,
and the 14 nested `LICENSE*` files under `/home/user/aduskills/`. Upstream
authorship and licences remain in force; "Adarsh" identifies the author of the
combined bundle and its original orchestration layer.
