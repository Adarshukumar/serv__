# 🔷 NovaChat — npm/React chat app that talks straight to DeepInfra

A polished, animated chat client that streams from
`https://api.deepinfra.com/v1/openai/chat/completions` — the same endpoint your
Python provider (`My PREVIOUS ENTIRE SERVER/API/providers/DeepInfra.py`) posts to —
**directly from the browser, on the user's real IP.**

**No Python. No backend service. No API key required by default.**
`node` + `npm` + React is the whole stack.

```bash
npm install
npm run dev        # → http://localhost:5173
```

Then, in a second terminal (this one is the important one):

```bash
npm run doctor     # tells you, header by header, what DeepInfra actually accepts
```

---

## 1 · The one thing you need to understand

You asked for two things that pull in opposite directions:

| you want | reality |
| --- | --- |
| "use the reverse-engineered URL **directly** in the browser, on the real user IP" | ✅ the endpoint and the body work from a browser — `fetch()` to a cross-origin HTTPS host is a normal thing |
| "send the **exact** header set the Python file sent" | ❌ **impossible.** `Origin`, `Referer`, `User-Agent`, `Sec-Fetch-*` are *forbidden request headers*. JS cannot set them; the browser stamps its own origin and deletes the rest |

So NovaChat does the honest thing: it tries the closest version first and
**falls forward** through a ladder until a rung works. You always see which rung
answered (top bar chip + Diagnostics → *Route ladder*).

```
rung 1  direct · web-embed     your browser → api.deepinfra.com   ← your real IP
                               X-Deepinfra-Source: web-embed        (keyless)
rung 2  direct · bare          same, without the marker
rung 3  proxy  · web-embed     local Node middleware replays it with the FULL header set
rung 4  proxy  · legacy        the original Python header set (g4f.dev + frozen x-request-id)
```

Rungs 1–2 are the "real user IP" path. Rungs 3–4 exist because a browser can't be
a Python client — they still run **on your machine**, and they're what makes the
app keep working when CORS says no. `Demo` mode is a 5th, fully offline rung for
watching the UI with zero network.

---

## 2 · The reverse-engineering, as code

Two header sets circulate for this endpoint. `src/lib/deepinfra/headers.js` documents both:

| header | Python `DeepInfra.py` | g4f `DeepInfraChat` | a browser can set it? |
| --- | --- | --- | --- |
| `Origin` | `https://g4f.dev` | `https://deepinfra.com` | ❌ forbidden |
| `Referer` | `https://g4f.dev` | `https://deepinfra.com/` | ❌ forbidden |
| `X-Deepinfra-Source` | *missing* | **`web-embed`** ← the anonymous-access trick | ✅ allowed |
| `x-request-id` | frozen constant | per request | ✅ allowed |
| `User-Agent`, `Sec-Fetch-*` | Chrome-ish | Chrome-ish | ❌ forbidden |
| `Authorization` | never | never | ✅ allowed (we send it only if you set a key) |

The marker that matters is **`X-Deepinfra-Source: web-embed`** — that's what the
embedded chat widget on deepinfra.com sends, and it's the reason keyless access
can exist at all. Rung 1 sends exactly that.

> If rung 1 is blocked by CORS, the proxy rungs send the *identical* body with
> `Origin`, `Referer`, `User-Agent`, `Sec-Fetch-*` filled in for you
> (`server/proxy.js`). `npm run doctor` tests all of it from your machine and
> prints the status codes.

---

## 3 · Commands

| command | what it does |
| --- | --- |
| `npm run dev` | dev server on `0.0.0.0:5173` **including the local proxy** |
| `npm run build` | production bundle into `dist/` |
| `npm run preview` | serve the built bundle (proxy included) |
| `npm run doctor` | hits DeepInfra with every header variant, prints status + verdict. Add `-- --key=di_…` to also test a keyed call |
| `npm run selftest` | 46 offline checks: SSE framing, delta/reasoning/usage parsing, retry + backoff, fatal codes, the fallback ladder, and the proxy against a **mock upstream** (real HTTP bytes) |
| `npm run uismoke` | boots the real React app inside jsdom, types a message, presses Enter, and asserts streamed text, fallback, the 401 card, the diagnostics ladder, demo mode and persistence |

`doctor` is the only one that touches the internet; the other two are hermetic.

Environment knobs:

```bash
DEEPINFRA_API_KEY=di_… npm run dev     # proxy rungs use it server-side (never exposed to the page)
DEEPINFRA_PROXY_HOST=127.0.0.1:8000 DEEPINFRA_PROXY_SCHEME=http npm run dev   # point the proxy at a local mock
```

---

## 4 · Using it

- **Type & send** — `Enter` sends, `Shift+Enter` newlines, `Esc` stops mid-stream.
- **Auto mode** (default) walks the ladder. The top-bar chip tells you which rung
  answered and the ttfb / tok-s of the last run.
- **Model picker** — 30+ ids: the 18 aliases from your Python file (tagged `py`)
  plus documented ids (tagged `docs`). Custom `org/model` ids are allowed and
  forwarded untouched — the same rule as `_resolve()` in `DeepInfra.py`.
  `Settings → Sync live catalogue` pulls the real list and flags anything missing.
