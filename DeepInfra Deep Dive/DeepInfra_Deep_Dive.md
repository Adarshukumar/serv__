# 🔷 DeepInfra.py — Full Dependency-Aware Deep Dive

> **File under study** — `My PREVIOUS ENTIRE SERVER/API/providers/DeepInfra.py`
> 14,988 bytes · 360 lines · last section `§5 — PROVIDER`
> **Method** — static read of the whole file **+ every value below re-verified by running the real module**
> through an offline probe (`deepinfra_trace.py`, 16 tests, raw output in `trace_output.txt`).
> **Nothing here is guessed** — where something *couldn't* be tested, it says so explicitly.

---

## 0. TL;DR

```
DeepInfra.py is a SYNC, single-file provider that:
  • posts an OpenAI-shaped JSON body to api.deepinfra.com
  • pretends to be the g4f.dev web app (Origin/Referer/UA spoof, NO Authorization header)
  • streams the SSE answer back through cloudscraper (Cloudflare-bypassing requests)
  • retries 429/5xx with exponential backoff, kills 4xx instantly
  • keeps ONE cloudscraper session for the whole process (singleton)

It is wired into the project as a provider (providers/__init__ → Client → Completion)
…but no model in Models.py references it, so the router can never choose it.
It is reachable ONLY by instantiating DeepInfraProvider directly.
```

Severity-ordered problems found by probe (details in §7): **no auth header (probably 401 fatal)**, dead `stream=False` param, `retries=-1` crashes with `UnboundLocalError`, response objects leak on early exit, retries block the asyncio loop for seconds, `reasoning_content` silently discarded, non-UTF-8 charset header mangles emoji/CJK.

---

## 1. Where this file sits in the dependency graph

```
                        Server.py  (FastAPI :7860)
                             │  /v1/chat  /v1/chat/completions  /v1/warmup  /v1/models
                             ▼
                     Server.ChatService            (Server.py:661)
                             │  sessions, semaphore, sessions lock
                             ▼
                     Server.LocalBackend            (Server.py:386)
                             │  _resolve_model → _resolve_provider = ModelRegistry.get(m).best
                             ▼
                     API/Completion.py              Completion.achat() / chat_sync()
                             │  _Router.get_provider_for_model(model, override)
                             │  _Params.build(...)  ← only passes what each provider supports
                             ▼
                     API/Client.py                  Client.get_provider[_async]()
                             │  ProviderSpec table (Client.py:30-38)
        ┌────────────────────┼────────────────────┬─────────────┬──────────────┐
        ▼                    ▼                    ▼             ▼              ▼
   DeepInfra            Dolphin              DevsDo        LLMChat        Mercury / Upstage
  async_native=False   async_native=True   async_native   async_native   async_native
  (sync generator)     (aiohttp)          (async)        (curl_cffi)    (heavy_connect)
        │
        └── API/providers/__init__.py:5  →  from .DeepInfra import DeepInfraProvider
```

**Two hard facts from `Models.py` (verified by import, test 14):**

| fact | value |
|---|---|
| models registered in `ModelRegistry` | **64** |
| models whose `providers` contains `"DeepInfra"` | **0** (empty list) |
| providers actually referenced by the registry | `DevsDo, Dolphin, LLMChat, Mercury, Upstage, mCloudFlare` |
| name collisions between DeepInfra's own aliases and the registry | `kimi-k2.5` → *DevsDo/LLMChat*, `glm-4.7-flash` → *DevsDo/LLMChat* |

So `_Router.get_provider_for_model()` **can never return `"DeepInfra"`** — not for `kimi-k2.5`, not even when `Server.LocalBackend._resolve_provider()` hands it the override, because the override is rejected (`Completion.py:57-76`) and it falls back to `model.best`. DeepInfra is loaded by `Client`, kept warm by the audit, and never used by a single request unless you call it yourself.

**The three "awareness" deltas that make this a *dead-but-warm* provider:**

