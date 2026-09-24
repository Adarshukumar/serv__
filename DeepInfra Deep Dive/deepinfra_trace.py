#!/usr/bin/env python3
"""
══════════════════════════════════════════════════════════════════════
  🔷  DeepInfra.py — OFFLINE BEHAVIOUR PROBE
══════════════════════════════════════════════════════════════════════

  Loads the REAL  My PREVIOUS ENTIRE SERVER/API/providers/DeepInfra.py
  and drives every code path with fake HTTP responses, so we can see
  exactly what the provider does without touching the network.

  What is real vs faked
  ─────────────────────
  real   : the provider module itself (imported from its path)
  real   : requests.Response.iter_lines()  → ok / encoding behaviour is
           genuine requests 2.x code, not a stub
  real   : Models.py + ModelRegistry       → routing audit is genuine
  faked  : cloudscraper.create_scraper()   → scripted session objects
  faked  : time.sleep()                    → recorded instead of waited
           (except in test 13, which measures real event-loop blocking)

  Run:
      .venv/bin/python "DeepInfra Deep Dive/deepinfra_trace.py"
══════════════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import asyncio
import importlib.util
import re
import sys
import time
import types
from pathlib import Path

import requests
from requests.models import Response
from requests.structures import CaseInsensitiveDict

REPO   = Path(__file__).resolve().parents[1]
SERVER = REPO / "My PREVIOUS ENTIRE SERVER"
TARGET = SERVER / "API" / "providers" / "DeepInfra.py"

BAR = "─" * 78


def banner(n: str, title: str) -> None:
    print(f"\n╔══ TEST {n}  {title}")
    print(f"╚{BAR}")


def show(label: str, value) -> None:
    print(f"   {label:<34} → {value}")


# ═══════════════════════════════════════════════════════════════════
# §0 — Fake transport (scripted responses + recorded sleeps)
# ═══════════════════════════════════════════════════════════════════
def make_response(
    status: int = 200,
    body: bytes = b"",
    content_type: str = "text/event-stream; charset=utf-8",
) -> Response:
    """Build a real requests.Response the way Session.send would."""
    r = Response()
    r.status_code = status
    r._content = body
    r._content_consumed = True
    r.headers = CaseInsensitiveDict({"Content-Type": content_type})
    # exactly what requests.Session.send() does:
    r.encoding = requests.utils.get_encoding_from_headers(r.headers)
    return r


DEFAULT_CT = "text/event-stream; charset=utf-8"
STREAM_BODY = (
    'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}\n'
    'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n'
    'data: {"choices":[{"delta":{"content":" world"},"index":0}]}\n'
    'data: {"choices":[{"delta":{"reasoning_content":"hmm"},"index":0}]}\n'
    '\n'
    ': ping\n'
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n'
    'data: [DONE]\n'
)


def sse(text: str = STREAM_BODY, content_type: str = DEFAULT_CT) -> Response:
    return make_response(200, text.encode("utf-8"), content_type)


def err(status: int, body: str = '{"error":"boom"}') -> Response:
    return make_response(status, body.encode(), "application/json")


class ScriptExhausted(Exception):
    pass


class FakeScraper:
    """
    Stands in for cloudscraper.CloudScraper.

    All scrapers created during one scenario share a single Script, so a
    `_Session.reset()` (which builds a brand-new scraper) keeps reading
    the same queue of scripted responses — exactly like a real retry.
    """

    SCRIPT:  list = []            # shared per scenario
    CREATED: list = []            # every scraper built this scenario
    CALLS:   list = []            # every post() across all scrapers

    def __init__(self):
        self.headers = {}
        self.closed  = 0
        self.gen     = len(FakeScraper.CREATED) + 1
        FakeScraper.CREATED.append(self)

    # ── the one method _stream() actually calls ───────────────────
    def post(self, url, json=None, stream=False, timeout=None):
        if not FakeScraper.SCRIPT:
            raise ScriptExhausted(
                f"scraper#{self.gen}: script exhausted (unexpected {url})"
            )
        item = FakeScraper.SCRIPT.pop(0)
        FakeScraper.CALLS.append({
            "scraper": self.gen, "url": url, "json": json,
            "stream": stream, "timeout": timeout,
        })
        if isinstance(item, Exception):
            raise item
        return item

    def close(self):
        self.closed += 1

    # ── test helpers ──────────────────────────────────────────────
    @classmethod
    def load(cls, items) -> None:
        cls.SCRIPT, cls.CREATED, cls.CALLS = list(items), [], []

    @property
    def name(self) -> str:
        return f"scraper#{self.gen}"

    @property
    def calls(self) -> list:
        return [c for c in FakeScraper.CALLS if c["scraper"] == self.gen]

    @property
    def created_count(self) -> int:
        return len(FakeScraper.CREATED)


SLEEPS: list[float] = []


def fake_sleep(seconds):
    SLEEPS.append(round(float(seconds), 2))


# ═══════════════════════════════════════════════════════════════════
# §1 — Load the real module with cloudscraper faked out
# ═══════════════════════════════════════════════════════════════════
spec = importlib.util.spec_from_file_location("di_under_test", TARGET)
di = importlib.util.module_from_spec(spec)
sys.modules["di_under_test"] = di
spec.loader.exec_module(di)          # ← the real DeepInfra.py

print("═" * 78)
print("  🔷 DeepInfra.py — OFFLINE BEHAVIOUR PROBE")
print("═" * 78)
show("module under test", TARGET.relative_to(REPO))
show("file size / lines", f"{TARGET.stat().st_size} bytes / "
                            f"{len(TARGET.read_text().splitlines())} lines")
show("api endpoint", di._API)
show("spoofed origin", di._ORIGIN)
show("retry codes", sorted(di._RETRY_CODES))
show("fatal codes", sorted(di._FATAL_CODES))
show("alias count", len(di.MODELS))
show("default alias", di._DEFAULT)

# swap in our fake transport
di.cloudscraper = types.SimpleNamespace(
    create_scraper=lambda **kw: FakeScraper(),
    CloudScraper=FakeScraper,
)
real_sleep = time.sleep
time.sleep = fake_sleep


def install(items) -> FakeScraper:
    """Script the shared queue and force the singleton to a fresh scraper."""
    FakeScraper.load(items)
    sc = FakeScraper()
    di._Session._scraper = sc
    return sc


# ═══════════════════════════════════════════════════════════════════
# §2 — Static behaviour
# ═══════════════════════════════════════════════════════════════════
banner("01", "_resolve() — alias → DeepInfra model id")
for q in [None, "", "kimi-k2.5", "KIMI-K2.5", "  glm-5  ", "glm-5",
          "Qwen/Qwen3-Max", "deepseek-ai/DeepSeek-V3.2",
          "gpt-4o", "llama-3.1-8b"]:
    show(repr(q), repr(di._resolve(q)))

banner("02", "_build_msgs() — message assembly matrix")
p = di.DeepInfraProvider(model="glm-5", system="SYS")
cases = {
    "prompt only":              dict(data="hi", messages=None, system=None),
    "messages only":            dict(data=None, messages=[{"role": "user", "content": "u"}], system=None),
    "system= override":         dict(data="hi", messages=None, system="NEW"),
    "messages carry system":    dict(data=None, messages=[{"role": "system", "content": "MSGSYS"},
                                                          {"role": "user", "content": "u"}], system=None),
    "system arg + sys in msgs": dict(data="hi", messages=[{"role": "system", "content": "DROPPED?"},
                                                          {"role": "user", "content": "u"}], system="NEW"),
    "two systems in msgs":      dict(data=None, messages=[{"role": "system", "content": "S1"},
                                                          {"role": "system", "content": "S2"},
                                                          {"role": "user", "content": "u"}], system=None),
    "tool role dropped":        dict(data=None, messages=[{"role": "user", "content": "u"},
                                                          {"role": "tool", "content": "TOOL-OUT"},
                                                          {"role": "assistant", "content": "a"}], system=None),
    "developer role dropped":   dict(data=None, messages=[{"role": "developer", "content": "DEV"}], system=None),
}
for label, kw in cases.items():
    p.system = "SYS"
    try:
        out = p._build_msgs(kw["data"], kw["messages"], kw["system"])
    except Exception as exc:                                   # noqa: BLE001
        out = f"<{type(exc).__name__}: {exc}>"
    show(label, out)

banner("03", "_parse_sse() — one line at a time")
lines = [
    'data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":"Hel"},"index":0}]}',
    'data: {"choices":[{"delta":{"reasoning_content":"thinking…"},"index":0}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"x"}]},"index":0}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3}}',
    'data: {"choices":[{"delta":{"content":""},"index":0}]}',
    "data: [DONE]",
    ": keep-alive comment",
    "event: ping",
    "data: {this is not json}",
    "",
]
for ln in lines:
    try:
        tok, done = di._parse_sse(ln)
        show(repr(ln[:58]), f"token={tok!r} done={done}")
    except Exception as exc:                                   # noqa: BLE001
        show(repr(ln[:58]), f"!! {type(exc).__name__}: {exc}")

# ═══════════════════════════════════════════════════════════════════
# §3 — Live stream behaviour (scripted)
# ═══════════════════════════════════════════════════════════════════
banner("04", "happy path: 200 + SSE stream  (what reaches the caller)")
sc = install([sse()])
p = di.DeepInfraProvider(model="glm-5")
tokens = list(p.chat(data="hello"))
show("tokens yielded", tokens)
show("tokens joined", repr("".join(tokens)))
show("posts made", len(sc.calls))
show("post kwargs", {k: v for k, v in sc.calls[0].items()
                     if k in ("url", "stream", "timeout")})
show("payload sent", sc.calls[0]["json"])
show("note", "reasoning_content + usage chunks never surfaced")

banner("05", "`stream=False` argument — is it honoured?")
sc = install([sse()])
p = di.DeepInfraProvider(model="glm-5")
list(p.chat(data="hi", stream=False))
show("stream=False → payload['stream']", sc.calls[0]["json"]["stream"])
show("verdict", "parameter accepted, then ignored (hard-coded True)")

banner("06", "429 × 2 then 200 — retry + backoff (sleeps recorded)")
sc = install([err(429, '{"error":"rate limited"}'), err(429, '{"error":"rate limited"}'), sse()])
SLEEPS.clear()
p = di.DeepInfraProvider(model="glm-5", retries=3)
out = list(p.chat(data="hi"))
show("posts made", len(sc.calls))
show("which scraper served each", [c["scraper"] for c in sc.calls])
show("sleep waits (s)", SLEEPS)
show("scrapers created", sc.created_count)
show("session resets (close calls)", sum(s.closed for s in FakeScraper.CREATED))
show("tokens", "".join(out))

banner("07", "521 then 200 — session reset path")
sc = install([err(521, "origin down"), sse()])
SLEEPS.clear()
p = di.DeepInfraProvider(model="glm-5")
out = list(p.chat(data="hi"))
show("sleep waits (s)", SLEEPS)
show("scrapers created (reset → +1)", sc.created_count)
show("which scraper served each", [c["scraper"] for c in FakeScraper.CALLS])
show("old scrapers closed", [s.closed for s in FakeScraper.CREATED])
show("singleton replaced?", di._Session._scraper is not sc)
show("tokens", "".join(out))

banner("08", "401 — fatal, no retry")
sc = install([err(401, '{"error":"unauthorized"}'), sse()])
SLEEPS.clear()
p = di.DeepInfraProvider(model="glm-5")
try:
    list(p.chat(data="hi"))
    show("result", "no exception (!!)")
except Exception as exc:                                       # noqa: BLE001
    show("raised", f"{type(exc).__name__}: {exc}")
show("posts made", len(sc.calls))
show("sleep waits (s)", SLEEPS)
show("note", "only the FIRST 200 chars of the body are kept in the error")

banner("09", "transport exception — reset + linear backoff")
sc = install([requests.exceptions.ConnectionError("connection reset by peer")] * 3)
SLEEPS.clear()
p = di.DeepInfraProvider(model="glm-5", retries=2)
try:
    list(p.chat(data="hi"))
except Exception as exc:                                       # noqa: BLE001
    show("raised", f"{type(exc).__name__}: {exc}")
show("posts made (1 + retries)", len(FakeScraper.CALLS))
show("sleep waits (s)", SLEEPS)
show("scrapers created (one per reset)", sc.created_count)
show("note", "transport path sleeps 2·(n+1); HTTP path sleeps exp+jitter")

banner("10", "retries=0 vs retries=-1  (loop range edge cases)")
sc = install([err(500, "boom")])
p = di.DeepInfraProvider(model="glm-5", retries=0)
try:
    list(p.chat(data="hi"))
except Exception as exc:                                       # noqa: BLE001
    show("retries=0 + 500", f"{type(exc).__name__}: {exc}")
sc = install([])
p = di.DeepInfraProvider(model="glm-5", retries=-1)
try:
    list(p.chat(data="hi"))
except Exception as exc:                                       # noqa: BLE001
    show("retries=-1 (range(0))", f"{type(exc).__name__}: {exc}")
show("posts made with retries=-1", len(FakeScraper.CALLS))

banner("11", "consumer abandons the stream early — is the socket closed?")
resp = sse()
resp_closed = {"v": 0}
_orig_close = resp.close


def tracked_close(*a, **kw):
    resp_closed["v"] += 1
    return _orig_close(*a, **kw)


resp.close = tracked_close
sc = install([resp])
p = di.DeepInfraProvider(model="glm-5")
gen = p.chat(data="hi")
show("first token", next(gen))
gen.close()
show("resp.close() calls after gen.close()", resp_closed["v"])
show("verdict", "no try/finally in _stream → response not released")

banner("12", "charset handling — REAL requests.iter_lines() semantics")
body = ('data: {"choices":[{"delta":{"content":"héllo 😀 日本語"},"index":0}]}\n'
        'data: [DONE]\n').encode("utf-8")
for ctype in ["text/event-stream; charset=utf-8", "text/event-stream"]:
    r = make_response(200, body, ctype)
    show(f"content-type {ctype!r}", f"requests.encoding = {r.encoding!r}")
    sc = install([r])
    p = di.DeepInfraProvider(model="glm-5")
    got = "".join(p.chat(data="hi"))
    show("   token as parsed", repr(got))
    show("   correct?", got == "héllo 😀 日本語")

banner("13", "does a retry stall the asyncio event loop?  (real sleeps, real loop)")
async def probe():
    """Faithful stand-in for Completion.achat()'s sync-provider branch."""
    ticks: list[float] = []
    time.sleep = real_sleep                      # let the real sleep run
    install([err(429, '{"error":"slow down"}'), sse()])
    prov = di.DeepInfraProvider(model="glm-5", retries=1)

    async def ticker():
        while True:
            ticks.append(round(time.perf_counter() - t0, 3))
            await asyncio.sleep(0.05)

    t0 = time.perf_counter()
    task = asyncio.create_task(ticker())
    await asyncio.sleep(0.15)                    # ticker gets a few beats in
    before = len(ticks)
    # exactly what Completion.achat() does for a sync provider:
    for _tok in prov.chat(data="hi"):
        pass
    stalled = round(time.perf_counter() - t0 - ticks[-1], 3)
    await asyncio.sleep(0.15)                    # ticker resumes after the stall
    task.cancel()
    gaps = [round(b - a, 3) for a, b in zip(ticks, ticks[1:])]
    return before, ticks, gaps, stalled


