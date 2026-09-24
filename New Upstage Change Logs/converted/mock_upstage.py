"""
mock_upstage.py — protocol-faithful local double of the Upstage console
+ completions API, so the converted provider can be exercised end-to-end
in sandboxes where real console.upstage.ai is unreachable.

Implements EXACTLY the wire contract the provider speaks:

  1. GET  /playground/chat                 → HTML embedding static/chunks/*.js
  2. GET  /playground/chat  (RSC: 1)       → RSC text with more chunk refs
  3. GET  /_next/static/chunks/<file>.js   → JS with
         createServerReference("<42hex>",…,"getConsoleCsrfToken")
  4. POST /playground/chat  (next-action)  → flight line containing {"token": …}
  5. POST /v1/web/demo/chat/completions?include_think=true
         → SSE stream: search events → r-delta → t-delta (with inline
           <think>…## markup) → usage → finish stop → [DONE]
     Requires header x-csrf-token matching the issued token (403 else),
     plus the session cookie — exactly like production.

Run:  python3 mock_upstage.py --port 8485
"""
from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
import uuid
from typing import AsyncGenerator, Dict, List, Optional

from fastapi import FastAPI, Request, Response
from fastapi.responses import PlainTextResponse

# ── deterministic action ids (42 hex, like production) ──────────
ACTION_TOKEN_ID = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5"  # 42 hex
ACTION_INIT_ID = "f0e1d2c3b4a5968778695a4b3c2d1e0ff0e1d2c3b4"   # 42 hex

# issued CSRF token (regenerated when creds rotate)
CURRENT_TOKEN = {"value": f"csrf-{uuid.uuid4().hex}"}
# when True the next completions call 403s once → exercises auth-retry
FLAKY_AUTH = {"on": False, "hits": 0}

_SESSIONS: Dict[str, dict] = {}   # session_id → info
_PAYLOAD_LOG: List[dict] = []     # every completions payload, for tests

app = FastAPI(title="Mock Upstage Console")


# ═══════════════════════════════════════════════════════════
# 1–2 · PLAYGROUND PAGE (HTML + RSC variants)
# ═══════════════════════════════════════════════════════════
_PAGE_HTML = """<!DOCTYPE html>
<html lang="en">
<head><title>Playground | Upstage Console (MOCK)</title></head>
<body>
<div id="__next">
  <script src="/_next/static/chunks/4bd1b696c9791f27.js"></script>
  <script src="/_next/static/chunks/5327a9d0d1f0be44.js"></script>
  <script src="/_next/static/chunks/a1c4e8f02b6d3759.js"></script>
</div>
</body>
</html>
"""

_RSC_PAYLOAD = (
    '0:["_next/static/chunks/4bd1b696c9791f27.js",'
    '"_next/static/chunks/a1c4e8f02b6d3759.js"]\n'
    '1:{"token":null}\n'
)


def _ensure_session(request: Request, response: Response) -> str:
    sid = request.cookies.get("session_id") or str(uuid.uuid4())
    if sid not in _SESSIONS:
        _SESSIONS[sid] = {"created": time.time(), "requests": 0}
    _SESSIONS[sid]["requests"] += 1
    response.set_cookie("session_id", sid, httponly=False, path="/")
    return sid


@app.get("/playground/chat")
async def playground(request: Request, response: Response):
    _ensure_session(request, response)
    if request.headers.get("RSC") == "1":
        return PlainTextResponse(
            _RSC_PAYLOAD,
            media_type="text/x-component",
            headers={"x-action-cache": "HIT"},
        )
    return PlainTextResponse(_PAGE_HTML, media_type="text/html")


# ═══════════════════════════════════════════════════════════
# 3 · JS CHUNKS (server-action ids embedded by name)
# ═══════════════════════════════════════════════════════════
_CHUNKS = {
    "4bd1b696c9791f27.js": (
        "(function(){var e=require('server-reference');\n"
        'e.createServerReference)("__OTHER__",x.callServer,void 0,'
        'x.findSourceMapURL,"otherAction")\n'
        "})();\n"
    ),
    "5327a9d0d1f0be44.js": "(function(){/* framework */})();\n",
    "a1c4e8f02b6d3759.js": (
        "// playground chat page\n"
        'createServerReference)("__INIT__",x.callServer,void 0,'
        'x.findSourceMapURL,"authAction")\n'
        'createServerReference)("__TOKEN__",x.callServer,void 0,'
        'x.findSourceMapURL,"getConsoleCsrfToken")\n'
    ),
}
# fill real ids (plain replace — JS braces would break str.format)
_CHUNKS["4bd1b696c9791f27.js"] = _CHUNKS["4bd1b696c9791f27.js"].replace(
    "__OTHER__", ACTION_INIT_ID
)
_CHUNKS["a1c4e8f02b6d3759.js"] = (
    _CHUNKS["a1c4e8f02b6d3759.js"]
    .replace("__INIT__", ACTION_INIT_ID)
    .replace("__TOKEN__", ACTION_TOKEN_ID)
)


