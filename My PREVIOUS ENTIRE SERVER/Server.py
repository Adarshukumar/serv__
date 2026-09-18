# ══════════════════════════════════════════════════════════════
# Server.py — Local AI Server (local backends only)
# ══════════════════════════════════════════════════════════════
from __future__ import annotations
from datetime import datetime
import asyncio
import gc
import json
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional, Tuple

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field


# ═══════════════════════════════════════════════════════════
# §1 — PATH SETUP
# ═══════════════════════════════════════════════════════════
ROOT_DIR = Path(__file__).resolve().parent
API_DIR  = ROOT_DIR / "API"
if str(API_DIR) not in sys.path:
    sys.path.insert(0, str(API_DIR))

try:
    from Completion import Completion
    from Models     import ModelRegistry, Model
    from Client     import reset_client, get_client_async
except Exception as exc:
    Completion       = None
    ModelRegistry    = None
    Model            = None
    reset_client     = None
    get_client_async = None
    LOCAL_IMPORT_ERROR: Optional[Exception] = exc
else:
    LOCAL_IMPORT_ERROR = None


# ═══════════════════════════════════════════════════════════
# §2 — CONFIGURATION
# ═══════════════════════════════════════════════════════════
DEFAULT_LOCAL_MODEL  = os.getenv("LOCAL_DEFAULT_MODEL", "kimi-k2.5")
DEFAULT_SYSTEM       = os.getenv(
    "SERVER_SYSTEM_PROMPT",
    "You are a helpful, fast, and precise assistant.",
)

MAX_HISTORY_TURNS        = int(os.getenv("SERVER_MAX_HISTORY_TURNS",    "40"))
SESSION_TTL_SECONDS      = int(os.getenv("SERVER_SESSION_TTL_SECONDS",  "3600"))
CLEANUP_INTERVAL_SECONDS = int(os.getenv("SERVER_CLEANUP_SECONDS",      "300"))
WARMUP_INTERVAL_SECONDS  = int(os.getenv("SERVER_WARMUP_SECONDS",       "900"))
CRED_REFRESH_INTERVAL    = int(os.getenv("SERVER_CRED_REFRESH_SECONDS", "1800"))
MODEL_AUDIT_INTERVAL_SECONDS = int(os.getenv("SERVER_MODEL_AUDIT_SECONDS", "1800"))
GLOBAL_CONCURRENCY       = int(os.getenv("SERVER_MAX_CONCURRENCY",      "32"))
MAX_SESSIONS             = int(os.getenv("SERVER_MAX_SESSIONS",         "4096"))

WARMUP_PROMPT = os.getenv("SERVER_WARMUP_PROMPT", "Reply with one word: ok.")
MODEL_AUDIT_LIVE_PROBE = os.getenv("SERVER_MODEL_LIVE_PROBE", "0") == "1"
CLIENT_HEAVY_BOOT = os.getenv("SERVER_CLIENT_HEAVY_BOOT", "1") == "1"


# ═══════════════════════════════════════════════════════════
# §3 — UTILITIES
# ═══════════════════════════════════════════════════════════
def _ts() -> float:
    return time.time()


def _rid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _json_safe(data: Any) -> Any:
    if isinstance(data, dict):
        return {str(k): _json_safe(v) for k, v in data.items()}
    if isinstance(data, (list, tuple)):
        return [_json_safe(v) for v in data]
    if isinstance(data, (str, int, float, bool)) or data is None:
        return data
    return str(data)


def _sse(event: str, payload: Dict[str, Any]) -> str:
    return (
        f"event: {event}\n"
        f"data: {json.dumps(_json_safe(payload), ensure_ascii=False)}\n\n"
    )


def _content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if not isinstance(item, dict):
                continue
            kind = item.get("type")
            if kind in {"text", "input_text", "output_text"}:
                text = item.get("text") or item.get("content")
                if isinstance(text, str) and text:
                    parts.append(text)
            elif kind == "image_url":
                parts.append("[image]")
            elif kind == "input_audio":
                parts.append("[audio]")
        return "\n".join(parts)
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        if isinstance(content.get("content"), str):
            return content["content"]
    return str(content)


def _normalize_messages(
    messages: Optional[List[Dict[str, Any]]],
) -> List[Dict[str, str]]:
    normalized: List[Dict[str, str]] = []
    if not messages:
        return normalized
    for message in messages:
        if not isinstance(message, dict):
            continue
        role = str(message.get("role", "user")).strip() or "user"
        if role not in {"system", "user", "assistant", "developer", "tool"}:
            role = "user"
        normalized.append(
            {"role": role, "content": _content_to_text(message.get("content"))}
        )
    return normalized


def _history_trim(
    messages: List[Dict[str, str]], max_turns: int
) -> List[Dict[str, str]]:
    if max_turns <= 0:
        return messages
    sys_msg = [m for m in messages if m.get("role") == "system"][:1]
    others  = [m for m in messages if m.get("role") != "system"]
    return sys_msg + others[-(max_turns * 2):]


