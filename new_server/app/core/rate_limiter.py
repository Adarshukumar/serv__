"""
Rate Limiter — sharded, non-blocking, provider-based
"""
from __future__ import annotations
import time
import asyncio
from collections import defaultdict
from typing import Dict, List, Tuple
from dataclasses import dataclass
import hashlib

class ShardedIPRateLimiter:
    """Sharded per-IP limiter — less contention than single dict + lock"""
    def __init__(self, rpm: int = 60, shards: int = 16):
        self.rpm = rpm
        self.shards = shards
        self._buckets: List[Dict[str, List[float]]] = [defaultdict(list) for _ in range(shards)]
        self._locks: List[asyncio.Lock] = [asyncio.Lock() for _ in range(shards)]

    def _shard_id(self, ip: str) -> int:
        return int(hashlib.sha256(ip.encode()).hexdigest(), 16) % self.shards

    async def is_allowed(self, ip: str) -> Tuple[bool, int]:
        sid = self._shard_id(ip)
        async with self._locks[sid]:
            now = time.time()
            bucket = self._buckets[sid][ip]
            cutoff = now - 60
            while bucket and bucket[0] < cutoff:
                bucket.pop(0)
            if len(bucket) >= self.rpm:
                retry_after = int(60 - (now - bucket[0])) + 1
                return False, retry_after
            bucket.append(now)
            return True, self.rpm - len(bucket)

    def is_allowed_sync(self, ip: str) -> Tuple[bool, int]:
        # Sync version for middleware (no await)
        sid = self._shard_id(ip)
        # No lock in sync version — okay for middleware, slight race but acceptable
        now = time.time()
        bucket = self._buckets[sid][ip]
        cutoff = now - 60
        while bucket and bucket[0] < cutoff:
            bucket.pop(0)
        if len(bucket) >= self.rpm:
            retry_after = int(60 - (now - bucket[0])) + 1
            return False, retry_after
        bucket.append(now)
        return True, self.rpm - len(bucket)

class ProviderRateLimiter:
    def __init__(self, rpm: int = 300):
        self.rpm = rpm
        self.buckets: Dict[str, List[float]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def is_allowed(self, provider: str = "global") -> Tuple[bool, int]:
        async with self._lock:
            now = time.time()
            bucket = self.buckets[provider]
            cutoff = now - 60
            while bucket and bucket[0] < cutoff:
                bucket.pop(0)
            if len(bucket) >= self.rpm:
                retry_after = int(60 - (now - bucket[0])) + 1
                return False, retry_after
            bucket.append(now)
            return True, 0

class CircuitBreaker:
    def __init__(self, fail_threshold: int = 3, cooldown: int = 60, cooldown_s: int = None):
        self.fail_threshold = fail_threshold
        self.cooldown = cooldown_s if cooldown_s is not None else cooldown
        self.fail_count = 0
        self.last_fail = 0.0
        self.open = False
        self._lock = asyncio.Lock()
        self.success_count = 0

    def can_try_sync(self) -> bool:
        if not self.open:
            return True
        if time.time() - self.last_fail > self.cooldown:
            self.open = False
            self.fail_count = 0
            return True
        return False

    async def can_try(self) -> bool:
        return self.can_try_sync()

    def record_success_sync(self):
        self.fail_count = 0
        self.open = False
        self.success_count += 1

    def record_failure_sync(self):
        self.fail_count += 1
        self.last_fail = time.time()
        if self.fail_count >= self.fail_threshold:
            self.open = True

    async def record_success(self):
        self.record_success_sync()

    async def record_failure(self):
        self.record_failure_sync()

    async def record_fail(self):
        self.record_failure_sync()

    def seconds_until_retry(self) -> int:
        if not self.open:
            return 0
        return max(0, int(self.cooldown - (time.time() - self.last_fail)))

    def stats(self):
        return {
            "open": self.open,
            "fail_count": self.fail_count,
            "success_count": self.success_count,
            "seconds_until_retry": self.seconds_until_retry(),
        }

    async def get_stats(self):
        return self.stats()

@dataclass
class ProviderHealth:
    name: str
    ok: bool
    latency_ms: float = 0
    last_check: float = 0
    fail_count: int = 0
    success_count: int = 0
    circuit_open: bool = False
