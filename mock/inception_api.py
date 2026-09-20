"""
Fake Inception API for local end-to-end testing.

Speaks the same wire protocol as the real thing (x-session-token header,
/api/session handshake, SSE with reasoning-delta / text-delta / source-url /
[DONE]) so the provider, the server and the UI can all be exercised without
touching the upstream service.

It also *reports* what it saw, so the IP-forwarding claim can be verified
instead of asserted:

    curl -s localhost:8099/api/last-request | jq

The mock also runs with uvicorn's proxy_headers DISABLED, otherwise uvicorn
rewrites request.client.host from X-Forwarded-For and the "what did upstream
actually see" answer becomes a lie.

Run:  python -m mock.inception_api --port 8099
"""
from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Any, Dict

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="mock inception")

VALID_PREFIX = "mock-token-"
_last: Dict[str, Any] = {}


def _s(event: str, data: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/api/session")
async def session(request: Request) -> JSONResponse:
    _last.update({"at": time.time(), "path": "/api/session",
                  "socket_peer": request.client.host if request.client else None,
                  "headers": dict(request.headers)})
    return JSONResponse({"token": VALID_PREFIX + "abc123"})


@app.post("/api/chat")
async def chat(request: Request) -> Any:
    body = await request.json()
    _last.update({
        "at": time.time(),
        "path": "/api/chat",
        "socket_peer": request.client.host if request.client else None,
        "session_token": request.headers.get("x-session-token", ""),
        "x_forwarded_for": request.headers.get("x-forwarded-for", ""),
        "x_real_ip": request.headers.get("x-real-ip", ""),
        "forwarded": request.headers.get("forwarded", ""),
        "origin": request.headers.get("origin", ""),
        "referer": request.headers.get("referer", ""),
        "sec_fetch_site": request.headers.get("sec-fetch-site", ""),
        "user_agent": request.headers.get("user-agent", ""),
        "payload": body,
    })

    token = request.headers.get("x-session-token", "")
    if not token.startswith(VALID_PREFIX):
        return JSONResponse({"error": "invalid session token"}, status_code=401)

    msgs = body.get("messages", [])
    last_user = ""
    for m in reversed(msgs):
        if m.get("role") == "user":
            last_user = (m.get("parts") or [{}])[0].get("text", "")
            break

    async def streamer():
        yield ": ok\n\n"
        thinking = f"Reading the question: {last_user[:60]!r}. "
        if body.get("webSearchEnabled"):
            thinking += "Search is enabled, so I will attach sources. "
        thinking += "Drafting a short answer."
        for i in range(0, len(thinking), 14):
            yield "data: " + json.dumps({"type": "reasoning-delta",
                                         "delta": thinking[i:i + 14]}) + "\n\n"
            await asyncio.sleep(0.01)

        if body.get("webSearchEnabled"):
            yield "data: " + json.dumps({"type": "source-url",
                                         "sourceId": "__searching__"}) + "\n\n"
            for idx, (title, url) in enumerate(
                [
                    ("Mercury docs — reasoning tokens", "https://example.com/mercury/docs"),
                    ("SSE streaming guide", "https://example.com/sse"),
                    ("Duplicate that must be deduped", "https://example.com/sse"),
                ],
                start=1,
            ):
                yield "data: " + json.dumps({
                    "type": "source-url", "sourceId": f"s{idx}",
                    "url": url, "title": title,
                }) + "\n\n"
                await asyncio.sleep(0.01)

        reply = (
            f"You said: **{last_user}**\n\n"
            f"This stream came from the mock upstream via the server — "
            f"`stream={body.get('trigger', 'submit-message')}`, "
            f"effort=`{body.get('reasoningEffort')}`."
        )
        for i in range(0, len(reply), 9):
            yield "data: " + json.dumps({"type": "text-delta",
                                         "delta": reply[i:i + 9]}) + "\n\n"
            await asyncio.sleep(0.02)

        yield "data: [DONE]\n\n"

    return StreamingResponse(
        streamer(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/last-request")
async def last_request() -> Dict[str, Any]:
    """Exactly what the 'backend' received — proof for the IP-forwarding claim."""
    return _last


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