| layer | says | meaning |
|---|---|---|
| `Client.py:31` | `ProviderSpec("DeepInfra", DeepInfraProvider, async_native=False)` | it gets *loaded* in heavy boot, and is *excluded* from the async set → `Completion.chat_sync` calls it inline |
| `Completion.py:92` | `"DeepInfra": {data, messages, model, system, temperature, max_tokens}` | params whitelist — `stream`, `thinking`, `search`, `attachment` are silently stripped before reaching it |
| `Completion.py:364 / 427` | `async_providers = {"Dolphin","DevsDo","Mercury","LLMChat","Upstage"}` | DeepInfra is **not** in it → `achat()` iterates the blocking generator *inside the event loop* (`Completion.py:434-438`) |
| `Models.py` (all 64 entries) | — | no `providers=("DeepInfra",)` anywhere → unreachable via router |

---

## 2. Section-by-section walkthrough

### §1 — CONSTANTS (lines 30-56)

```python
_API    = "https://api.deepinfra.com/v1/openai/chat/completions"   # :33
_ORIGIN = "https://g4f.dev"                                        # :34
_BASE_HEADERS = {...}                                              # :36-53
_RETRY_CODES = {429, 500, 502, 503, 504, 520..524}                 # :55
_FATAL_CODES = {400, 401, 403, 404, 405, 422}                      # :56
```

The header block is a **browser fingerprint**, not an API client:

* `Origin` / `Referer: https://g4f.dev` → the request claims to come from the **gpt4free web app**, whose public demo pages call DeepInfra from the browser.
* A full Chrome 145 UA, `sec-ch-ua*`, `Accept-Language`, `Accept-Encoding`…
* `"x-request-id": "Ry3LRoEwEsPHJxUrUrYpfCzm"` — **frozen constant**, identical on every request (a real request-id is per-request; this smells like a value copied out of one captured HAR).
* **There is no `Authorization` header anywhere in the file** — confirmed by the probe: the only kwargs sent to the transport are `json`, `stream`, `timeout`.

```python
post kwargs → {'url': '…/chat/completions', 'stream': True, 'timeout': 120}
```

Since `401` is in `_FATAL_CODES`, a keyless DeepInfra answer would be raised instantly as
`RuntimeError: Fatal error: HTTP 401: {...}` — see §8, this is the one thing the sandbox could not verify.

### §2 — MODEL REGISTRY (lines 59-107)

18 short aliases → DeepInfra `org/Model` ids: StepFun, 8× Qwen3.5, 2× NVIDIA Nemotron-3, 2× Z.ai GLM-5/4.7, MiniMax-M2.5, 2× Qwen3-Max(-Thinking), Kimi-K2.5, DeepSeek-V3.2. Default = `nemotron-3-nano-30b-a3b` → `nvidia/Nemotron-3-Nano-30B-A3B`.

`_resolve()` (:101) is a 5-liner with three behaviours (all verified in test 01):

| input | output | rule |
|---|---|---|
| `None` / `""` | `nvidia/Nemotron-3-Nano-30B-A3B` | falsy → default |
| `"KIMI-K2.5"`, `"  glm-5  "` | `moonshotai/Kimi-K2.5`, `zai-org/GLM-5` | lower + strip → alias lookup |
| `"Qwen/Qwen3-Max"` | unchanged | contains `/` → treated as full id and **passed through blindly** |
| `"gpt-4o"`, `"llama-3.1-8b"` | unchanged | unknown alias without `/` → also passed through → server-side 404 → *fatal*, no retry |

That last row is the trap: an unknown *short* name is not rejected locally, it is sent to DeepInfra and dies as `HTTP 404` (fatal class).

### §3 — SINGLETON SESSION (lines 110-138)

```python
class _Session:
    _scraper = None                                    # :114
    @classmethod
    def get(cls): ...cloudscraper.create_scraper(...)  # :117  browser=chrome/windows, desktop
    @classmethod
    def reset(cls): ...close + rebuild...              # :130
```