def _is_search_json(token: str) -> bool:
    if not token or not token.strip().startswith("{"):
        return False
    try:
        data = json.loads(token)
    except json.JSONDecodeError:
        return False
    return isinstance(data, dict) and "sources" in data


def _parse_search_sources(token: str) -> List[Dict[str, Any]]:
    try:
        data = json.loads(token)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, dict):
        return []
    sources = data.get("sources", [])
    if not isinstance(sources, list):
        return []
    return [
        {"title": item.get("title", "Untitled"), "url": item.get("url", "")}
        for item in sources
        if isinstance(item, dict)
    ]


def _merge_sources(
    existing: List[Dict[str, Any]],
    extra: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    seen = {item.get("url") for item in existing if isinstance(item, dict)}
    for item in extra:
        url = item.get("url")
        if url and url not in seen:
            existing.append(item)
            seen.add(url)
    return existing


def _model_to_api(model) -> Dict[str, Any]:
    """
    Convert a Models.Model object into the shape Interactive.py expects:
      { "id": str, "display": str, "owned_by": str, "capabilities": dict }
    """
    # Merge capabilities across all providers into a single dict
    merged_caps: Dict[str, bool] = {
        "reasoning":  False,
        "vision":     False,
        "search":     False,
        "attachment": False,
    }
    for caps in model.capabilities.values():
        for key, val in caps.items():
            if val:
                merged_caps[key] = True

    return {
        "id":           model.name,
        "display":      getattr(model, "display", model.name),
        "owned_by":     getattr(model, "family", "unknown"),
        "description":  getattr(model, "description", ""),
        "best":         model.best,
        "providers":    list(model.providers),
        "capabilities": merged_caps,
        "max_tokens":   getattr(model, "max_tokens", {}),
    }


# ═══════════════════════════════════════════════════════════
# §4 — SESSION LAYER
# ═══════════════════════════════════════════════════════════
@dataclass
class SessionState:
    user_id:          str
    created_at:       float = field(default_factory=_ts)
    updated_at:       float = field(default_factory=_ts)
    system_prompt:    str   = DEFAULT_SYSTEM
    model:            str   = DEFAULT_LOCAL_MODEL
    messages:         List[Dict[str, str]] = field(default_factory=list)
    request_count:    int   = 0
    last_response_id: Optional[str] = None
    lock:             asyncio.Lock  = field(default_factory=asyncio.Lock)

    def touch(self) -> None:
        self.updated_at = _ts()

    def append_user(self, content: str) -> None:
        self.messages.append({"role": "user", "content": content})
        self.touch()

    def append_assistant(self, content: str) -> None:
        self.messages.append({"role": "assistant", "content": content})
        self.messages = _history_trim(self.messages, MAX_HISTORY_TURNS)
        self.touch()


class SessionStore:
    def __init__(self) -> None:
        self._sessions: Dict[str, SessionState] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, user_id: Optional[str] = None) -> SessionState:
        async with self._lock:
            if not user_id:
                user_id = _rid("usr")
            state = self._sessions.get(user_id)
            if state is None:
                state = SessionState(user_id=user_id)
                self._sessions[user_id] = state
            state.touch()
            return state

    async def get(self, user_id: str) -> Optional[SessionState]:
        async with self._lock:
            state = self._sessions.get(user_id)
            if state:
                state.touch()
            return state

    async def delete(self, user_id: str) -> bool:
        async with self._lock:
            return self._sessions.pop(user_id, None) is not None

    async def clear(self) -> int:
        async with self._lock:
            count = len(self._sessions)
            self._sessions.clear()
        if count:
            gc.collect()
        return count

    async def prune(self) -> int:
        now     = _ts()
        removed = 0
        async with self._lock:
            stale = [
                uid
                for uid, s in self._sessions.items()
                if now - s.updated_at > SESSION_TTL_SECONDS
            ]
            for uid in stale:
                self._sessions.pop(uid, None)
                removed += 1

            if len(self._sessions) > MAX_SESSIONS:
                ordered    = sorted(self._sessions.values(), key=lambda s: s.updated_at)
                trim_count = len(self._sessions) - MAX_SESSIONS
                for state in ordered[:trim_count]:
                    self._sessions.pop(state.user_id, None)
                    removed += 1

        if removed:
            gc.collect()
        return removed

    async def stats(self) -> Dict[str, Any]:
        async with self._lock:
            active = len(self._sessions)
            recent = sorted(
                self._sessions.values(),
                key=lambda s: s.updated_at,
                reverse=True,
            )[:5]
            return {
                "active_sessions": active,
                "recent_sessions": [
                    {
                        "user_id":    s.user_id,
                        "model":      s.model,
                        "requests":   s.request_count,
                        "updated_at": s.updated_at,
                    }
                    for s in recent
                ],
            }

    async def all_sessions(self) -> Dict[str, Any]:
        """Return all active session IDs and their request counts."""
        async with self._lock:
            return {
                "total": len(self._sessions),
                "active_sessions": {
                    s.user_id: s.last_response_id
                    for s in self._sessions.values()
                },
                "request_counts": {
                    s.user_id: s.request_count
                    for s in self._sessions.values()
                },
            }


