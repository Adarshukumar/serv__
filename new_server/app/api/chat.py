"""
Chat endpoint — provider-based routing, non-laggy chunked streaming, secured
Nice SSE format: event: sources/thinking/content/done + data: {...} + data: [DONE]
Search is AUTO — no manual Tavily, providers handle auto search (inception.py, upstage style)
"""
from __future__ import annotations
import json
import time
import asyncio
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse, JSONResponse

from ..models.requests import ChatRequest
from ..providers.registry import global_registry
from ..core.security import sanitize_prompt, validate_messages, is_safe_prompt
from ..config import SERVER_MAX_CONCURRENCY, MAX_PROMPT_LENGTH

router = APIRouter()

def _sse(event: str, data: dict) -> str:
    """Nice SSE format: event: <type>\\ndata: <json>\\n\\n"""
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"

def _sse_data(data: dict) -> str:
    """OpenAI compat fallback: data: <json>\\n\\n"""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"

async def _event_generator(request: Request, chat_req: ChatRequest) -> AsyncGenerator[str, None]:
    provider_mgr = request.app.state.provider_manager
    session_store = request.app.state.session_store
    client_ip = getattr(request.state, "client_ip", "unknown")

    provider_name = chat_req.provider
    model_name = chat_req.model

    if not provider_name and model_name:
        mi = global_registry.get(model_name)
        if mi:
            provider_name = mi.provider
    if not provider_name:
        provider_name = "ragsrv"

    if not model_name:
        prov_info = global_registry.get_provider(provider_name)
        if prov_info and prov_info.models:
            model_name = prov_info.models[0]
        else:
            model_name = "luna"

    # Security
    if chat_req.prompt:
        if not is_safe_prompt(chat_req.prompt):
            yield _sse("error", {"error": "Prompt blocked by security filter", "blocked": True})
            yield "data: [DONE]\n\n"
            return
        chat_req.prompt = sanitize_prompt(chat_req.prompt)

    if chat_req.messages:
        try:
            validate_messages([m.dict() for m in chat_req.messages])
            for mm in chat_req.messages:
                content = mm.get("content", "") if isinstance(mm, dict) else getattr(mm, "content", "")
                if isinstance(content, str) and not is_safe_prompt(content):
                    yield _sse("error", {"error": "Message blocked by security filter", "blocked": True})
                    yield "data: [DONE]\n\n"
                    return
        except ValueError as ve:
            yield _sse("error", {"error": str(ve)})
            yield "data: [DONE]\n\n"
            return

    # Empty check
    if not chat_req.prompt and not chat_req.messages:
        yield _sse("error", {"error": "Provide prompt or messages"})
        yield "data: [DONE]\n\n"
        return

    msgs_for_store = []
    if chat_req.messages:
        msgs_for_store = [m.dict() for m in chat_req.messages]
    elif chat_req.prompt:
        msgs_for_store = [{"role": "user", "content": chat_req.prompt}]

    session_id = chat_req.resolved_user_id

    start = time.time()
    first_token_time = None
    thinking_chars = 0
    content_chars = 0
    sources_data = None
    full_content = ""
    full_thinking = ""

    try:
        async for ev in provider_mgr.stream(
            provider=provider_name,
            model=model_name,
            data=chat_req.prompt if not chat_req.messages else None,
            messages=[m.dict() for m in chat_req.messages] if chat_req.messages else None,
            system=chat_req.system,
            user_ip=client_ip,
            temperature=chat_req.temperature,
            max_tokens=chat_req.max_tokens,
        ):
            if first_token_time is None:
                first_token_time = time.time() - start

            if ev.kind == "sources":
                sources_data = ev.text
                try:
                    src_obj = json.loads(ev.text)
                except:
                    src_obj = {"raw": ev.text}
                # Nice SSE: event: sources
                yield _sse("sources", {"sources": src_obj.get("sources", []), "raw": src_obj})
            elif ev.kind == "thinking":
                full_thinking += ev.text
                thinking_chars += len(ev.text)
                yield _sse("thinking", {"content": ev.text})
            elif ev.kind == "content":
                full_content += ev.text
                content_chars += len(ev.text)
                yield _sse("content", {"content": ev.text})
            elif ev.kind == "done":
                break

        if msgs_for_store:
            for m in msgs_for_store:
                if m.get("role") == "user":
                    await session_store.append_user(session_id, m.get("content", "")[:MAX_PROMPT_LENGTH])
        if full_content:
            await session_store.append_assistant(session_id, full_content[:MAX_PROMPT_LENGTH*2])

        elapsed = time.time() - start
        tok_est = max(1, (thinking_chars + content_chars) // 4)
        tps = tok_est / elapsed if elapsed > 0 else 0

        yield _sse("done", {
            "usage": {
                "thinking_chars": thinking_chars,
                "content_chars": content_chars,
                "tokens_est": tok_est,
                "elapsed_s": round(elapsed, 3),
                "first_token_s": round(first_token_time, 3) if first_token_time else None,
                "tokens_per_s": round(tps, 1),
                "provider": provider_name,
                "model": model_name,
            },
            "sources": sources_data,
        })
        yield "data: [DONE]\n\n"

    except Exception as e:
        yield _sse("error", {"error": str(e)[:500], "provider": provider_name, "model": model_name})
        yield "data: [DONE]\n\n"


async def _openai_event_generator(request: Request, chat_req: ChatRequest) -> AsyncGenerator[str, None]:
    """OpenAI-compatible SSE: data: {choices: [{delta: {content}}]} + data: [DONE]"""
    provider_mgr = request.app.state.provider_manager
    client_ip = getattr(request.state, "client_ip", "unknown")

    provider_name = chat_req.provider
    model_name = chat_req.model

    if not provider_name and model_name:
        mi = global_registry.get(model_name)
        if mi:
            provider_name = mi.provider
    if not provider_name:
        provider_name = "ragsrv"
    if not model_name:
        prov_info = global_registry.get_provider(provider_name)
        model_name = prov_info.models[0] if prov_info and prov_info.models else "luna"

    if not chat_req.prompt and not chat_req.messages:
        yield _sse_data({"error": "Provide prompt or messages"})
        yield "data: [DONE]\n\n"
        return

    if chat_req.prompt:
        if not is_safe_prompt(chat_req.prompt):
            yield _sse_data({"error": "Prompt blocked by security filter", "blocked": True})
            yield "data: [DONE]\n\n"
            return
        chat_req.prompt = sanitize_prompt(chat_req.prompt)

    if chat_req.messages:
        try:
            validate_messages([m.dict() for m in chat_req.messages])
            for mm in chat_req.messages:
                content = mm.get("content", "") if isinstance(mm, dict) else getattr(mm, "content", "")
                if isinstance(content, str) and not is_safe_prompt(content):
                    yield _sse_data({"error": "Message blocked by security filter", "blocked": True})
                    yield "data: [DONE]\n\n"
                    return
        except ValueError as ve:
            yield _sse_data({"error": str(ve)})
            yield "data: [DONE]\n\n"
            return

    chat_id = f"chatcmpl-{int(time.time()*1000)}"
    created = int(time.time())

    try:
        async for ev in provider_mgr.stream(
            provider=provider_name,
            model=model_name,
            data=chat_req.prompt if not chat_req.messages else None,
            messages=[m.dict() for m in chat_req.messages] if chat_req.messages else None,
            system=chat_req.system,
            user_ip=client_ip,
            temperature=chat_req.temperature,
            max_tokens=chat_req.max_tokens,
        ):
            if ev.kind == "sources":
                try:
                    src_obj = json.loads(ev.text)
                except:
                    src_obj = {"sources": []}
                # OpenAI compat: include sources as extra field, also as event
                yield _sse_data({
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_name,
                    "provider": provider_name,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": None}],
                    "sources": src_obj.get("sources", []),
                })
            elif ev.kind == "thinking":
                yield _sse_data({
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_name,
                    "provider": provider_name,
                    "choices": [{"index": 0, "delta": {"reasoning_content": ev.text}, "finish_reason": None}],
                })
            elif ev.kind == "content":
                yield _sse_data({
                    "id": chat_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_name,
                    "provider": provider_name,
                    "choices": [{"index": 0, "delta": {"content": ev.text}, "finish_reason": None}],
                })

        yield _sse_data({
            "id": chat_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "provider": provider_name,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        })
        yield "data: [DONE]\n\n"
    except Exception as e:
        yield _sse_data({"error": str(e)[:500]})
        yield "data: [DONE]\n\n"


@router.post("/v1/chat/completions")
@router.post("/chat/completions")
async def chat_completions(request: Request, body: ChatRequest):
    sem: asyncio.Semaphore = request.app.state.server_semaphore
    if sem.locked() and sem._value == 0:
        try:
            await asyncio.wait_for(sem.acquire(), timeout=0.1)
            sem.release()
        except asyncio.TimeoutError:
            return JSONResponse(status_code=503, content={"error": "Server overloaded", "max_concurrency": SERVER_MAX_CONCURRENCY})

    return StreamingResponse(
        _openai_event_generator(request, body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )

@router.post("/v1/chat")
@router.post("/chat")
async def chat_native(request: Request, body: ChatRequest):
    sem: asyncio.Semaphore = request.app.state.server_semaphore
    if sem.locked() and sem._value == 0:
        try:
            await asyncio.wait_for(sem.acquire(), timeout=0.1)
            sem.release()
        except asyncio.TimeoutError:
            return JSONResponse(status_code=503, content={"error": "Server overloaded"})

    return StreamingResponse(
        _event_generator(request, body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )

@router.post("/v1/chat/completions-sync")
async def chat_sync(request: Request, body: ChatRequest):
    provider_mgr = request.app.state.provider_manager
    client_ip = getattr(request.state, "client_ip", "unknown")

    # Security checks — same as streaming endpoints
    if body.prompt:
        if not is_safe_prompt(body.prompt):
            return JSONResponse(status_code=400, content={"error": "Prompt blocked by security filter", "blocked": True})
        body.prompt = sanitize_prompt(body.prompt)

    if body.messages:
        try:
            validate_messages([m.dict() for m in body.messages])
            # Also check each message content for injection
            for mm in body.messages:
                content = mm.get("content", "") if isinstance(mm, dict) else getattr(mm, "content", "")
                if isinstance(content, str) and not is_safe_prompt(content):
                    return JSONResponse(status_code=400, content={"error": "Message blocked by security filter", "blocked": True})
        except ValueError as ve:
            return JSONResponse(status_code=422, content={"error": str(ve)})

    # Empty check
    if not body.prompt and not body.messages:
        return JSONResponse(status_code=422, content={"error": "Provide prompt or messages"})

    provider_name = body.provider or "ragsrv"
    if not body.provider and body.model:
        mi = global_registry.get(body.model)
        if mi:
            provider_name = mi.provider

    model_name = body.model or "luna"

    content_parts = []
    thinking_parts = []
    sources = None

    async for ev in provider_mgr.stream(
        provider=provider_name,
        model=model_name,
        data=body.prompt if not body.messages else None,
        messages=[m.dict() for m in body.messages] if body.messages else None,
        system=body.system,
        user_ip=client_ip,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
    ):
        if ev.kind == "content":
            content_parts.append(ev.text)
        elif ev.kind == "thinking":
            thinking_parts.append(ev.text)
        elif ev.kind == "sources":
            sources = ev.text

    return {
        "id": f"chatcmpl-{int(time.time()*1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name,
        "provider": provider_name,
        "choices": [{"message": {"role": "assistant", "content": "".join(content_parts)}, "finish_reason": "stop", "index": 0}],
        "thinking": "".join(thinking_parts),
        "sources": sources,
        "usage": {"prompt_tokens": 0, "completion_tokens": max(1, len("".join(content_parts))//4), "total_tokens": max(1, len("".join(content_parts))//4)},
    }
