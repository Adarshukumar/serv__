"""
═══ §3 — PER-USER LIMITS ════════════════════════════════════════════════════
Rate limiting keyed on the resolved client IP, with the global concurrency
semaphore the old server applied to *everything* (including warmup pings that
nobody asked for).

Also the right home for the thing the old server never had: a per-user ban
list, so one spammer cannot get the shared upstream IP blocked for everyone.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Dict, Optional


@dataclass
class Decision:
    allowed: bool
    remaining: int = 0
    retry_after: int = 0
    reason: str = ""


@dataclass
class _Bucket:
    hits: Deque[float] = field(default_factory=deque)
    blocked_until: float = 0.0


class RateLimiter:
    """Sliding-window counter per IP, plus manual bans. Single-event-loop safe."""

    def __init__(self, limit: int, window: int, *, max_keys: int = 100_000) -> None:
        self.limit = max(0, int(limit))
        self.window = max(1, int(window))
        self.max_keys = max_keys
        self._buckets: Dict[str, _Bucket] = {}
        self._banned: Dict[str, float] = {}     # ip -> expiry (0 = forever)
        self._lock = asyncio.Lock()

    # ── counting ────────────────────────────────────────────────────────
    async def check(self, ip: Optional[str], *, cost: int = 1) -> Decision:
        if self.limit <= 0:
            return Decision(True, 0, 0, "disabled")

        key = ip or "unknown"
        now = time.time()

        async with self._lock:
            self._gc(now)

            expiry = self._banned.get(key)
            if expiry is not None:
                if expiry == 0.0 or expiry > now:
                    wait = 0 if expiry == 0.0 else int(expiry - now)
                    return Decision(False, 0, max(1, wait), "banned")
                self._banned.pop(key, None)

            bucket = self._buckets.setdefault(key, _Bucket())
            cutoff = now - self.window
            while bucket.hits and bucket.hits[0] <= cutoff:
                bucket.hits.popleft()

            if len(bucket.hits) + cost > self.limit:
                # cost>limit would deadlock the bucket, so clamp it
                if cost > self.limit:
                    bucket.hits.clear()
                retry = int(bucket.hits[0] + self.window - now) + 1 if bucket.hits else 1
                return Decision(False, 0, max(1, retry), "rate_limited")

            for _ in range(cost):
                bucket.hits.append(now)
            return Decision(True, max(0, self.limit - len(bucket.hits)), 0, "")

    # ── bans ────────────────────────────────────────────────────────────
    async def ban(self, ip: str, seconds: int = 0) -> None:
        async with self._lock:
            self._banned[ip or "unknown"] = (time.time() + seconds) if seconds else 0.0

    async def unban(self, ip: str) -> bool:
        async with self._lock:
            return self._banned.pop(ip or "unknown", None) is not None

    # ── housekeeping ────────────────────────────────────────────────────
    def _gc(self, now: float) -> None:
        # callers hold the lock
        for key in [k for k, b in self._buckets.items() if not b.hits]:
            self._buckets.pop(key, None)
        for key, exp in list(self._banned.items()):
            if exp and exp <= now:
                self._banned.pop(key, None)
        if len(self._buckets) > self.max_keys:
            for key in list(self._buckets)[: len(self._buckets) - self.max_keys]:
                self._buckets.pop(key, None)

    async def snapshot(self) -> dict:
        async with self._lock:
            return {
                "limit": self.limit,
                "window_seconds": self.window,
                "tracked_ips": len(self._buckets),
                "banned_ips": len(self._banned),
            }