# ═══════════════════════════════════════════════════════════
# §5 — REQUEST / RESPONSE MODELS
# ═══════════════════════════════════════════════════════════
class ChatRequest(BaseModel):
    # Core fields — support both our own API and OpenAI-compatible clients
    user_id:           Optional[str]              = None
    user:              Optional[str]              = None   # OpenAI compat alias for user_id
    model:             Optional[str]              = None
    prompt:            Optional[str]              = None
    messages:          Optional[List[Dict[str, Any]]] = None
    system:            Optional[str]              = None
    stream:            bool                       = True
    search:            bool                       = False
    thinking:          Optional[bool]             = None
    temperature:       Optional[float]            = None
    max_output_tokens: Optional[int]              = None
    max_tokens:        Optional[int]              = None   # OpenAI compat alias
    clear_history:     bool                       = False

    def resolved_user_id(self) -> Optional[str]:
        return self.user_id or self.user

    def resolved_max_tokens(self) -> Optional[int]:
        return self.max_output_tokens or self.max_tokens


class ChatResult(BaseModel):
    ok:          bool            = True
    user_id:     str
    model:       str
    response_id: Optional[str]  = None
    content:     str            = ""
    reasoning:   str            = ""
    search:      Dict[str, Any] = Field(default_factory=dict)
    session:     Dict[str, Any] = Field(default_factory=dict)


