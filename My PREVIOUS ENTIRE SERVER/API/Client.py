from __future__ import annotations

import asyncio
import inspect
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Type

from providers import (
    DeepInfraProvider,
    DevsdoProvider,
    DolphinProvider,
    LLMChatProvider,
    MercuryProvider,
    UpstageProvider,
    mCloudFlareProvider,
)


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    cls: Type[Any]
    async_native: bool
    heavy_connect: bool = False


_PROVIDER_SPECS: List[ProviderSpec] = [
    ProviderSpec("DeepInfra", DeepInfraProvider, async_native=False),
    ProviderSpec("Dolphin", DolphinProvider, async_native=True),
    ProviderSpec("DevsDo", DevsdoProvider, async_native=True),
    ProviderSpec("Mercury", MercuryProvider, async_native=True, heavy_connect=True),
    ProviderSpec("LLMChat", LLMChatProvider, async_native=True),
    ProviderSpec("mCloudFlare", mCloudFlareProvider, async_native=False),
    ProviderSpec("Upstage", UpstageProvider, async_native=True, heavy_connect=True),
]

_PROVIDER_BY_NAME: Dict[str, ProviderSpec] = {spec.name: spec for spec in _PROVIDER_SPECS}


class Client:
    """
    Provider lifecycle manager.

    Modes:
        heavy=False: lazy provider loading
        heavy=True : eager load all providers, then run warmup checks
    """

    def __init__(self, heavy: bool = False):
        self.heavy = heavy

        self.providers: Dict[str, Any] = {}
        self._loading: Dict[str, asyncio.Task] = {}
        self._provider_locks: Dict[str, asyncio.Lock] = {
            name: asyncio.Lock() for name in _PROVIDER_BY_NAME
        }
        self._sync_lock = threading.Lock()

        self._initialized = False
        self._closed = False

        self._periodic_warmup_task: Optional[asyncio.Task] = None
        self._warmup_executor = ThreadPoolExecutor(
            max_workers=max(2, len(_PROVIDER_BY_NAME)),
            thread_name_prefix="provider-warmup",
        )

    @classmethod
    async def create(
        cls,
        heavy: bool = False,
        silent: bool = False,
        run_startup_warmup: bool = True,
    ) -> "Client":
        client = cls(heavy=heavy)
        await client.initialize(
            heavy=heavy,
            silent=silent,
            run_startup_warmup=run_startup_warmup,
        )
        return client

    async def initialize(
        self,
        heavy: Optional[bool] = None,
        silent: bool = False,
        run_startup_warmup: bool = True,
    ) -> None:
        if self._closed:
            raise RuntimeError("Client is closed")

        if heavy is not None:
            self.heavy = heavy

        if self.heavy:
            await self.preload_all(silent=silent)
            if run_startup_warmup:
                await self.warmup_all_providers(silent=silent)

        self._initialized = True

    def _get_spec(self, name: str) -> ProviderSpec:
        spec = _PROVIDER_BY_NAME.get(name)
        if spec is None:
            raise ValueError(f"Unknown provider: {name}")
        return spec

    async def _connect_provider(self, provider: Any, name: str) -> None:
        connect = getattr(provider, "connect", None)
        if not callable(connect):
            return

        if inspect.iscoroutinefunction(connect):
            await connect()
            return

        await asyncio.to_thread(connect)

    async def _load_provider_async(self, name: str, silent: bool = True) -> Any:
        if self._closed:
            raise RuntimeError("Client is closed")

        spec = self._get_spec(name)

        lock = self._provider_locks[name]
        async with lock:
            if name in self.providers:
                return self.providers[name]

            if not silent:
                print(f"[client] loading provider: {name}", flush=True)

            provider = await asyncio.to_thread(spec.cls)

            try:
                await self._connect_provider(provider, name)
            except Exception:
                # Keep provider usable even if optional connect fails.
                pass

            self.providers[name] = provider

            if not silent:
                print(f"[client] provider ready: {name}", flush=True)

            return provider

    def _load_provider_sync(self, name: str) -> Any:
        if self._closed:
            raise RuntimeError("Client is closed")

        spec = self._get_spec(name)

        with self._sync_lock:
            cached = self.providers.get(name)
            if cached is not None:
                return cached

            provider = spec.cls()
            self.providers[name] = provider
            return provider

    async def preload_all(self, silent: bool = False) -> Dict[str, Any]:
        names = [spec.name for spec in _PROVIDER_SPECS]
        tasks = [self.get_provider_async(name, show_progress=not silent) for name in names]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        summary: Dict[str, Any] = {}
        for name, result in zip(names, results):
            if isinstance(result, Exception):
                summary[name] = {"ok": False, "error": str(result)}
            else:
                summary[name] = {"ok": True}
        return summary

    @staticmethod
    def _run_maybe_async_call(fn: Any) -> Any:
        result = fn()
        if inspect.isawaitable(result):
            return asyncio.run(result)
        return result

    def _probe_provider_thread(
        self,
        name: str,
        include_chat_probe: bool,
        chat_prompt: str,
    ) -> Dict[str, Any]:
        started = time.perf_counter()
        provider = self.providers.get(name)

        if provider is None:
            return {
                "provider": name,
                "ok": False,
                "error": "not loaded",
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
            }

        details: Dict[str, Any] = {}

        available_models = getattr(provider, "available_models", None)
        if callable(available_models):
            try:
                models = available_models()
                if isinstance(models, (list, tuple, set)):
                    details["model_count"] = len(models)
            except Exception as exc:
                details["model_list_error"] = str(exc)

        health = getattr(provider, "health", None)
        if callable(health):
            try:
                details["health"] = self._run_maybe_async_call(health)
            except Exception as exc:
                details["health_error"] = str(exc)

        if include_chat_probe:
            details["chat_probe"] = self._chat_probe(provider, chat_prompt)

        latency_ms = round((time.perf_counter() - started) * 1000, 2)
        details["latency_ms"] = latency_ms
        details["provider"] = name
        details["ok"] = "health_error" not in details and "error" not in details
        return details

    def _chat_probe(self, provider: Any, prompt: str) -> Dict[str, Any]:
        chat = getattr(provider, "chat", None)
        if not callable(chat):
            return {"ok": False, "error": "chat method missing"}

        started = time.perf_counter()

        try:
            if inspect.iscoroutinefunction(chat):
                async def _probe_async() -> str:
                    agen = chat(data=prompt)
                    async for token in agen:
                        token_text = str(token).strip()
                        if token_text:
                            return token_text
                    return ""

                token = asyncio.run(asyncio.wait_for(_probe_async(), timeout=10.0))
            else:
                token = ""
                for item in chat(data=prompt):
                    token = str(item).strip()
                    if token:
                        break

            return {
                "ok": True,
                "preview": token[:80],
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
            }
        except Exception as exc:
            return {
                "ok": False,
                "error": str(exc),
                "latency_ms": round((time.perf_counter() - started) * 1000, 2),
            }

    async def warmup_all_providers(
        self,
        include_chat_probe: bool = False,
        chat_prompt: str = "Reply with one word: ok.",
        silent: bool = False,
    ) -> Dict[str, Any]:
        await self.preload_all(silent=silent)

        loop = asyncio.get_running_loop()
        names = [spec.name for spec in _PROVIDER_SPECS]

        futures = [
            loop.run_in_executor(
                self._warmup_executor,
                self._probe_provider_thread,
                name,
                include_chat_probe,
                chat_prompt,
            )
            for name in names
        ]

        results_raw = await asyncio.gather(*futures, return_exceptions=True)

        results: Dict[str, Any] = {}
        ok_count = 0
        for name, item in zip(names, results_raw):
            if isinstance(item, Exception):
                results[name] = {"provider": name, "ok": False, "error": str(item)}
            else:
                results[name] = item
                if item.get("ok"):
                    ok_count += 1

        return {
            "ok": ok_count == len(names),
            "total": len(names),
            "healthy": ok_count,
            "results": results,
        }

    async def _periodic_warmup_loop(
        self,
        interval_seconds: int,
        include_chat_probe: bool,
        chat_prompt: str,
        silent: bool,
    ) -> None:
        while not self._closed:
            try:
                await asyncio.sleep(max(5, interval_seconds))
                if self._closed:
                    break
                await self.warmup_all_providers(
                    include_chat_probe=include_chat_probe,
                    chat_prompt=chat_prompt,
                    silent=silent,
                )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                if not silent:
                    print(f"[client] periodic warmup error: {exc}", flush=True)

    def start_periodic_warmup(
        self,
        interval_seconds: int = 1800,
        include_chat_probe: bool = False,
        chat_prompt: str = "Reply with one word: ok.",
        silent: bool = True,
    ) -> None:
        if self._periodic_warmup_task and not self._periodic_warmup_task.done():
            return
        self._periodic_warmup_task = asyncio.create_task(
            self._periodic_warmup_loop(
                interval_seconds=interval_seconds,
                include_chat_probe=include_chat_probe,
                chat_prompt=chat_prompt,
                silent=silent,
            )
        )

    async def stop_periodic_warmup(self) -> None:
        task = self._periodic_warmup_task
        if not task:
            return
        self._periodic_warmup_task = None
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    def get_provider(self, name: str) -> Any:
        cached = self.providers.get(name)
        if cached is not None:
            return cached

        spec = self._get_spec(name)
        if spec.async_native:
            raise RuntimeError(
                f"Provider {name} is async-native. "
                f"Use 'await client.get_provider_async(\"{name}\")'."
            )

        return self._load_provider_sync(name)

    async def get_provider_async(self, name: str, show_progress: bool = False) -> Any:
        cached = self.providers.get(name)
        if cached is not None:
            return cached

        existing = self._loading.get(name)
        if existing is not None:
            return await existing

        task = asyncio.create_task(
            self._load_provider_async(name, silent=not show_progress)
        )
        self._loading[name] = task

        try:
            return await task
        finally:
            if self._loading.get(name) is task:
                self._loading.pop(name, None)

    def is_loaded(self, name: str) -> bool:
        return name in self.providers

    def is_loading(self, name: str) -> bool:
        task = self._loading.get(name)
        return bool(task and not task.done())

    def list_loaded(self) -> List[str]:
        return list(self.providers.keys())

    def list_loading(self) -> List[str]:
        return [name for name, task in self._loading.items() if not task.done()]

    def provider_names(self) -> List[str]:
        return [spec.name for spec in _PROVIDER_SPECS]

    def snapshot(self) -> Dict[str, Any]:
        return {
            "mode": "heavy" if self.heavy else "light",
            "loaded": self.list_loaded(),
            "loading": self.list_loading(),
            "initialized": self._initialized,
        }

    async def wait_for_all(self) -> None:
        tasks = [task for task in self._loading.values() if not task.done()]
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def close_all(self) -> None:
        self._closed = True

        await self.stop_periodic_warmup()
        await self.wait_for_all()

        for provider in list(self.providers.values()):
            close = getattr(provider, "close", None)
            if callable(close):
                try:
                    if inspect.iscoroutinefunction(close):
                        await close()
                    else:
                        close()
                except Exception:
                    pass

            aclose = getattr(provider, "aclose", None)
            if callable(aclose):
                try:
                    if inspect.iscoroutinefunction(aclose):
                        await aclose()
                    else:
                        aclose()
                except Exception:
                    pass

        self.providers.clear()
        self._loading.clear()
        self._warmup_executor.shutdown(wait=False, cancel_futures=True)

    def __repr__(self) -> str:
        loaded = ", ".join(self.list_loaded()) or "none"
        loading_count = len(self.list_loading())
        mode = "heavy" if self.heavy else "light"
        if loading_count:
            return f"Client(mode={mode}, loaded=[{loaded}], loading={loading_count})"
        return f"Client(mode={mode}, loaded=[{loaded}])"


