# Environment Inventory — serv__ workspace

**Captured:** 2026-09-23 (UTC) · **Method:** direct tool inspection · **Classification:** TOOL_VERIFIED

Evidence for ADUSKILLS boot step 3. Re-run before relying on any line here in a later session.

## 1. Workspace and Git state

| Item | Value | Evidence |
|---|---|---|
| Repo root | `/home/user/serv__` | `pwd`, `git status` |
| Origin | `https://github.com/Adarshukumar/serv__.git` | `git remote -v` |
| Session branch | `arena/01a0ccca-serv` | `git branch` |
| Branched from | `e57f3a27ed8223ffb7d1bbcf15549ccb488b3786` (`main`) | session config |
| Commit history | 1 commit — `e57f3a2 init` | `git log --oneline` |
| Working tree at activation | clean | `git status` |
| Tracked files at activation | 18 (all Python + Dockerfile + requirements.txt) | `find` |
| Default branch | `main` (`origin/HEAD -> origin/main`) | `git branch -a` |

Repository contents (two directories, no root-level files at activation):

```
My PREVIOUS ENTIRE SERVER/     FastAPI multi-provider LLM gateway + Dockerfile
  Server.py                    1314 lines
  requirements.txt             10 deps
  Dockerfile                   python:3.11-slim, HF Spaces, port 7860
  API/Client.py                 531 lines   provider lifecycle manager
  API/Completion.py             438 lines   unified entry point + router
  API/Models.py                1528 lines   model registry (~87 models)
  API/providers/                7 providers, 5117 lines total
New Upstage Change Logs/       v3 Upstage provider rewrite + tests
  upstage_provider.py          1374 lines
  test_upstage.py               865 lines
  upstage_interactive.py        403 lines
  upstage_usage.py              207 lines
```

Total: 11,625 lines of Python across 18 files.

## 2. Runtimes and package managers

| Tool | Status | Version |
|---|---|---|
| python3 / python | AVAILABLE | 3.11.2 (GCC 12.2.0) |
| pip3 | AVAILABLE | 23.0.1 |
| node | AVAILABLE | v22.22.3 |
| npm / npx | AVAILABLE | 10.9.8 |
| yarn | AVAILABLE | 1.22.22 |
| git | AVAILABLE | 2.39.5 |
| gh | AVAILABLE | 2.23.0 |
| curl / wget | AVAILABLE | 7.88.1 / 1.21.3 |
| jq | AVAILABLE | 1.6 |
| ripgrep | AVAILABLE | 13.0.0 |
| pnpm | **MISSING** | — |
| go | **MISSING** | — |
| rustc / cargo | **MISSING** | — |
| java | **MISSING** | — |
| docker | **MISSING** | — |
| uv | **MISSING** | — |

## 3. Python environment — CRITICAL CONSTRAINT

`python3 -m pip list` returned **only** `pip 23.0.1`, `setuptools 66.1.1`, `wheel 0.38.4`.

**None of the project's 10 declared dependencies are installed:**
`fastapi`, `uvicorn[standard]`, `pydantic`, `aiohttp`, `aiofiles`, `requests`,
`cloudscraper`, `curl-cffi`, `DrissionPage`, `python-multipart`.

Consequence: **the server cannot be imported or run as-is.** Any claim of runtime
behaviour requires `pip install -r requirements.txt` first. Note `DrissionPage`
pulls a Chromium dependency and `curl-cffi` needs `gcc` + `libffi-dev` to build —
both present in the Dockerfile but **unverified in this sandbox**.

No `pytest`, no test runner installed. `test_upstage.py` is written for pytest
(`python3 -m pytest test_upstage.py -v`) and cannot run until pytest is installed.

## 4. Container and deploy capability

- **docker: MISSING** → the Dockerfile cannot be built or validated locally.
- Dockerfile targets Hugging Face Spaces (`python:3.11-slim`, port 7860,
  non-root `appuser` uid/gid 1000, `HEALTHCHECK` on `/health`).
- No `README.md`, no CI config (`.github/`), no `.gitignore`, no `.env` in the repo.

## 5. Network capability