# ═══════════════════════════════════════════════════════════
# §6 — LOCAL BACKEND
# ═══════════════════════════════════════════════════════════
class LocalBackend:
    name = "local"

    def __init__(self) -> None:
        if Completion is None:
            raise RuntimeError(
                f"Local backend unavailable — import error: {LOCAL_IMPORT_ERROR}"
            )

    def _resolve_model(self, request: ChatRequest) -> str:
        return (request.model or DEFAULT_LOCAL_MODEL).strip()

    def _resolve_provider(self, model: str) -> Optional[str]:
        if ModelRegistry is None:
            return None
        model_obj = ModelRegistry.get(model)
        return model_obj.best if model_obj else None

    async def refresh_credentials(self) -> Dict[str, Any]:
        if get_client_async is None:
            return {"ok": False, "reason": "client not available"}
        try:
            client = await get_client_async(heavy=CLIENT_HEAVY_BOOT)
            await client.preload_all(silent=True)
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}

        results: Dict[str, Any] = {}
        for provider_name in ("Mercury", "Upstage"):
            provider = client.providers.get(provider_name)
            if provider is None:
                continue
            try:
                if hasattr(provider, "connect") and getattr(provider, "_connected", False):
                    await provider.connect()
                    results[provider_name] = {"ok": True, "refreshed": True}
                else:
                    results[provider_name] = {"ok": True, "skipped": "not yet connected"}
            except Exception as exc:
                results[provider_name] = {"ok": False, "error": str(exc)}

        return {"ok": True, "providers": results}

    async def warmup(self) -> Dict[str, Any]:
        if get_client_async is None:
            return {"ok": False, "reason": "client not available"}

        try:
            client = await get_client_async(heavy=CLIENT_HEAVY_BOOT)
            provider_warmup = await client.warmup_all_providers(
                include_chat_probe=False,
                chat_prompt=WARMUP_PROMPT,
                silent=True,
            )
            return {
                "ok": provider_warmup.get("ok", False),
                "providers": provider_warmup,
                "client": client.snapshot(),
            }
        except Exception as exc:
            return {"ok": False, "reason": str(exc)}

    async def _live_probe_model(self, model_name: str) -> Dict[str, Any]:
        started = _ts()
        preview = ""
        try:
            async for token in Completion.achat(
                model=model_name,
                data=WARMUP_PROMPT,
                search=False,
                thinking=False,
                heavy=CLIENT_HEAVY_BOOT,
            ):
                preview = str(token).strip()
                if preview:
                    break
            return {
                "ok": True,
                "preview": preview[:80],
                "latency_ms": round((_ts() - started) * 1000, 2),
            }
        except Exception as exc:
            return {
                "ok": False,
                "error": str(exc),
                "latency_ms": round((_ts() - started) * 1000, 2),
            }

    async def audit_models(self) -> Dict[str, Any]:
        if ModelRegistry is None:
            return {"ok": False, "reason": "ModelRegistry not available"}
        if get_client_async is None:
            return {"ok": False, "reason": "client not available"}

        client = await get_client_async(heavy=CLIENT_HEAVY_BOOT)
        await client.preload_all(silent=True)

        model_rows: List[Dict[str, Any]] = []
        ok_count = 0

        for model in ModelRegistry.all():
            expected_provider = model.best if model.best in model.providers else None
            if expected_provider is None and model.providers:
                expected_provider = model.providers[0]

            issues: List[str] = []
            if not model.providers:
                issues.append("no providers")
            if expected_provider and expected_provider not in client.providers:
                issues.append(f"provider not loaded: {expected_provider}")
            if expected_provider and not model.connection.get(expected_provider):
                issues.append(f"missing connection: {expected_provider}")
            if expected_provider and model.working.get(expected_provider) is False:
                issues.append(f"marked not working: {expected_provider}")

            row: Dict[str, Any] = {
                "model": model.name,
                "best": model.best,
                "tested_provider": expected_provider,
                "providers": list(model.providers),
                "ok": len(issues) == 0,
            }

            if issues:
                row["issues"] = issues
            elif MODEL_AUDIT_LIVE_PROBE:
                row["live_probe"] = await self._live_probe_model(model.name)
                row["ok"] = bool(row["live_probe"].get("ok"))

            if row["ok"]:
                ok_count += 1
            model_rows.append(row)

        return {
            "ok": ok_count == len(model_rows),
            "total": len(model_rows),
            "healthy": ok_count,
            "live_probe": MODEL_AUDIT_LIVE_PROBE,
            "models": model_rows,
        }

    async def stream(
        self, request: ChatRequest, session: SessionState
    ) -> AsyncGenerator[Dict[str, Any], None]:
        model    = self._resolve_model(request)
        provider = self._resolve_provider(model)
        system   = request.system or session.system_prompt or DEFAULT_SYSTEM
        max_tok  = request.resolved_max_tokens()

        # Build message list
        if request.messages:
            messages: List[Dict[str, str]] = (
                [{"role": "system", "content": system}] if system else []
            )
            messages.extend(_normalize_messages(request.messages))
        else:
            messages = []
            if system:
                messages.append({"role": "system", "content": system})
            messages.extend(_history_trim(session.messages, MAX_HISTORY_TURNS))
            if request.prompt:
                messages.append({"role": "user", "content": request.prompt})

        sources: List[Dict[str, Any]] = []
        if request.search:
            yield {
                "type":    "search",
                "status":  "requested",
                "query":   request.prompt or (
                    _content_to_text(request.messages[-1].get("content"))
                    if request.messages else ""
                ),
                "sources": [],
            }

        reasoning_mode   = False
        buffer           = ""
        text_parts:      List[str] = []
        reasoning_parts: List[str] = []

        async for token in Completion.achat(
            model=model,
            messages=messages,
            provider=provider,
            system=system,
            temperature=request.temperature,
            max_tokens=max_tok,
            search=request.search,
            thinking=request.thinking,
        ):
            if not isinstance(token, str):
                token = str(token)

            # Intercept inline search-result JSON blobs
            if _is_search_json(token):
                extra   = _parse_search_sources(token)
                sources = _merge_sources(sources, extra)
                yield {
                    "type": "search",
                    "status": "found",
                    "query":   request.prompt or (
                    _content_to_text(request.messages[-1].get("content"))
                    if request.messages else ""
                    ),
                    "sources": sources}
                continue

            buffer += token

            # Parse <think>…</think> blocks inline
            while True:
                if not reasoning_mode:
                    start = buffer.find("<think>")
                    if start == -1:
                        if buffer:
                            text_parts.append(buffer)
                            yield {"type": "delta", "delta": buffer}
                            buffer = ""
                        break
                    if start > 0:
                        prefix = buffer[:start]
                        text_parts.append(prefix)
                        yield {"type": "delta", "delta": prefix}
                    buffer         = buffer[start + len("<think>"):]
                    reasoning_mode = True
                    yield {"type": "reasoning_start"}
                    continue

                end = buffer.find("</think>")
                if end == -1:
                    if buffer:
                        reasoning_parts.append(buffer)
                        yield {"type": "reasoning", "delta": buffer}
                        buffer = ""
                    break
                if end > 0:
                    segment = buffer[:end]
                    reasoning_parts.append(segment)
                    yield {"type": "reasoning", "delta": segment}
                buffer         = buffer[end + len("</think>"):]
                reasoning_mode = False
                yield {"type": "reasoning_end"}

        # Flush remaining buffer
        if buffer:
            if reasoning_mode:
                reasoning_parts.append(buffer)
                yield {"type": "reasoning", "delta": buffer}
            else:
                text_parts.append(buffer)
                yield {"type": "delta", "delta": buffer}

        if request.search:
            yield {
                "type": "search",
                "status": "final",
                "query":   request.prompt or (
                    _content_to_text(request.messages[-1].get("content"))
                    if request.messages else ""
                    ),
                "sources": sources
            }

        yield {
            "type":        "done",
            "response_id": None,
            "content":     "".join(text_parts),
            "reasoning":   "".join(reasoning_parts),
            "search":      {"enabled": request.search, "sources": sources},
        }