_global_client: Optional[Client] = None
_global_async_lock = asyncio.Lock()


async def get_client_async(heavy: bool = False) -> Client:
    global _global_client

    if _global_client is not None:
        if heavy and not _global_client.heavy:
            await _global_client.initialize(heavy=True, silent=True, run_startup_warmup=True)
        if heavy:
            _global_client.start_periodic_warmup(
                interval_seconds=1800,
                include_chat_probe=False,
                chat_prompt="Reply with one word: ok.",
                silent=True,
            )
        return _global_client

    async with _global_async_lock:
        if _global_client is None:
            _global_client = await Client.create(
                heavy=heavy,
                silent=True,
                run_startup_warmup=heavy,
            )
            if heavy:
                _global_client.start_periodic_warmup(
                    interval_seconds=1800,
                    include_chat_probe=False,
                    chat_prompt="Reply with one word: ok.",
                    silent=True,
                )
        elif heavy and not _global_client.heavy:
            await _global_client.initialize(heavy=True, silent=True, run_startup_warmup=True)
            _global_client.start_periodic_warmup(
                interval_seconds=1800,
                include_chat_probe=False,
                chat_prompt="Reply with one word: ok.",
                silent=True,
            )

    return _global_client


def get_client(heavy: bool = False) -> Client:
    global _global_client

    if _global_client is None:
        _global_client = Client(heavy=False)

    if heavy and not _global_client.heavy:
        _global_client.heavy = True
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(
                _global_client.initialize(heavy=True, silent=True, run_startup_warmup=True)
            )
        else:
            loop.create_task(
                _global_client.initialize(heavy=True, silent=True, run_startup_warmup=True)
            )

    return _global_client


async def reset_client() -> None:
    global _global_client
    if _global_client is not None:
        await _global_client.close_all()
    _global_client = None
