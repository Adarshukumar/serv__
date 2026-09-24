"""
api_server.py — HTTP API wrapping the converted UpstageProvider.

Endpoints
  GET  /health            → liveness + endpoint identity
  GET  /v1/models         → model registry
  POST /v1/chat           → single JSON response (full answer, no stream)
  POST /v1/chat/stream    → SSE of StreamEvents {sources,thinking,content,done}
  GET  /                  → tiny browser test page (streams into the DOM)

Request body (both chat endpoints):
  {
    "prompt":     "hi",                 // or "messages": [{role,content},…]
    "messages":   null,
    "model":      "solar-pro3",
    "system":     null,
    "search":     false,
    "reasoning":  null,                 // low|medium|high
    "max_tokens": 256,
    "temperature": null
  }

Run (against the local mock):
  UPSTAGE_CONSOLE_URL=http://127.0.0.1:8485 \\
  UPSTAGE_API_BASE=http://127.0.0.1:8485 \\
  python3 api_server.py --port 8484
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path
from typing import AsyncGenerator, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from upstage_kit import (
    UpstageAuthError, UpstageProvider, UpstageStreamError,
)
from upstage_kit import config as kit_config

app = FastAPI(title="Upstage Kit API", version="1.0")

# one provider per process (sessions are short-lived demo conversations)
_provider = UpstageProvider()
_started = time.time()


class ChatRequest(BaseModel):
    prompt: Optional[str] = None
    messages: Optional[List[Dict]] = None
    model: Optional[str] = None
    system: Optional[str] = None
    search: bool = False
    reasoning: Optional[str] = Field(default=None, description="low|medium|high")
    max_tokens: Optional[int] = 256
    temperature: Optional[float] = None

    def validate_input(self):
        if not self.prompt and not self.messages:
            raise HTTPException(422, "provide 'prompt' or 'messages'")


def _stream_kwargs(req: ChatRequest) -> dict:
    return dict(
        data=req.prompt,
        messages=req.messages,
        model=req.model,
        system=req.system,
        reasoning=req.reasoning,
        search=req.search or None,
        max_tokens=req.max_tokens,
        temperature=req.temperature,
    )


def _fresh_turn(req: ChatRequest):
    """Stateless HTTP default: each call is its own conversation.
    (Pass full 'messages' for multi-turn; history doesn't leak across
    unrelated requests.)"""
    _provider.clear_history()


@app.get("/health")
async def health():
    return {
        "ok": True,
        "service": "upstage-kit-api",
        "uptime_s": round(time.time() - _started, 1),
        "console": kit_config.console_url(),
        "api_base": kit_config.api_base(),
        "model": _provider.model,
        "connected": _provider._connected,
        "turns": _provider.session_usage.totals()["turns"],
    }


@app.get("/v1/models")
async def models():
    return {"models": _provider.list_models(), "info": UpstageProvider.model_info()}


@app.post("/v1/chat")
async def chat(req: ChatRequest):
    """Non-streaming: wait for the full answer, return JSON."""
    req.validate_input()
    up = _provider
    _fresh_turn(req)
    try:
        async for _ in up.chat(**_stream_kwargs(req)):
            pass
    except UpstageAuthError as e:
        raise HTTPException(401, f"auth: {e}")
    except UpstageStreamError as e:
        raise HTTPException(502, f"upstream: {e}")
    except ValueError as e:
        raise HTTPException(422, str(e))

    return {
        "ok": True,
        "model": up.last_usage.model if up.last_usage else up.model,
        "response": up.last_response,
        "reasoning": up.last_reasoning,
        "sources": up.last_sources,
        "sources_text": up.last_sources_text,
        "usage": up.last_usage.to_dict() if up.last_usage else None,
        "history_roles": [m["role"] for m in up.history],
    }


@app.post("/v1/chat/stream")
async def chat_stream(req: ChatRequest):
    """Server-Sent Events: each event is one StreamEvent as JSON."""
    req.validate_input()
    up = _provider
    _fresh_turn(req)

    async def gen() -> AsyncGenerator[str, None]:
        t0 = time.time()
        n_events = 0
        try:
            async for ev in up.stream(**_stream_kwargs(req)):
                n_events += 1
                yield (
                    f"event: {ev.kind}\n"
                    f"data: {json.dumps({'kind': ev.kind, 'text': ev.text})}\n\n"
                )
            # trailer: usage summary after done
            u = up.last_usage
            if u:
                yield (
                    "event: usage\n"
                    f"data: {json.dumps(u.to_dict())}\n\n"
                )
        except UpstageAuthError as e:
            yield (
                "event: error\n"
                f"data: {json.dumps({'error': f'auth: {e}'})}\n\n"
            )
        except Exception as e:
            yield (
                "event: error\n"
                f"data: {json.dumps({'error': str(e)})}\n\n"
            )
        finally:
            pass

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "cache-control": "no-cache",
            "connection": "keep-alive",
            "x-accel-buffering": "no",
            "access-control-allow-origin": "*",
        },
    )


_INDEX_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Upstage Kit — live test</title>
<style>
  :root { color-scheme: dark; }
  body { font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
         background:#0b0e14; color:#d7dde8; max-width: 920px;
         margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.2rem; color:#ffd166; }
  textarea, select, input[type=text] {
    width:100%; background:#121722; color:#d7dde8; border:1px solid #2a3345;
    border-radius:8px; padding:.6rem; font:inherit; }
  .row { display:flex; gap:.6rem; align-items:center; margin:.6rem 0; flex-wrap:wrap; }
  button { background:#ffd166; color:#111; border:0; border-radius:8px;
           padding:.55rem 1.1rem; font-weight:700; cursor:pointer; }
  button:disabled { opacity:.5; cursor:not-allowed; }
  #out { background:#121722; border:1px solid #2a3345; border-radius:10px;
         min-height:180px; padding:1rem; white-space:pre-wrap; margin-top:1rem; }
  .think { color:#7a8496; font-style:italic; }
  .content { color:#e8edf7; }
  .sources { color:#8ecae6; }
  .meta { color:#596275; font-size:12px; }
  .err { color:#ff6b6b; }
  label { color:#8b95ab; font-size:13px; }
</style>
</head>
<body>
<h1>☀️ Upstage Kit — live API test</h1>
<div class="meta" id="health">checking /health …</div>
<div class="row">
  <label>model
    <select id="model"></select>
  </label>
  <label><input type="checkbox" id="search"/> web search</label>
  <label>reasoning
    <select id="reasoning">
      <option value="">auto</option>
      <option>low</option><option>medium</option><option>high</option>
    </select>
  </label>
  <label><input type="checkbox" id="stream" checked/> stream</label>
</div>
<textarea id="prompt" rows="3">What is 2+2? One word.</textarea>
<div class="row">
  <button id="send">Send</button>
  <button id="clear">Clear</button>
  <span class="meta" id="stat"></span>
</div>
<div id="out"></div>
<script>
const $ = id => document.getElementById(id);
const out = $('out');

async function loadHealth() {
  try {
    const h = await (await fetch('/health')).json();
    $('health').textContent =
      `console=${h.console}  api=${h.api_base}  connected=${h.connected}  turns=${h.turns}`;
    const m = await (await fetch('/v1/models')).json();
    $('model').innerHTML = m.models.map(x =>
      `<option value="${x.name}" ${x.active?'selected':''}>${x.name}</option>`).join('');
  } catch (e) { $('health').textContent = 'health failed: ' + e; }
}
loadHealth();

function append(cls, text) {
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = text;
  out.appendChild(span);
}

$('clear').onclick = () => { out.textContent = ''; $('stat').textContent = ''; };

$('send').onclick = async () => {
  const body = {
    prompt: $('prompt').value,
    model: $('model').value || null,
    search: $('search').checked,
    reasoning: $('reasoning').value || null,
    max_tokens: 256,
  };
  $('send').disabled = true;
  out.textContent = '';
  const t0 = performance.now();
  let events = 0;
  try {
    if ($('stream').checked) {
      const resp = await fetch('/v1/chat/stream', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify(body)});
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buf += dec.decode(value, {stream:true});
        let idx;
        while ((idx = buf.indexOf('\\n\\n')) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx+2);
          const lines = frame.split('\\n');
          let kind = '', data = '';
          for (const ln of lines) {
            if (ln.startsWith('event: ')) kind = ln.slice(7);
            else if (ln.startsWith('data: ')) data = ln.slice(6);
          }
          if (!kind || !data) continue;
          const obj = JSON.parse(data);
          events++;
          if (kind === 'thinking') append('think', obj.text);
          else if (kind === 'content') append('content', obj.text);
          else if (kind === 'sources') {
            const n = (JSON.parse(obj.text).sources || []).length;
            append('sources', `\\n[📚 ${n} sources]\\n`);
          }
          else if (kind === 'usage')
            append('meta', `\\n\\n⏱ ${obj.elapsed_s}s · first ${obj.first_token_s}s · ${obj.tokens} tok · ${obj.model}`);
          else if (kind === 'error')
            append('err', '\\nerror: ' + obj.error);
        }
      }
    } else {
      const resp = await fetch('/v1/chat', {
        method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify(body)});
      const j = await resp.json();
      if (!resp.ok) throw new Error(JSON.stringify(j));
      events = 1;
      if (j.sources_text) append('sources', j.sources_text + '\\n');
      append('content', j.response);
      if (j.usage) append('meta',
        `\\n\\n⏱ ${j.usage.elapsed_s}s · ${j.usage.tokens} tok · ${j.usage.model}`);
    }
  } catch (e) {
    append('err', '\\n' + e);
  } finally {
    $('stat').textContent = `${events} events · ${((performance.now()-t0)/1000).toFixed(2)}s`;
    $('send').disabled = false;
  }
};
</script>
</body>
</html>
"""


@app.get("/", response_class=HTMLResponse)
async def index():
    return _INDEX_HTML


def main():
    import uvicorn
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8484)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    print(f"api_server → http://{args.host}:{args.port}")
    print(f"  console = {kit_config.console_url()}")
    print(f"  api     = {kit_config.api_base()}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