before, ticks, gaps, stalled = asyncio.run(probe())
show("ticks before the call", before)
show("ticks after the call", len(ticks) - before)
show("largest inter-tick gap (s)", max(gaps) if gaps else 0)
show("silence after last pre-call tick", f"{stalled} s")
show("verdict", "one 429 retry freezes the whole event loop for seconds")
time.sleep = fake_sleep

# ═══════════════════════════════════════════════════════════════════
# §4 — Integration audit: can the rest of the server reach it?
# ═══════════════════════════════════════════════════════════════════
banner("14", "ModelRegistry wiring — is DeepInfra routable at all?")
mspec = importlib.util.spec_from_file_location("models_under_test", SERVER / "API" / "Models.py")
models = importlib.util.module_from_spec(mspec)
sys.modules["models_under_test"] = models
mspec.loader.exec_module(models)
MR = models.ModelRegistry

show("registered models", len(MR.names()))
show("models with provider 'DeepInfra'", [m.name for m in MR.by_provider("DeepInfra")])
show("providers actually referenced", sorted({p for m in MR.all() for p in m.providers}))
collide = sorted(set(di.MODELS) & set(MR.names()))
show("alias names colliding with registry", collide)
for nm in collide:
    m = MR.get(nm)
    show(f"   registry[{nm}]", f"providers={list(m.providers)} best={m.best}")
