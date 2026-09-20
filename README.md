# SILK — chat server + Mercury/Inception provider

Rebuild of `My PREVIOUS ENTIRE SERVER/API/providers/Inception.py` and the
`/api/connect` trick from `Adarshukumar/SILK`, in Python, with every
liability removed and the request path made explicit:

```
browser ──POST /api/chat──▶ SILK (FastAPI) ──POST /api/chat──▶ chat.inceptionlabs.ai
   ▲                          │  X-Forwarded-For: <user ip>
   └── SSE: reasoning / token / sources / done ──┘
```

```bash
git clone -b arena/01a0bd10-serv https://github.com/Adarshukumar/serv__.git silk
cd silk
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py --mock        # dev against a local fake upstream
.venv/bin/python run.py               # against the real API
.venv/bin/python -m tests.smoke       # 30 assertions, no pytest needed
```

Open `http://localhost:7860`. Health: `GET /api/health`, `GET /healthcheck` (HF).

---

## Ship it to Hugging Face Spaces (Docker SDK)

The app lives at the **repo root** (`app/`, `web/`, `run.py`, `Dockerfile`) because
a Space builds from the repo root — a nested folder needs its `COPY` paths
rewritten. Nothing else is special.

```bash
# 1. create the Space on https://huggingface.co/new-space
#    SDK: Docker · License: MIT · Space name: silk

# 2. push this branch straight into it
cd silk
git remote add hf https://huggingface.co/spaces/Adarshukumar/silk
gh auth token | git -c credential.helper='!f() { echo "username=oauth2"; echo "password=$(cat)"; }; f'     push hf arena/01a0bd10-serv:main -f

#    …or with the hub CLI instead:
#    hf auth login && hf upload Adarshukumar/silk . --repo-type space
```

Already-built URL for this repo/branch:

```
https://huggingface.co/spaces/Adarshukumar/silk/tree/main
git clone https://huggingface.co/spaces/Adarshukumar/silk
```

**Four things a Space forces on you, all handled:**

| Requirement | Where |
|---|---|
| non-root uid 1000, port 7860, read env vars itself (no `sudo`/supervisor) | `Dockerfile` |
| `GET /healthcheck` | `app/server.py` §6.5 |
| `GET /logs/stream` — deliberately a single status line, not real stderr, so prompts in log lines can't be scraped | `app/server.py` §6.5 |
| valid `Host` header, or HF answers *"connection was not made to a recognised domain"* | `§6.3b host_guard`, allows `*.hf.space` + `localhost`, extend with `ALLOWED_HOSTS=chat.example.com` |

Optional: `DOCS=0` drops `/docs`, `/redoc` and `/openapi.json`. `python run.py
--check` prints the resolved config plus misconfiguration warnings — run it
before you push, it is what a Space's build log will not tell you.

**One honesty note specific to Spaces:** behind HF's proxy, `request.client` is
always `127.0.0.1` and the user IP only exists in `X-Forwarded-For` — which the
client controls. So on a Space, per-IP limits are **advisory**: someone can
claim a fresh IP to dodge *their own* bucket. They cannot affect you or other
users beyond that, because the upstream call still comes from your Space's
single IP, and the global `MAX_CONCURRENCY` cap is the real protection. To keep
attribution honest instead of fake, set `TRUSTED_PROXIES=` (empty) and accept
one shared bucket. Pick which, deliberately — don't let it default by accident.

---

## The one honest sentence about IP forwarding

**Upstream always sees this server's IP as the source of the connection. The
user's IP travels as a header, which is a claim, not a route.**

That is not a limitation of this code, it is TCP: the upstream's SYN-ACK and
every response packet must be routable back to whoever opened the socket. The
user's machine never has a socket to the provider, so it can never be the peer.

What this repo does, precisely:

| Layer | Value | Who can fake it |
|---|---|---|
| socket peer (upstream's view) | this server's IP | nobody |
| `X-Forwarded-For` / `X-Real-IP` / `Forwarded` to upstream | resolved user IP | us — and upstream may ignore it entirely |
| `X-Forwarded-For` inbound to us | only believed from `TRUSTED_PROXIES` | client, if you misconfigure |

Upstream will only *act* on the forwarded header if it reads it and trusts us.
Rate-limit evasion is explicitly **not** the goal here: the header exists so a
backend you operate can attribute usage per user. If the point were to dodge a
provider's per-IP limits, the only mechanism is a rotating proxy pool — which
is exactly what §4.0 deletes, and it fails for a better reason than ToS: you
hand every user's prompt and every model reply to a stranger's box, in one
shared pool where one abuser gets everyone blocked.

### What the previous code got wrong (each one is now a test)

1. `xff.split(",")[0]` took the **leftmost** forwarded entry — the one the
   client controls. Anyone could claim a new IP and get a fresh bucket.
2. `req.socket.remoteAddress` fallback sent `127.0.0.1` as "the user's IP" in
   dev, so every user shared one bucket — the opposite of the stated goal.
3. **Uvicorn silently rewrites `request.client.host` from `X-Forwarded-For`
   when `proxy_headers` is on (its default) and the peer is in
   `FORWARDED_ALLOW_IPS` (default `127.0.0.1`).** On localhost that means your
   own code sees the *spoofed* address as the socket truth and has nothing left
   to check against. This bit us while writing the tests; `run.py` and
   `server.main()` now bind uvicorn's trust list to `TRUSTED_PROXIES` so there
   is one decision, not two.
4. `Access-Control-Allow-Origin: *` plus an unauthenticated `POST /api/connect`
   = an open token mint. Here there is no CORS wildcard, and the limiter is in
   front of everything.
5. Forging `Origin`/`Referer`/`sec-ch-ua`/`User-Agent` to look like the vendor's
   own web app. Removed. If upstream rejects a plain client, the fix is their
   real API key, not a costume.

---

## §4.0 — everything the old file had, and what replaced it

| Was | Now |
|---|---|
| `_PROXY = "http://217.217.249.160:8080"` | deleted. No proxy path exists in this codebase |
| `cloudscraper(browser={chrome,windows}, delay=10)` | `httpx.AsyncClient` direct |
| browser UA + `Origin` + `Referer` + `sec-ch-ua` + `sec-fetch-site: same-origin` | none of them; `User-Agent: silk-chat/1.0` |
| `time.sleep(random.uniform(1.5, 4.0))` jitter | deleted |
| `threading` refresh loop every 90 s + `atexit` + `__del__` | lazy `TokenManager`, one shared in-flight fetch, refresh on demand, exactly one retry on 401/403 |
| 12 h credential cache, `MERCURY_CACHE_DIR` on disk | in-process only, `TOKEN_TTL`, nothing written to disk |
| sync `requests` in a thread + `queue.Queue` bridge (2 executors/stream) | native `async for raw in resp.aiter_lines()` |
| `sources` JSON yielded as a **text token** | its own SSE event `sources`; `_is_search_json()` guesser deleted |
| bare `except Exception: return None` | typed errors: `UpstreamError`, `UnauthorizedError`, `RateLimitedError(retry_after)` |
| `GET /v1/users` leaking every user id, `POST /v1/warmup`, `POST /v1/credentials/refresh`, model audit loops | deleted; `GET /api/health` and `GET /api/config` only |
| global semaphore starving everyone | semaphore per stream + per-IP sliding-window limiter |

Kept, because it is the actual API contract (verified by `tests.smoke`):
`/api/session → {"token": …}` sent back as `x-session-token`; the
`{id, role, parts:[{type:"text",text}], state:"done"}` message shape; system
prompts folded into a user turn behind `[SYSTEM INSTRUCTION]`; consecutive user
turns merged; payload keys `reasoningEffort, webSearchEnabled, voiceMode, id,
messages, trigger`; SSE `reasoning-delta | text-delta | source-url | [DONE]`.

---

## Streaming contract

The browser never calls the model API. It calls us and reads typed SSE — there
is no client-side "fetch the rest myself" path, and no polling.

```
event: start     {"session_id":"…","turn":1}
event: reasoning {"text":"chunk"}          # thinking stream, collapsible in UI
event: token     {"text":"chunk"}          # answer stream
event: sources   {"source":{"id","url","title"}}   # deduped, as they arrive
event: done      {"chars":N,"elapsed_ms":N,"first_token_ms":N,"turns":N}
event: error     {"code","message","retry_after"}
```

Extras: backpressure is per-connection (a slow client cancels, and
`asyncio.CancelledError` aborts the upstream request — close the tab, the
generation stops, no orphaned quota burn). `X-Accel-Buffering: no` is set so
nginx doesn't turn the stream into a download.

## Endpoints

| | |
|---|---|
| `GET /` | chat UI |
| `POST /api/chat` | stream a turn (SSE). `{"message","session_id","search","thinking","reasoning_effort","stream","reset"}` |
| `GET /api/config` | UI config **+ an echo of how your own IP was resolved** |
| `GET /api/health` | uptime, upstream, `proxy: null`, forwarding flag |
| `POST /api/session/reset?session_id=` | clear one conversation |

## Deploying behind a proxy

```nginx
location / {
    proxy_pass http://127.0.0.1:7860;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_buffering off;            # SSE
    proxy_read_timeout 300s;
}
```
Then set `TRUSTED_PROXIES=127.0.0.1`. Verify with `GET /api/config` —
`you.via_trusted_proxy` must be `true`. Exposed directly instead? Set
`TRUSTED_PROXIES=` (empty) and accept that every user shares one bucket, which
is what your rate limiter wants anyway.

## Layout

```
app/config.py            every env var, one place
app/client_ip.py         resolution + forwarding, with the trust boundary
app/limits.py            per-IP sliding window + bans
app/providers/inception.py   the provider (httpx, no proxy, typed events)
app/server.py            FastAPI, SSE, static UI
web/                     index.html · app.js · style.css
mock/inception_api.py    fake upstream that reports what it received
tests/smoke.py           end-to-end assertions
```