# ═══════════════════════════════════════════════════════════
# §7 — CHAT SERVICE
# ═══════════════════════════════════════════════════════════
class ChatService:
    def __init__(self) -> None:
        self.sessions  = SessionStore()
        self.semaphore = asyncio.Semaphore(GLOBAL_CONCURRENCY)
        self.local: Optional[LocalBackend] = (
            LocalBackend() if Completion is not None else None
        )
        self._last_warmup: Dict[str, Any] = {
            "ok": False,
            "at": None,
            "result": {"reason": "not started"},
        }
        self._last_model_audit: Dict[str, Any] = {
            "ok": False,
            "at": None,
            "result": {"reason": "not started"},
        }

    def _prepare_session(
        self, request: ChatRequest, session: SessionState
    ) -> None:
        if request.system:
            session.system_prompt = request.system
        if request.model:
            session.model = request.model
        session.touch()

    def _validate_model(self, model: str) -> None:
        """
        Validate model exists in registry.
        If ModelRegistry is unavailable, skip validation so the backend
        can still attempt the request.
        """
        if ModelRegistry is not None and ModelRegistry.get(model) is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"Unknown model: '{model}'. "
                    f"Use GET /v1/models to see available models."
                ),
            )

    async def internals_models(self) -> Dict[str, Any]:
        if ModelRegistry is None:
            return {
                "server": "Adarsh v1",
                "version": "1.0.0",
                "timestamp": int(time.time()),
                "generated_at": datetime.now().isoformat(),
                "total_models": 0,
                "total_families": 0,
                "families": [],
            }

        return ModelRegistry.family_payload(
            server="Adarsh v1",
            version="1.0.0",
        )

    async def run_stream(
        self, request: ChatRequest
    ) -> Tuple[SessionState, AsyncGenerator[Dict[str, Any], None]]:
        if self.local is None:
            raise HTTPException(
                status_code=503,
                detail=(
                    "Local backend is unavailable — project modules failed to import. "
                    f"Error: {LOCAL_IMPORT_ERROR}"
                ),
            )

        resolved_uid = request.resolved_user_id()
        session      = await self.sessions.get_or_create(resolved_uid)
        self._prepare_session(request, session)

        model = request.model or session.model or DEFAULT_LOCAL_MODEL
        self._validate_model(model)
        session.model = model

        if request.clear_history:
            session.messages.clear()

        current_user_text = request.prompt or (
            _content_to_text(request.messages[-1].get("content"))
            if request.messages else ""
        )
        if not current_user_text and not request.messages:
            raise HTTPException(
                status_code=400,
                detail="Provide at least one of: 'prompt' or 'messages'.",
            )

        async def generator() -> AsyncGenerator[Dict[str, Any], None]:
            result = ChatResult(
                ok=True,
                user_id=session.user_id,
                model=model,
                session={
                    "created_at":    session.created_at,
                    "updated_at":    session.updated_at,
                    "request_count": session.request_count,
                },
            )

            async with self.semaphore, session.lock:
                session.request_count += 1
                session.touch()
                if current_user_text:
                    session.append_user(current_user_text)

                yield {
                    "type":          "session",
                    "user_id":       session.user_id,
                    "model":         model,
                    "request_count": session.request_count,
                }

                if request.search:
                    yield {
                        "type":    "search",
                        "status":  "queued",
                        "query":   current_user_text,
                        "sources": [],
                    }

                try:
                    async for event in self.local.stream(request, session):
                        etype = event.get("type", "delta")
                        if etype == "delta":
                            result.content  += event.get("delta", "")
                        elif etype == "reasoning":
                            result.reasoning += event.get("delta", "")
                        elif etype == "search":
                            result.search = event
                        elif etype == "done":
                            result.response_id = event.get("response_id")
                            result.content     = event.get("content",   result.content)
                            result.reasoning   = event.get("reasoning", result.reasoning)
                            result.search      = event.get("search",    result.search)
                        yield event

                    session.append_assistant(result.content)
                    result.session.update({
                        "updated_at":       session.updated_at,
                        "request_count":    session.request_count,
                        "last_response_id": session.last_response_id,
                    })

                except HTTPException as exc:
                    yield {"type": "error", "status": exc.status_code, "detail": exc.detail}
                    return
                except Exception as exc:
                    yield {"type": "error", "status": 500, "detail": str(exc)}
                    return

            yield {"type": "summary", "payload": result.model_dump()}

        return session, generator()

    async def run_json(self, request: ChatRequest) -> Dict[str, Any]:
        session, stream = await self.run_stream(request)
        last_payload: Optional[Dict[str, Any]] = None

        async for event in stream:
            if event.get("type") == "error":
                raise HTTPException(
                    status_code=int(event.get("status", 500)),
                    detail=str(event.get("detail", "Unknown error")),
                )
            if event.get("type") == "summary":
                last_payload = event.get("payload")

        if last_payload is not None:
            return last_payload

        return {
            "ok":        True,
            "user_id":   session.user_id,
            "model":     session.model,
            "content":   "",
            "reasoning": "",
            "search":    {"enabled": request.search, "sources": []},
            "session": {
                "created_at":    session.created_at,
                "updated_at":    session.updated_at,
                "request_count": session.request_count,
            },
        }

    # ── Background helpers ────────────────────────────
    async def cleanup(self) -> Dict[str, Any]:
        removed = await self.sessions.prune()
        stats   = await self.sessions.stats()
        if self.local and reset_client and stats["active_sessions"] == 0:
            try:
                await reset_client()
            except Exception:
                pass
        return {"removed_sessions": removed, "stats": stats}

    async def warmup(self) -> Dict[str, Any]:
        if self.local is None:
            result = {"ok": False, "reason": "local backend not available"}
        else:
            result = await self.local.warmup()
        self._last_warmup = {"ok": bool(result.get("ok")), "at": _ts(), "result": result}
        return result

    async def model_audit(self) -> Dict[str, Any]:
        if self.local is None:
            result = {"ok": False, "reason": "local backend not available"}
        else:
            result = await self.local.audit_models()
        self._last_model_audit = {
            "ok": bool(result.get("ok")),
            "at": _ts(),
            "result": result,
        }
        return result

    async def refresh_credentials(self) -> Dict[str, Any]:
        if self.local is None:
            return {"ok": True, "skipped": "local backend not available"}
        return await self.local.refresh_credentials()

    def background_status(self) -> Dict[str, Any]:
        return {
            "warmup": self._last_warmup,
            "model_audit": self._last_model_audit,
        }

    async def models(self) -> Dict[str, Any]:
        """
        Return models in the shape Interactive.py expects:
          { "data": [ { "id", "display", "owned_by", "capabilities", ... } ] }
        """
        if ModelRegistry is None:
            return {"data": []}
        return {
            "data": [_model_to_api(m) for m in ModelRegistry.all()]
        }