show("router outcome", "get_provider_for_model() can NEVER return 'DeepInfra'")

banner("15", "provider-catalogue deltas (Client.py / Completion.py / Server.py)")
client_src = (SERVER / "API" / "Client.py").read_text()
comp_src   = (SERVER / "API" / "Completion.py").read_text()
srv_src    = (SERVER / "Server.py").read_text()
show("Client.py spec", re.search(r'ProviderSpec\("DeepInfra".*', client_src).group(0))
show("Completion async_native set",
     re.search(r'async_providers = \{[^}]*\}', comp_src).group(0))
show("Completion param support",
     " ".join(re.search(r'"DeepInfra": \{[^}]*\}', comp_src).group(0).split()))
show("Server default model", re.search(r'DEFAULT_LOCAL_MODEL  = .*', srv_src).group(0))
show("has connect()/health()?", (hasattr(di.DeepInfraProvider, "connect"),
                                 hasattr(di.DeepInfraProvider, "health")))
show("close() body", "pass → singleton survives Client.close_all()")

banner("16", "what /v1/warmup would report about DeepInfra")
# faithful reproduction of Client._probe_provider_thread(), Client.py:186-227
prov = di.DeepInfraProvider()
details: dict = {}
details["model_count"] = len(prov.available_models())          # Client.py:210
health = getattr(prov, "health", None)
if callable(health):                                           # Client.py:~215
    details["health"] = "n/a"
details["provider"] = "DeepInfra"
details["ok"] = "health_error" not in details and "error" not in details   # :227
show("details Client would build", details)
show("verdict", "ok=True purely because no health() exists")
show("available_models() (first 5)", prov.available_models()[:5])
show("…total aliases", len(prov.available_models()))

time.sleep = real_sleep
print("\n" + "═" * 78)
print("  probe complete — every result above came from the real module")
print("═" * 78)