@app.get("/_next/static/chunks/{filename}")
async def js_chunk(filename: str):
    js = _CHUNKS.get(filename)
    if js is None:
        return Response(status_code=404)
    return PlainTextResponse(js, media_type="application/javascript")


# ═══════════════════════════════════════════════════════════
# 4 · RSC POST → CSRF token flight response
# ═══════════════════════════════════════════════════════════
@app.post("/playground/chat")
async def rsc_action(request: Request):
    action = request.headers.get("next-action", "")
    body = (await request.body()).decode("utf-8", "replace")

    if action == ACTION_TOKEN_ID:
        tok = CURRENT_TOKEN["value"]
        # flight-style response lines; provider regexes the {"token":…} line
        flight = (
            f'1:{{"token":"{tok}"}}\n'
            '2:"$S1"\n'
        )
        return PlainTextResponse(flight, media_type="text/x-component")

    if action == ACTION_INIT_ID:
        return PlainTextResponse('1:null\n', media_type="text/x-component")

    return PlainTextResponse(
        f'0:{"error"}\n', status_code=400, media_type="text/x-component"
    )


# ═══════════════════════════════════════════════════════════
# 5 · COMPLETIONS — SSE stream (the heart)
# ═══════════════════════════════════════════════════════════
_OPEN = "<" + "think" + ">"
_CLOSE = "</" + "think" + ">"


def _think_trace(prompt: str, model: str) -> List[str]:
    """Reasoning tokens (r-delta stream)."""
    trace = (
        f"The user asked about: {prompt[:80]!r}. "
        f"I am {model}. I should answer concisely and correctly. "
        "Let me work through this step by step before committing to the final answer. "
    )
    # split into token-ish chunks
    words = trace.split(" ")
    out, buf = [], ""
    for w in words:
        buf += w + " "
        if len(buf) >= 16:
            out.append(buf)
            buf = ""
    if buf:
        out.append(buf)
    return out


def _answer_chunks(prompt: str, model: str, history: Optional[List[dict]] = None) -> List[str]:
    """Content tokens with an INLINE think block (v3 splitter exercise)."""
    p = prompt.lower()
    hist_text = " ".join(
        str(m.get("content", "")) for m in (history or [])
    )
    if "2+2" in p or "2 + 2" in p:
        core = "4"
    elif "capital of france" in p:
        core = "Paris"
    elif "color" in p or "colour" in p:
        core = "blue"
    elif re.search(r"count from 1 to 4", p):
        core = "1 2 3 4"
    elif "hello" in p or "hi" in p:
        core = "Hello! How can I help you today?"
    elif "my name" in p or "what is my name" in p:
        # multi-turn memory: look for "name is X" / "I am X" in history
        m = re.search(r"name is ([A-Za-z]+)", hist_text, re.I)
        if not m:
            m = re.search(r"\bI am ([A-Za-z]+)\b", hist_text, re.I)
        core = m.group(1) if m else "(I don't have a name on record)"
    else:
        core = f"You said: {prompt[:120]}"

    chunks = [
        "Sure",
        " — here is my answer",
        ".\n",
        _OPEN,
        " Quick internal check: the key fact is solid; ",
        "confidence high.",
        _CLOSE,
        f" **{core}**",
        f"\n\n(model: {model})",
    ]
    return chunks


def _search_events(prompt: str) -> List[str]:
    """search_start / search_finish / summarizing SSE lines."""
    q = prompt[:60] or "upstage solar"
    queries = [{
        "query": q,
        "results": [
            {"url": "https://en.wikipedia.org/wiki/Example",
             "title": "Example — Wikipedia",
             "score": 0.9123,
             "content": "An example is something representative of a group. " * 8},
            {"url": "https://docs.upstage.ai/",
             "title": "Upstage Docs",
             "score": 0.8742,
             "content": "Upstage builds Solar, a family of efficient LLMs. " * 8},
            {"url": "https://en.wikipedia.org/wiki/Example",   # dup URL → deduped
             "title": "Example DUP",
             "score": 0.5,
             "content": "duplicate"},
        ],
    }]
    return [
        json.dumps({
            "search": {
                "status": {"action": "search_start", "description": "searching"},
                "search_queries": queries,
            }
        }),
        json.dumps({
            "search": {
                "status": {"action": "search_finish", "description": "done"},
                "search_queries": queries,
            }
        }),
        json.dumps({
            "search": {
                "status": {"action": "summarizing", "description": "summarize"},
                "search_queries": None,
            }
        }),
    ]