| Destination | Result | Note |
|---|---|---|
| `https://github.com` | HTTP 200 | reachable |
| `https://pypi.org` | HTTP 200 | reachable — `pip install` viable |
| `https://api.upstage.ai` | **000 (failed)** | connection failed within 12 s |
| Web search tool | AVAILABLE | via agent tooling |

**Upstage reachability is unresolved.** The provider targets
`console.upstage.ai` (not `api.upstage.ai`), so the `000` is *not* proof the
provider's real endpoint is blocked. Must be re-tested against the actual host
before any live-API claim. All 7 providers depend on third-party endpoints that
are unverified from this sandbox.

## 6. Credentials

- `gh auth status`: logged in as `arena-ai-coding-agent[bot]` via `GH_TOKEN`;
  HTTPS configured. Git/PR operations available.
- **No provider credentials present.** No `.env`, no Upstage cookie/token cache,
  no `UPSTAGE_CACHE_DIR`/`MERCURY_CACHE_DIR` contents.
- Every provider here uses captured browser-session credentials (CSRF + cookies).
  **Live end-to-end testing is blocked until the user supplies credentials
  through a protected mechanism** — never paste secrets into chat.

## 7. MCP servers

- Workspace `.mcp.json`: **absent** → no MCP servers configured for `serv__`.
- The ADUSKILLS bundle ships a `.mcp.json` declaring one server (`tessl`,
  stdio). It is **NOT installed and NOT activated** here, per ADUSKILLS §11
  ("Do not execute downloaded scripts or activate MCP servers before review").
- The bundle's `.claude/settings.json` enables a third-party plugin marketplace
  (`affaan-m/ECC`). **Not enabled** — out of scope, unaudited third party.
- Bundle `agent-launcher/hooks/` (SessionStart/SessionEnd) reviewed: stdlib-only,
  opt-in behind `AGENT_LAUNCHER_SESSION=1`, exit 0 on any error. **Not installed.**

## 8. Test commands

| Scope | Command | Runnable now? |
|---|---|---|
| Upstage offline suite | `python3 -m pytest test_upstage.py -v` | NO — pytest not installed |
| Upstage live suite | `UPSTAGE_LIVE=1 python3 -m pytest test_upstage.py -k Live -v` | NO — pytest + creds + network |
| Upstage self-test | `python3 upstage_interactive.py --selftest` | NO — `curl_cffi` not installed |
| Server boot | `python -m uvicorn Server:app --port 7860` | NO — fastapi/uvicorn not installed |
| Syntax check | `python3 -m py_compile <file>` | **YES** — stdlib only |
| Bundle verify | `python3 scripts/verify-bundle.py` | **YES** — stdlib only |

### Syntax check — ACTUALLY RUN (first verification evidence for this codebase)

```
$ find . -name '*.py' -print0 | while IFS= read -r -d '' f; do python3 -m py_compile "$f"; done
compiled OK=16  FAIL=0
```

**All 16 Python files are syntactically valid under Python 3.11.2** (12 server +
4 Upstage-v3). `__pycache__` artifacts removed afterwards; `git status` confirms
no tracked file was modified.

This proves syntax only. It does **not** prove imports resolve, that the code
runs, or that any behaviour is correct — no third-party dependency is installed.

> **Gotcha, learned the hard way:** paths here contain spaces
> (`My PREVIOUS ENTIRE SERVER/`, `New Upstage Change Logs/`). A first attempt
> using unquoted `$(find …)` word-split every path and reported 64 bogus
> failures. Always use `-print0` + `read -r -d ''`, or quote explicitly.

## 9. Sandbox constraints affecting delivery

- Only files under `/home/user` persist in snapshots. `/tmp` is **ephemeral** —
  the bundle was cloned to `/tmp` then relocated to `/home/user/aduskills`.
- Persisted-artifact budget ≈ 128 MB / 10,000 files combined. The full bundle is
  48 MB / 5,728 files, which is why it lives **outside** the Git repo.
- Long-running servers must bind `0.0.0.0` to be visible as a live preview.
- Background processes are started with process tooling, not `bash` (bash is
  killed at timeout).