# ═══════════════════════════════════════════════════════════
# §8 — BACKGROUND LOOP
# ═══════════════════════════════════════════════════════════
async def _wait_or_stop(stop_event: asyncio.Event, timeout: float) -> bool:
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=max(0.1, timeout))
        return True
    except asyncio.TimeoutError:
        return False


async def _main_runtime_loop(
    stop_event: asyncio.Event,
    service: ChatService,
) -> None:
    next_cleanup = _ts()
    next_refresh = _ts()

    while not stop_event.is_set():
        now = _ts()

        if now >= next_cleanup:
            try:
                await service.cleanup()
            except Exception as exc:
                print(f"[background:cleanup] error: {exc}", flush=True)
            next_cleanup = now + float(CLEANUP_INTERVAL_SECONDS)

        if now >= next_refresh:
            try:
                await service.refresh_credentials()
            except Exception as exc:
                print(f"[background:cred-refresh] error: {exc}", flush=True)
            next_refresh = now + float(CRED_REFRESH_INTERVAL)

        next_tick = min(next_cleanup, next_refresh)
        if await _wait_or_stop(stop_event, max(1.0, next_tick - _ts())):
            return


async def _side_runtime_loop(
    stop_event: asyncio.Event,
    service: ChatService,
) -> None:
    next_warmup = _ts()
    next_audit = _ts()

    while not stop_event.is_set():
        now = _ts()

        if now >= next_warmup:
            try:
                await service.warmup()
            except Exception as exc:
                print(f"[background:warmup] error: {exc}", flush=True)
            next_warmup = now + float(WARMUP_INTERVAL_SECONDS)

        if now >= next_audit:
            try:
                await service.model_audit()
            except Exception as exc:
                print(f"[background:model-audit] error: {exc}", flush=True)
            next_audit = now + float(MODEL_AUDIT_INTERVAL_SECONDS)

        next_tick = min(next_warmup, next_audit)
        if await _wait_or_stop(stop_event, max(1.0, next_tick - _ts())):
            return


_SERVER_START_TS: float = _ts()   # set at import time as ultimate fallback
# ═══════════════════════════════════════════════════════════
# §9 — LIFESPAN
# ═══════════════════════════════════════════════════════════
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Record start time RIGHT HERE — before anything else
    app.state.start_ts = _ts()

    service = ChatService()
    stop    = asyncio.Event()

    app.state.service = service
    app.state.stop    = stop

    tasks = [
        asyncio.create_task(_main_runtime_loop(stop, service)),
        asyncio.create_task(_side_runtime_loop(stop, service)),
    ]
    app.state.tasks = tasks

    try:
        yield
    finally:
        stop.set()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if reset_client:
            try:
                await reset_client()
            except Exception:
                pass