* One scraper for the whole process, built lazily on first `get()`, warmed in `DeepInfraProvider.__init__` (`_Session.get()` at :199 — that's the "instant startup" claim: no browser, no credentials).
* `cloudscraper.CloudScraper` subclasses `requests.Session`, so `headers.update(_BASE_HEADERS)` and `scraper.post(...)` keep requests semantics — the probe's fake only had to implement `post/close/headers`.
* `reset()` is called in exactly two places inside `_stream`: on **521** and on **any non-`RuntimeError` transport exception** (:262). Verified in tests 07/09: a reset closes the old scraper (`close()` count 1) and the *next* attempt runs on a brand-new object.
* **`DeepInfraProvider.close()` is `pass` (:350-351)** with the comment *"shared singleton session — don't close it"*. So `Client.close_all()` (which calls `close()` then `aclose()` if present — neither exists here) can never tear the session down; only `reset()` recycles it.

### §4 — SSE PARSER (lines 141-162)

`_parse_sse(line) -> (token, is_done)` accepts exactly this grammar (test 03):

| input line | result | note |
|---|---|---|
| `data: {"choices":[{"delta":{"role":"assistant"}}]}` | `("", False)` | role-only first chunk → nothing |
| `data: {"choices":[{"delta":{"content":"Hel"}}]}` | `("Hel", False)` | the happy path |
| `data: {"choices":[{"delta":{"reasoning_content":"…"}}]}` | `("", False)` | **thinking is thrown away** |
| `data: {"choices":[{"delta":{"tool_calls":[…]}}]}` | `("", False)` | tool calls thrown away |
| `data: {"choices":[],"usage":{…}}` | `("", False)` | usage ignored (even though the payload *asks* for it) |
| `data: [DONE]` | `("", True)` | stops the stream |
| `: keep-alive`, `event: ping`, `data: {not json}`, `""` | `("", False)` | swallowed by try/except |

Only `choices[0].delta.content` survives. Everything else the OpenAI SSE dialect carries is dropped silently — and this is the *only* place the module interprets the wire format.

### §5 — PROVIDER (lines 164-360)

**`__init__` (:182)** — `model, system="You are a helpful assistant.", temperature=0.7, max_tokens=8192, timeout=120, retries=3`; resolves the model and warms the session.

**`_build_msgs` (:202)** — matrix verified in test 02:

| case | result |
|---|---|
| `data` only | `[system, user]` |
| `messages` only | `[system, user]` (provider's system prepended) |
| `messages` contain a `system` **and** `system=` arg is `None` | that message becomes the system prompt |
| `system=` arg given **and** message list also has a system | **the message-list system is dropped** |
| two systems in `messages`, `system=None` | **last one wins** (`use_system` is overwritten) |
| role `tool` / `developer` | **message deleted entirely** — content lost |

Also note `use_system = system if system is not None else self.system`, then `if use_system:` — an empty-string system is cleanly omitted.

**`_stream` (:230)** — the engine. Shape:

```
for attempt in range(1 + retries):
    resp = scraper.post(_API, json=payload, stream=True, timeout=timeout)
    └─ 200 → break
    └─ _FATAL_CODES → raise RuntimeError("Fatal error: HTTP …")     (no retry)
    └─ _RETRY_CODES & attempts left → maybe _Session.reset() on 521
                                      sleep(min(2·2^attempt + U(0,1), 30))
    └─ anything else → raise RuntimeError("HTTP …")
  except RuntimeError: raise                      ← fatal/known errors escape instantly
  except Exception:  reset + sleep(2·(attempt+1)) ← transport errors retried
then: for raw_line in resp.iter_lines(decode_unicode=True): yield tokens
```

**`chat` (:283)** — validates `data or messages` immediately (this function is *not* a generator, it *returns* one, so `ValueError` fires at call time), resolves model/temp/tokens, builds payload, returns `self._stream(payload)`. The `stream: bool = True` parameter exists in the signature but **is never read**: the payload hard-codes `"stream": True` (test 05). It also always asks for `"stream_options": {"include_usage": True}` (test 04), whose usage chunk the parser then discards.

**Setters (:328-343)** chainable (`set_model/system/temperature/max_tokens`), `available_models()` returns the 18 aliases, `close()` no-op, context-manager `__enter__/__exit__` (sync only — no `__aenter__`, unlike `mCloudFlare`).

---

## 3. One request, step by step (measured)

```
di = DeepInfraProvider(model="glm-5")          → _resolve → "zai-org/GLM-5"; session warmed
gen = di.chat(data="hello")                    → ValueError check, payload built, NO I/O yet
next(gen)                                      → first network call happens here
   POST https://api.deepinfra.com/v1/openai/chat/completions  (stream=True, timeout=120)
     headers: Chrome UA + Origin/Referer g4f.dev + frozen x-request-id   (no Authorization)
     body:    {model, messages:[system,user], temperature:0.7,
               max_tokens:8192, stream:true, stream_options:{include_usage:true}}
   ← 200 text/event-stream → iter_lines(decode_unicode=True) → _parse_sse per line
     role delta → dropped │ "Hello" → yielded │ " world" → yielded
     reasoning delta → dropped │ usage chunk → dropped │ [DONE] → return
```

If the first call is not 200, the same flow becomes:

```
429 → sleep(min(2·2^n + rand, 30)) → retry         measured: 2.03 s, then 4.72 s
521 → close+rebuild scraper → retry                measured: 1 old scraper closed, 1 new created
500/502/503/504/520/522/523/524 → backoff → retry
400/401/403/404/405/422 → RuntimeError "Fatal error: HTTP nnn: <first 200 chars>"  (0 retries)
socket/SSL/DNS error → reset scraper → sleep 2·(n+1) → retry → finally "Connection failed: …"
```

---

## 4. Backoff mathematics (as implemented vs as measured)

| path | formula (`attempt` is 0-based) | measured with `retries=3` |
|---|---|---|
| HTTP retry code | `min(2.0 * 2**attempt + random.uniform(0, 1), 30)` | `[2.03, 4.72]` |
| transport exception | `2.0 * (attempt + 1)` (linear, no jitter) | `[2.0, 4.0]` with `retries=2` |

Both are **`time.sleep()` inside a synchronous generator** → they block whatever thread is iterating. Because `Completion.achat()` iterates sync providers *inline* (`Completion.py:434-438`) and `Server.LocalBackend.stream` consumes it with `async for` (`Server.py:566`), one retry stalls the **entire uvicorn event loop** — measured in test 13: a single 429 retry produced a **2.319 s window with zero loop progress** (ticker ticks before = 3, after = 3, max gap = 2.319 s).

---

## 5. What reaches the caller vs what is thrown away

| streamed by DeepInfra | reaches your code | why |
|---|---|---|
| `choices[0].delta.content` | ✅ | the happy path |
| `delta.reasoning_content` (Qwen3-Max-Thinking, DeepSeek…) | ❌ | `_parse_sse` never looks at it |
| `delta.tool_calls` | ❌ | not parsed |
| `usage` (requested via `stream_options`) | ❌ | `choices: []` → early return `("", False)` |
| first role-only delta | ❌ | no `content` key |
| SSE comments / `event:` lines | ❌ | ignored (harmless) |
| HTTP error detail | ⚠️ first 200 chars only | `resp.text[:200]` |
| non-ASCII text | ⚠️ only if the server sends `charset=utf-8` | see §7.6 |

---

## 6. Integration: how the server *would* use it (and why it doesn't)

Intended path (works for the other six providers):

```
POST /v1/chat → ChatService.run_stream → LocalBackend.stream
   → Completion.achat(model=…, provider=model.best, …)
   → _Router: provider_override in model.providers ? → _Params.build(whitelist) → Client.get_provider*
   → provider.chat(**params)  → tokens → Server's <think>…</think> parser (Server.py:597-634)
```

For DeepInfra three things break the chain:

1. **Routing** — no `Model` lists it, so the router never selects it (and rejects a manual override).
2. **Param stripping** — even if routed, `_Params.build` (Completion.py:92-96) sends only `data, messages, model, system, temperature, max_tokens`; nothing else can be asked of it.
3. **Delivery shape** — `Server.LocalBackend.stream` reconstructs *reasoning* from inline `<think>…</think>` tags in the content stream. DeepInfra emits reasoning as `reasoning_content`, which is dropped two layers lower — so even a Thinking model would arrive as plain answer text with the reasoning invisible, and `search`/`attachment`/`thinking` requests are meaningless to it.

Its only two real entry points today:

```python
# 1. direct
from providers import DeepInfraProvider
di = DeepInfraProvider(model="glm-5").set_temperature(0.3)
for tok in di.chat(data="hello"):  print(tok, end="", flush=True)

# 2. through Client (sync only — it is async_native=False)
client = get_client()
di = client.get_provider("DeepInfra")     # allowed, because it is not async_native
```

And note what `/v1/warmup` will tell you about it (test 16, faithful reproduction of `Client._probe_provider_thread`, Client.py:186-227):

```python
details → {'model_count': 18, 'provider': 'DeepInfra', 'ok': True}
```

`ok=True` is granted purely because `DeepInfraProvider` **has no `health()` method** — the health check is `"health_error" not in details and "error" not in details` (Client.py:227) with nothing to fail. Warmup never opens a connection, so "healthy" here means "18 aliases exist in a dict", not "the endpoint answers". Same trap as the audit: it never proves the provider can talk to DeepInfra.

---

## 7. Sharp edges, severity-ordered (each one reproduced)

**7.1 — No credential, spoofed origin (blocking).**
The request carries no `Authorization` and bets that DeepInfra accepts keyless calls from a `g4f.dev` origin. If that bet is wrong the module is a 401 generator, and 401 is *fatal* → zero retries. Fix: `"Authorization": f"Bearer {os.getenv('DEEPINFRA_API_KEY','')}"` when the env var is set.

**7.2 — `retries=-1` (or anything negative) crashes with a confusing error.**
`range(1 + retries)` is empty → `resp` never assigned → `UnboundLocalError: cannot access local variable 'resp'` (test 10). Fix: `self.retries = max(0, int(retries))`.

**7.3 — Blocking retries freeze the event loop** (test 13: 2.3 s of dead loop; `Server` serialises 32 concurrent requests behind a semaphore, so every retry is a global stall). Fix options: run it through `asyncio.to_thread` in the caller, or port it to the async `curl_cffi` design already written for Upstage v3.

**7.4 — The response is never closed on early exit.**
`_stream` has no `try/finally`; if the consumer breaks out / `gen.close()`s, `resp.close()` is never called (test 11: 0 calls). Fix:

```python
resp = scraper.post(_API, json=payload, stream=True, timeout=self.timeout)
try:
    for raw_line in resp.iter_lines(decode_unicode=True):
        ...
finally:
    resp.close()
```

**7.5 — `stream=False` is a lie** (test 05): signature accepts it, payload hard-codes `"stream": True`. Either honour it (and parse the JSON body) or delete the parameter — silently ignoring an argument is the kind of thing that wastes an afternoon later.

**7.6 — Charset roulette (real `requests` behaviour, test 12).**
`iter_lines(decode_unicode=True)` decodes with `resp.encoding`, which `requests` derives from the `Content-Type` header: `text/event-stream; charset=utf-8` → correct `'héllo 😀 日本語'`; a bare `text/event-stream` → **ISO-8859-1** → `'hÃ©llo ð\x9f\x98\x80 æ\x97¥æ\x9c¬èª\x9e'`. One header change away from mojibake in every emoji/CJK/Devanagari answer. Fix: `resp.encoding = "utf-8"` before the loop.

**7.7 — Reasoning invisible** (§5/test 03). If you want it in your server's reasoning pipeline, emit it wrapped so `Server.LocalBackend`'s `<think>` parser picks it up:

```python
delta = choices[0].get("delta", {})
if delta.get("reasoning_content"):
    return f"<think>{delta['reasoning_content']}", False
```
(and close the tag when reasoning ends / on `[DONE]`).

**7.8 — Error taxonomy is coarse** — the `except RuntimeError: raise` arm means a `RuntimeError` raised *inside* cloudscraper/urllib3 during a transport hiccup escapes without the retry the author intended; and unknown short model names are forwarded rather than rejected, turning a typo into a fatal 404 (§2).

**7.9 — Small stuff** — `x-request-id` frozen (7.1-adjacent fingerprint risk); `tool`/`developer` messages vanish (§5); `usage` requested but discarded; `available_models()` returns aliases, not the ids it will actually send.

---

## 8. The one question this sandbox cannot answer

`api.deepinfra.com` (and `g4f.dev`, `g4f.space`, `chat.dphn.ai` — everything except PyPI/GitHub) is blocked at the sandbox egress, so **no live HTTP test was possible**. DNS resolves (`38.101.151.x`) but TCP/443 is refused.

Run this from a machine with internet — it decides 7.1 once and for all:

```bash
curl -i -X POST https://api.deepinfra.com/v1/openai/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Origin: https://g4f.dev' -H 'Referer: https://g4f.dev' \
  -d '{"model":"Qwen/Qwen3-Max","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

| answer | meaning |
|---|---|
| `401 Unauthorized` | keyless access is dead → DeepInfra.py needs an `Authorization` header (7.1) |
| `200` + SSE | the spoof works today; the file is a working keyless proxy client |
| `404 model not found` | transport fine, but the 18 aliases are stale → refresh from `GET /v1/openai/models` |

---

## 9. Probe evidence index

`deepinfra_trace.py` → 16 tests; raw console output: `trace_output.txt`.

| # | what it proves |
|---|---|
| 01 | `_resolve` alias/passthrough rules (`gpt-4o` → forwarded) |
| 02 | `_build_msgs` matrix — dropped `tool`/`developer` roles, last-system-wins |
| 03 | `_parse_sse` accepts only `choices[0].delta.content` |
| 04 | exact outbound payload + `reasoning_content`/`usage` never surfaced |
| 05 | `stream=False` ignored (payload `stream: true`) |
| 06 | 429,429,200 → 3 posts, sleeps `[2.03, 4.72]`, no session reset |
| 07 | 521 → scraper rebuilt (old closed), retry succeeds on reply #2 |
| 08 | 401 → immediate `RuntimeError: Fatal error: HTTP 401 …`, 1 post, 0 sleeps |
| 09 | 3× connection errors → 3 posts, sleeps `[2.0, 4.0]`, 4 scrapers created |
| 10 | `retries=0` ok; `retries=-1` → `UnboundLocalError: resp` |
| 11 | early generator close → `resp.close()` called 0 times |
| 12 | charset present → `'héllo 😀 日本語'`; absent → latin-1 mojibake |
| 13 | one 429 retry = 2.319 s of frozen asyncio loop |
| 14 | 64 registry models, **0** with DeepInfra, 2 alias collisions |
| 15 | Client/Completion catalogue entries + `close()` no-op + no `health()`/`connect()` |
| 16 | warmup would report `{'model_count': 18, 'ok': True}` without ever connecting |

Re-run anytime:

```bash
cd /home/user/serv__ && /home/user/.venv/bin/python "DeepInfra Deep Dive/deepinfra_trace.py"
```

---

## 10. Cheat-sheet

| thing | where |
|---|---|
| endpoint / spoofed origin | `DeepInfra.py:33-34` |
| browser headers (no auth!) | `:36-53` |
| retry / fatal status sets | `:55-56` |
| 18 aliases + default | `:62-98` |
| alias resolver | `:101-107` |
| cloudscraper singleton / reset | `:113-138` |
| SSE parser | `:144-162` |
| provider class · payload · chat | `:167 · :283-326` |
| retry+stream engine | `:230-281` |
| chainable setters | `:328-343` |
| `close()` (no-op) | `:350-351` |
| exported for package | `providers/__init__.py:5` |
| registered in client | `Client.py:31` |
| params whitelist | `Completion.py:92-96` |
| sync-provider branch | `Completion.py:430-434` |
| consuming server loop | `Server.py:527-651` |
| registry (no DeepInfra) | `Models.py:1235+` |

**If you want DeepInfra live in the router** (3 edits): add `providers=("DeepInfra",)` + `connection={"DeepInfra": "zai-org/GLM-5"}` (or the model id you want) to a `Model` in `Models.py`; set `DEEPINFRA_API_KEY` and send the bearer header; then either accept the blocking sync path or port the file to the async `curl_cffi` pattern you already wrote in `New Upstage Change Logs/upstage_provider.py` (v3).