- **Thinking panel** — `reasoning_content` (Qwen3-Max-Thinking, DeepSeek, …) *and*
  inline `<think>…</think>` blocks are routed into a separate shimmering panel.
  Your Python provider threw reasoning away; this keeps it.
- **Diagnostics** (⌘/Ctrl-I) — live log, per-rung trial history, the exact
  endpoints in use, and an opt-in "show my egress IP" button.
- **Settings** — route mode, key (optional), system prompt, temperature, max
  tokens, top_p, retries, reasoning panel, telemetry toggle, local-proxy health.
- Everything lives in `localStorage`. Nothing is sent anywhere except DeepInfra.

Shortcuts: `⌘/Ctrl-K` new chat · `⌘/Ctrl-/` settings · `⌘/Ctrl-I` diagnostics · `Esc` close/stop.

---

## 5 · What was ported from the Python file — and what was deliberately fixed

Ported, faithfully:

- the endpoint, the body shape (`model`, `messages`, `temperature`, `max_tokens`,
  `stream: true`, `stream_options.include_usage`) and the `messages` rules
  (system prepended, `system=` overrides an in-list system);
- `_resolve()` semantics (alias → id, `/`-containing ids pass through);
- retry codes `{429,500,502,503,504,520…524}` → `min(2·2ⁿ + jitter, 30 s)`;
- fatal codes `{400,401,403,404,405,422}` → no retry;
- the 200-char error body cap (surfaced in the error card / log instead of a traceback).

Fixed on purpose (bugs found while probing `DeepInfra.py`):

| bug in the Python file | here |
| --- | --- |
| `time.sleep()` inside a sync generator froze the asyncio loop for seconds | real async, awaits, never blocks the UI |
| `retries=-1` → `UnboundLocalError: resp` | clamped (`Slider` min 0) |
| `stream=False` accepted then ignored | body always streams, and the UI always streams |
| response never closed on early exit | reader + abort wired, always released |
| charset-less responses → ISO-8859-1 mojibake | `TextDecoder('utf-8')` pinned |
| `reasoning_content`, `tool_calls`, `usage` silently dropped | reasoning kept, usage parsed and shown |
| `close()` no-op / no `health()` so warmup lied `ok: True` | real `/deepinfra-proxy/health` + per-run diagnostics |

---

## 6 · File map

```
index.html
vite.config.js                 host 0.0.0.0, allowedHosts true, proxy plugin
server/proxy.js                Node middleware: full spoof header sets, SSE passthrough,
                               x-deepinfra-variant: web-embed | legacy | minimal
scripts/doctor.mjs             on-the-wire header probe + verdict (the “does it work” tool)
scripts/selftest.mjs           46 hermetic checks (logic + proxy vs mock upstream)
scripts/uismoke.mjs            real app in jsdom, driven like a user
src/main.jsx  src/App.jsx  src/styles.css
src/hooks/useChat.js           conversations, streaming, RAF-batched token painting, logs
src/lib/storage.js             defensive localStorage
src/lib/deepinfra/
  headers.js                   endpoints + what a browser may/may not send (the table)
  models.js                    18 provider aliases + documented catalogue + sync parser
  sse.js                       SSE framing, delta/reasoning/usage, <think> router
  errors.js                    error taxonomy, retry/fatal sets, backoff math
  transport.js                 the ladder, retries, abort, metrics
src/components/                Sidebar · TopBar · MessageList · Composer · Drawer · ModelPicker · Toasts · Markdown
```

---

## 7 · Troubleshooting

| symptom | meaning | fix |
| --- | --- | --- |
| chip shows `direct-webembed` and text streams | 🎉 keyless direct access works on your IP | nothing to do |
| "Browser blocked the direct call" then it works | CORS refused the browser; the proxy rung answered | expected — check *Diagnostics → Route ladder* |
| every rung → **401** | anonymous web-embed access is closed for this endpoint/region | `npm run doctor -- --key=di_…`, then paste the key in Settings |
| **403** everywhere | origin/UA fingerprint rejected | try mode **Proxy-legacy**, or set a key |
| **404** | model id not served (unknown aliases are forwarded blindly) | Settings → *Sync live catalogue*, pick a live id |
| **429** | keyless rate limit for your IP | wait — the client already backs off — or add a key |
| spinner then "Every route failed" | nothing produced an HTTP answer (DNS/proxy/extension) | `npm run doctor` shows whether the host is reachable at all |
| works in `npm run dev`, not in `dist` opened as a file | no dev server ⇒ no `/deepinfra-proxy`, and `file://` blocks CORS | serve it: `npm run preview` |
| requests look like they come from a datacenter | you're using the proxy rung from a remote box | use rungs 1–2 (Direct) for a true user IP |

Keyless access is a moving target. Run `npm run doctor` whenever something stops
working — it prints exactly which header set the API accepts **today** from your
network, and the app's ladder follows the same order.

---

## 8 · Privacy / safety notes

- The API key, when you set one, is stored in *your* `localStorage`, sent to
  deepinfra.com and to your own local proxy header (`x-deepinfra-key`). It never
  goes anywhere else.
- Keyless requests are exactly what the public web-embed widget sends — this is
  not a credential bypass, and it is rate-limited per IP.
- No analytics, no third-party calls at all except the endpoints above (plus the
  optional "show my egress IP" button, which calls `api.ipify.org` once, on click).
- Model output is rendered through DOMPurify — untrusted text never becomes live HTML.