# ═══════════════════════════════════════════════════════════
# §10 — FASTAPI APP
# ═══════════════════════════════════════════════════════════
app = FastAPI(
    title="Local AI Server",
    version="2.0.0",
    description=(
        "FastAPI server backed by local AI providers — streaming, search, "
        "reasoning, per-user sessions, and automatic credential refresh."
    ),
    lifespan=lifespan,
)


# ── Root / health ──────────────────────────────────────────
@app.get("/")
async def root() -> Dict[str, Any]:
    return {
        "ok":          True,
        "name":        "Local AI Server",
        "local_ready": Completion is not None,
        "docs":        "/docs",
        "health":      "/health",
    }


@app.get("/health")
async def health() -> Dict[str, Any]:
    service: ChatService = app.state.service

    # Safely read start_ts — fall back to module-level constant
    start_ts = getattr(app.state, "start_ts", _SERVER_START_TS)

    stats = await service.sessions.stats()

    # Count total requests safely
    total_reqs = sum(
        s.get("requests", 0) for s in stats.get("recent_sessions", [])
    )

    # Provider health — only populated if providers expose it
    background = service.background_status()
    provider_health: Dict[str, bool] = {}
    warmup_result = background.get("warmup", {}).get("result", {})
    warmup_details = warmup_result.get("providers", {}).get("results", {})
    if isinstance(warmup_details, dict):
        for provider_name, detail in warmup_details.items():
            if isinstance(detail, dict):
                provider_health[provider_name] = bool(detail.get("ok"))

    return {
        "ok":               True,
        "status":           "ok",
        "local_ready":      service.local is not None,
        "uptime_seconds":   round(_ts() - start_ts, 1),
        "total_requests":   total_reqs,
        "active_sessions":  stats["active_sessions"],
        "models_count":     len(ModelRegistry.all()) if ModelRegistry else 0,
        "last_health_check": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "provider_health":  provider_health,
        "background":       background,
        "sessions":         stats,
        "config": {
            "default_local_model":     DEFAULT_LOCAL_MODEL,
            "max_concurrency":         GLOBAL_CONCURRENCY,
            "cred_refresh_interval_s": CRED_REFRESH_INTERVAL,
            "cleanup_interval_s":      CLEANUP_INTERVAL_SECONDS,
            "warmup_interval_s":       WARMUP_INTERVAL_SECONDS,
            "model_audit_interval_s":  MODEL_AUDIT_INTERVAL_SECONDS,
            "model_live_probe":        MODEL_AUDIT_LIVE_PROBE,
            "client_heavy_boot":       CLIENT_HEAVY_BOOT,
        },
    }


# ── Models ─────────────────────────────────────────────────
@app.get("/v1/models")
async def list_models() -> Dict[str, Any]:
    """
    Returns model list in the shape Interactive.py expects:
      { "data": [ { "id", "display", "owned_by", "capabilities", ... } ] }
    """
    service: ChatService = app.state.service
    return await service.models()

@app.get("/internal/v1/models")
async def internals_models() -> Dict[str, Any]:
    service: ChatService = app.state.service
    return await service.internals_models()



