"""
SessionStore — sharded, per-session lock, TTL, LRU, non-blocking
"""
from __future__ import annotations
import asyncio
import time
import uuid
import gc
import hashlib
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Any

from ..config import SERVER_SESSION_TTL, SERVER_MAX_SESSIONS, SERVER_SESSION_SHARDS

def _ts() -> float:
    return time.time()

def _rid(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"

@dataclass
class SessionState:
    user_id: str
    created_at: float = field(default_factory=_ts)
    updated_at: float = field(default_factory=_ts)
    system_prompt: str = "You are a helpful, fast, and precise assistant."
    model: str = "luna"
    provider: str = "ragsrv"
    messages: List[Dict[str, str]] = field(default_factory=list)
    request_count: int = 0
    last_response_id: Optional[str] = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def touch(self):
        self.updated_at = _ts()

    def append_user(self, content: str):
        self.messages.append({"role": "user", "content": content})
        self.touch()

    def append_assistant(self, content: str):
        self.messages.append({"role": "assistant", "content": content})
        # Keep last 40 messages (20 turns)
        sys_msgs = [m for m in self.messages if m.get("role") == "system"][:1]
        others = [m for m in self.messages if m.get("role") != "system"]
        self.messages = sys_msgs + others[-40:]
        self.touch()

class SessionStore:
    def __init__(self, ttl: int = SERVER_SESSION_TTL, max_sessions: int = SERVER_MAX_SESSIONS, shards: int = SERVER_SESSION_SHARDS):
        self._shards: List[Dict[str, SessionState]] = [dict() for _ in range(shards)]
        self._shard_locks: List[asyncio.Lock] = [asyncio.Lock() for _ in range(shards)]
        self._ttl = ttl
        self._max = max_sessions
        self._shards_count = shards

    def _shard_id(self, user_id: str) -> int:
        return int(hashlib.sha256(user_id.encode()).hexdigest(), 16) % self._shards_count

    async def get_or_create(self, user_id: Optional[str] = None) -> SessionState:
        if not user_id:
            user_id = _rid("usr")
        sid = self._shard_id(user_id)
        async with self._shard_locks[sid]:
            shard = self._shards[sid]
            state = shard.get(user_id)
            if state is None:
                state = SessionState(user_id=user_id)
                shard[user_id] = state
            state.touch()
            return state

    async def get(self, user_id: str) -> Optional[SessionState]:
        sid = self._shard_id(user_id)
        async with self._shard_locks[sid]:
            state = self._shards[sid].get(user_id)
            if state:
                state.touch()
            return state

    async def delete(self, user_id: str) -> bool:
        sid = self._shard_id(user_id)
        async with self._shard_locks[sid]:
            return self._shards[sid].pop(user_id, None) is not None

    async def clear(self) -> int:
        count = 0
        for i in range(self._shards_count):
            async with self._shard_locks[i]:
                count += len(self._shards[i])
                self._shards[i].clear()
        if count:
            gc.collect()
        return count

    async def prune(self) -> int:
        now = _ts()
        removed = 0
        for i in range(self._shards_count):
            async with self._shard_locks[i]:
                shard = self._shards[i]
                stale = [uid for uid, s in shard.items() if now - s.updated_at > self._ttl]
                for uid in stale:
                    shard.pop(uid, None)
                    removed += 1

        total = sum(len(s) for s in self._shards)
        if total > self._max:
            all_sess = []
            for i in range(self._shards_count):
                async with self._shard_locks[i]:
                    for uid, s in self._shards[i].items():
                        all_sess.append((s.updated_at, i, uid))
            all_sess.sort(key=lambda x: x[0])
            to_remove = total - self._max
            for _, shard_id, uid in all_sess[:to_remove]:
                async with self._shard_locks[shard_id]:
                    if self._shards[shard_id].pop(uid, None):
                        removed += 1

        if removed:
            gc.collect()
        return removed

    def stats_sync(self) -> Dict[str, Any]:
        total = sum(len(sh) for sh in self._shards)
        recent = []
        for sh in self._shards:
            recent.extend(sh.values())
        recent.sort(key=lambda s: s.updated_at, reverse=True)
        recent = recent[:10]
        return {
            "active_sessions": total,
            "shards": self._shards_count,
            "recent_sessions": [
                {"user_id": s.user_id, "provider": s.provider, "model": s.model, "requests": s.request_count, "updated_at": s.updated_at}
                for s in recent
            ],
        }

    async def stats(self) -> Dict[str, Any]:
        return self.stats_sync()

    def all_sessions_sync(self):
        total = 0
        lst = []
        for sh in self._shards:
            total += len(sh)
            for uid, s in sh.items():
                lst.append({"user_id": uid, "provider": s.provider, "model": s.model, "requests": s.request_count, "updated_at": s.updated_at})
        lst.sort(key=lambda x: x["updated_at"], reverse=True)
        return lst

    async def all_sessions(self) -> Dict[str, Any]:
        total = 0
        active = {}
        counts = {}
        for i in range(self._shards_count):
            async with self._shard_locks[i]:
                total += len(self._shards[i])
                for uid, s in self._shards[i].items():
                    active[uid] = {"last_response_id": s.last_response_id, "provider": s.provider, "model": s.model}
                    counts[uid] = s.request_count
        return {"total": total, "active_sessions": active, "request_counts": counts}

    async def append_user(self, user_id: str, content: str):
        state = await self.get_or_create(user_id)
        async with state.lock:
            state.append_user(content)

    async def append_assistant(self, user_id: str, content: str):
        state = await self.get(user_id)
        if not state:
            state = await self.get_or_create(user_id)
        async with state.lock:
            state.append_assistant(content)

    async def prune_expired(self):
        return await self.prune()