def _sse(obj) -> str:
    if obj == "[DONE]":
        return "data: [DONE]\n\n"
    return "data: " + json.dumps(obj) + "\n\n"


def _delta(delta: dict, finish: Optional[str] = None) -> str:
    return _sse({"choices": [{"delta": delta, "finish_reason": finish}]})


async def _event_stream(payload: dict) -> AsyncGenerator[str, None]:
    model = payload.get("model", "solar-pro3")
    messages = payload.get("messages", [])
    last_user = ""
    wants_search = False
    for m in reversed(messages):
        if m.get("role") == "user":
            last_user = m.get("content", "")
            if m.get("mode") == ["search"] or payload.get("search_provider"):
                wants_search = True
            break
    if payload.get("search_provider") == "tavily":
        wants_search = True

    # subtle pacing so clients see REAL streaming (multiple reads)
    step = 0.012

    if wants_search:
        for line in _search_events(last_user):
            yield _sse(json.loads(line))
            await asyncio.sleep(step)

    # reasoning (r-delta) — only when the payload asked for reasoning
    if "reasoning_effort" in payload and model != "upstage/solar-1-mini-chat":
        for tok in _think_trace(last_user, model):
            yield _delta({"reasoning_content": tok})
            await asyncio.sleep(step)

    # content (t-delta) — may contain inline <think>…##
    for tok in _answer_chunks(last_user, model, history=messages):
        yield _delta({"content": tok})
        await asyncio.sleep(step)

    # usage (non-zero) + finish + [DONE] on the final stretch
    prompt_chars = len(json.dumps(messages))
    usage = {
        "prompt_tokens": max(1, prompt_chars // 4),
        "completion_tokens": 37,
        "total_tokens": max(1, prompt_chars // 4) + 37,
        "total_tokens": max(1, prompt_chars // 4) + 37,
    }
    yield _sse({
        "choices": [{"delta": {}, "finish_reason": "stop"}],
        "usage": usage,
    })
    await asyncio.sleep(step)
    yield _sse("[DONE]")


@app.post("/v1/web/demo/chat/completions")
async def completions(request: Request):
    # ── auth gates: cookie + CSRF header (like production) ──
    if "session_id" not in request.cookies and "x-session-id" not in request.headers:
        return Response(status_code=401, content='{"error":"no session"}')

    csrf = request.headers.get("x-csrf-token", "")
    if csrf != CURRENT_TOKEN["value"]:
        return Response(status_code=403, content='{"error":"bad csrf"}')

    if FLAKY_AUTH["on"]:
        FLAKY_AUTH["on"] = False
        FLAKY_AUTH["hits"] += 1
        return Response(status_code=403, content='{"error":"flaky auth"}')

    payload = await request.json()
    _PAYLOAD_LOG.append(payload)

    async def gen():
        async for chunk in _event_stream(payload):
            yield chunk

    from fastapi.responses import StreamingResponse
    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "x-accel-buffering": "no",
        },
    )


# ═══════════════════════════════════════════════════════════
# test-control endpoints (mock only)
# ═══════════════════════════════════════════════════════════
@app.post("/__test/rotate_token")
async def rotate_token():
    """Invalidate the current CSRF token (old tokens → 403 once)."""
    CURRENT_TOKEN["value"] = f"csrf-{uuid.uuid4().hex}"
    return {"token_rotated": True}


@app.post("/__test/flaky_auth")
async def flaky_auth():
    """Next completions call fails 403 once (auth-retry exercise)."""
    FLAKY_AUTH["on"] = True
    return {"flaky_armed": True}


@app.get("/__test/payloads")
async def payloads():
    return {"count": len(_PAYLOAD_LOG), "last": _PAYLOAD_LOG[-1] if _PAYLOAD_LOG else None}


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "mock-upstage",
        "sessions": len(_SESSIONS),
        "payloads": len(_PAYLOAD_LOG),
        "flaky_hits": FLAKY_AUTH["hits"],
        "action_token_id_len": len(ACTION_TOKEN_ID),
    }


def main():
    import uvicorn
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8485)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