# ── Sessions ───────────────────────────────────────────────
@app.get("/v1/sessions/{user_id}")
async def get_session(user_id: str) -> Dict[str, Any]:
    service: ChatService = app.state.service
    session = await service.sessions.get(user_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found.")
    return {
        "user_id":          session.user_id,
        "created_at":       session.created_at,
        "updated_at":       session.updated_at,
        "system_prompt":    session.system_prompt,
        "model":            session.model,
        "request_count":    session.request_count,
        "last_response_id": session.last_response_id,
        "messages":         session.messages[-(MAX_HISTORY_TURNS * 2):],
    }


@app.delete("/v1/sessions/{user_id}")
async def delete_session(user_id: str) -> Dict[str, Any]:
    service: ChatService = app.state.service
    deleted = await service.sessions.delete(user_id)
    return {"ok": True, "deleted": deleted, "user_id": user_id}


@app.post("/v1/session/reset")
async def reset_all_sessions() -> Dict[str, Any]:
    service: ChatService = app.state.service
    removed = await service.sessions.clear()
    return {"ok": True, "removed_sessions": removed}


# ── Active users (Interactive.py /users command) ───────────
@app.get("/v1/users")
async def active_users() -> Dict[str, Any]:
    service: ChatService = app.state.service
    return await service.sessions.all_sessions()


# ── Admin ──────────────────────────────────────────────────
@app.post("/v1/warmup")
async def warmup_now() -> Dict[str, Any]:
    service: ChatService = app.state.service
    return await service.warmup()


@app.post("/v1/credentials/refresh")
async def credentials_refresh() -> Dict[str, Any]:
    service: ChatService = app.state.service
    return await service.refresh_credentials()


# ── Chat (native SSE endpoint) ─────────────────────────────
@app.post("/v1/chat")
async def chat(request: ChatRequest):
    service: ChatService = app.state.service

    if request.stream:
        _, stream = await service.run_stream(request)

        async def event_stream() -> AsyncGenerator[str, None]:
            try:
                async for chunk in stream:
                    yield _sse(chunk.get("type", "message"), chunk)
            except HTTPException as exc:
                yield _sse("error", {"status": exc.status_code, "detail": exc.detail})
            except Exception as exc:
                yield _sse("error", {"status": 500, "detail": str(exc)})

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    payload = await service.run_json(request)
    return JSONResponse(payload)


# ── Chat completions (OpenAI-compatible endpoint for Interactive.py) ──
@app.post("/v1/chat/completions")
async def chat_completions(request: ChatRequest):
    """
    OpenAI-compatible endpoint consumed by Interactive.py.
    Streams SSE in the shape:
      data: {"choices": [{"delta": {"content": "..."}, "finish_reason": null}]}
      data: [DONE]
    """
    service: ChatService = app.state.service

    if request.stream:
        _, stream = await service.run_stream(request)

        async def openai_stream() -> AsyncGenerator[str, None]:
            try:
                async for chunk in stream:
                    etype = chunk.get("type", "")

                    # Search results → custom type Interactive.py handles
                    if etype == "search" and chunk.get("status") == "final":
                        sources = chunk.get("sources", [])
                        if sources:
                            yield (
                                f"data: {json.dumps({'type': 'search_results', 'sources': sources})}\n\n"
                            )
                        continue

                    # Text delta → OpenAI choice format
                    if etype == "delta":
                        payload = {
                            "choices": [{
                                "delta":         {"content": chunk.get("delta", "")},
                                "finish_reason": None,
                                "index":         0,
                            }]
                        }
                        yield f"data: {json.dumps(payload)}\n\n"
                        continue

                    # Reasoning delta — surface as a delta too so client sees it
                    if etype == "reasoning":
                        payload = {
                            "choices": [{
                                "delta":         {"content": chunk.get("delta", "")},
                                "finish_reason": None,
                                "index":         0,
                            }]
                        }
                        yield f"data: {json.dumps(payload)}\n\n"
                        continue

                    # Stream done
                    if etype == "done":
                        stop_payload = {
                            "choices": [{
                                "delta":         {},
                                "finish_reason": "stop",
                                "index":         0,
                            }]
                        }
                        yield f"data: {json.dumps(stop_payload)}\n\n"
                        yield "data: [DONE]\n\n"
                        return

                    # Error
                    if etype == "error":
                        err = {"error": {"message": chunk.get("detail", "Unknown error")}}
                        yield f"data: {json.dumps(err)}\n\n"
                        yield "data: [DONE]\n\n"
                        return

            except HTTPException as exc:
                err = {"error": {"message": exc.detail, "code": exc.status_code}}
                yield f"data: {json.dumps(err)}\n\n"
                yield "data: [DONE]\n\n"
            except Exception as exc:
                err = {"error": {"message": str(exc)}}
                yield f"data: {json.dumps(err)}\n\n"
                yield "data: [DONE]\n\n"

        return StreamingResponse(openai_stream(), media_type="text/event-stream")

    # Non-streaming JSON response
    result = await service.run_json(request)
    return JSONResponse({
        "choices": [{
            "message":      {"role": "assistant", "content": result.get("content", "")},
            "finish_reason": "stop",
            "index":         0,
        }],
        "model":  result.get("model", DEFAULT_LOCAL_MODEL),
        "object": "chat.completion",
    })


@app.post("/v1/chat/stream")
async def chat_stream(request: ChatRequest):
    """Convenience alias — always streams."""
    request.stream = True
    return await chat(request)


# ── Status ─────────────────────────────────────────────────
@app.get("/v1/status")
async def status() -> Dict[str, Any]:
    service: ChatService = app.state.service
    session_stats = await service.sessions.stats()
    return {
        "ok":              True,
        "local_ready":     service.local is not None,
        "active_sessions": session_stats["active_sessions"],
        "default_model":   DEFAULT_LOCAL_MODEL,
    }


# ═══════════════════════════════════════════════════════════
# §11 — STARTUP HOOK (track server start time for /health)
# ═══════════════════════════════════════════════════════════
@app.on_event("startup")
async def _record_start() -> None:
    app.state.start_ts = _ts()


# ═══════════════════════════════════════════════════════════
# §12 — ENTRYPOINT
# ═══════════════════════════════════════════════════════════
def _main() -> None:
    import uvicorn
    uvicorn.run(
        "Server:app",
        host=os.getenv("SERVER_HOST",      "0.0.0.0"),
        port=int(os.getenv("SERVER_PORT",  "7860")),
        reload=os.getenv("SERVER_RELOAD",  "0") == "1",
        log_level=os.getenv("SERVER_LOG_LEVEL", "info"),
    )


if __name__ == "__main__":
    _main()
