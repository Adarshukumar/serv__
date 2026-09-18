"""
══════════════════════════════════════════════════════════════
  ⚡  COMPLETION - Unified AI Interface

  Single entry point for all models across all providers
  Auto-routing with smart fallback
  Seamless sync/async support
  Search results pass-through
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations
import asyncio
import queue
import threading
from typing import Optional, AsyncGenerator, Generator, Any, Dict, List, Union
from pathlib import Path

from Models import ModelRegistry
from Client import get_client, get_client_async


# ═══════════════════════════════════════════════════════════
# §1 — PROVIDER ROUTER
# ═══════════════════════════════════════════════════════════
class _Router:
    """Route models to providers with smart fallback."""

    @staticmethod
    def get_provider_for_model(
        model_name: str, 
        provider_override: Optional[str] = None
    ) -> tuple[str, str]:
        """
        Determine which provider to use for a model.

        Logic:
        1. If provider override given and supports model → use it
        2. If provider override given but doesn't support model → fallback to best
        3. If no override → use model's best provider
        4. If best not available → use first working provider

        Args:
            model_name: Model name or alias
            provider_override: Optional specific provider

        Returns:
            (provider_name, connection_string)
        """
        model = ModelRegistry.get(model_name)
        if not model:
            raise ValueError(f"Unknown model: {model_name}")

        if not model.providers:
            raise ValueError(f"Model {model_name} has no providers")

        # Provider override specified
        if provider_override:
            # Check if override provider supports this model
            if provider_override in model.providers:
                connection = model.connection.get(provider_override)
                if connection:
                    return provider_override, connection
            
            # Override provider doesn't support model - fallback
            print(f"⚠️  Provider {provider_override} doesn't support {model_name}, using best provider")
        
        # Use best provider if available
        if model.best and model.best in model.providers:
            connection = model.connection.get(model.best)
            if connection:
                return model.best, connection
        
        # Fallback to first working provider
        for provider in model.providers:
            if model.working.get(provider, False):
                connection = model.connection.get(provider)
                if connection:
                    return provider, connection

        raise ValueError(f"Model {model_name} has no working providers")


# ═══════════════════════════════════════════════════════════
# §2 — PARAMETER BUILDER
# ═══════════════════════════════════════════════════════════
class _Params:
    """Build provider-specific parameters."""

    # Define what parameters each provider supports
    _PROVIDER_SUPPORT = {
        "DeepInfra": {
            "data", "messages", "model", "system", 
            "temperature", "max_tokens"
        },
        "Dolphin": {
            "data", "messages", "system", "attachment"
        },
        "DevsDo": {
            "data", "messages", "model", "system", 
            "temperature", "max_tokens"
        },
        "Mercury": {
            "data", "messages", "system", "search"
        },
        "LLMChat": {
            "data", "messages", "model", "system", 
            "max_tokens", "temperature"
        },
        "mCloudFlare": {
            "data", "messages", "model", "system", 
            "temperature", "max_tokens"
        },
        "Upstage": {
            "data", "messages", "model", "system", 
            "search", "max_tokens", "temperature"
        }
    }

    @classmethod
    def build(
        cls,
        provider_name: str,
        connection: str,
        data: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
        system: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        thinking: Optional[bool] = None,
        search: Optional[bool] = None,
        attachment: Optional[List[Union[str, Path]]] = None,
        **kwargs
    ) -> Dict[str, Any]:
        """
        Build parameter dict for a specific provider.
        Only includes parameters the provider supports.
        """
        supported = cls._PROVIDER_SUPPORT.get(provider_name, set())
        params: Dict[str, Any] = {}
        
        # Data/messages (always included if provided)
        if data is not None:
            params["data"] = data
        if messages is not None:
            params["messages"] = messages
        
        # Model connection string
        if "model" in supported:
            params["model"] = connection
        
        # Optional parameters (only if supported)
        if system is not None and "system" in supported:
            params["system"] = system
            
        if temperature is not None and "temperature" in supported:
            params["temperature"] = temperature
            
        if max_tokens is not None and "max_tokens" in supported:
            params["max_tokens"] = max_tokens
            
        if thinking is not None and "thinking" in supported:
            params["thinking"] = thinking
            
        if search is not None and "search" in supported:
            params["search"] = search
            
        if attachment is not None and "attachment" in supported:
            params["attachment"] = attachment
            
        return params


# ═══════════════════════════════════════════════════════════
# §3 — SYNC/ASYNC BRIDGE
# ═══════════════════════════════════════════════════════════
class _Bridge:
    """Bridge async generators to sync context."""

    @staticmethod
    def async_to_sync(agen: AsyncGenerator) -> Generator:
        """
        Convert async generator to sync generator.
        Runs async generator in a background thread with its own event loop.
        """
        result_queue = queue.Queue()
        stop_event = threading.Event()
        exception_holder = []
        
        def worker():
            """Background thread running the async generator."""
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            
            async def consume():
                try:
                    async for item in agen:
                        if stop_event.is_set():
                            break
                        result_queue.put(("item", item))
                except Exception as e:
                    exception_holder.append(e)
                finally:
                    result_queue.put(("done", None))
            
            try:
                loop.run_until_complete(consume())
            finally:
                loop.close()
        
        # Start background thread
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        
        # Yield items from queue
        while True:
            try:
                event_type, item = result_queue.get(timeout=0.1)
                
                if event_type == "done":
                    break
                    
                if exception_holder:
                    raise exception_holder[0]
                    
                yield item
                
            except queue.Empty:
                if not thread.is_alive() and exception_holder:
                    raise exception_holder[0]
                if not thread.is_alive():
                    break
        
        # Cleanup
        stop_event.set()
        if exception_holder:
            raise exception_holder[0]


# ═══════════════════════════════════════════════════════════
# §4 — COMPLETION CLASS
# ═══════════════════════════════════════════════════════════
class Completion:
    """
    Unified interface for all AI models.
    
    Routes requests to appropriate providers.
    Handles sync/async contexts automatically.
    Passes through search results as-is.
    """

    @staticmethod
    def chat(
        model: str,
        data: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
        provider: Optional[str] = None,
        system: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        thinking: Optional[bool] = None,
        search: Optional[bool] = None,
        attachment: Optional[List[Union[str, Path]]] = None,
        heavy: bool = False,
        **kwargs
    ):
        """
        Generate completion from any model (auto-detects sync/async).

        Args:
            model: Model name from registry
            data: Text prompt
            messages: OpenAI-style message list
            provider: Override provider selection
            system: System prompt
            temperature: Sampling temperature
            max_tokens: Max tokens to generate
            thinking: Enable thinking/reasoning mode
            search: Enable web search (Mercury, Upstage)
            attachment: File attachments (Dolphin)
            heavy: Use heavy client mode
            **kwargs: Additional provider-specific args

        Yields:
            str: Response tokens
            
        Note:
            Search results yielded as JSON first:
            {"sources": [{"title": "...", "url": "..."}]}
        """
        # Detect if we're in async context
        try:
            asyncio.get_running_loop()
            is_async = True
        except RuntimeError:
            is_async = False

        if is_async:
            return Completion.achat(
                model=model,
                data=data,
                messages=messages,
                provider=provider,
                system=system,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                search=search,
                attachment=attachment,
                heavy=heavy,
                **kwargs
            )
        else:
            return Completion.chat_sync(
                model=model,
                data=data,
                messages=messages,
                provider=provider,
                system=system,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                search=search,
                attachment=attachment,
                heavy=heavy,
                **kwargs
            )

    @staticmethod
    def chat_sync(
        model: str,
        data: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
        provider: Optional[str] = None,
        system: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        thinking: Optional[bool] = None,
        search: Optional[bool] = None,
        attachment: Optional[List[Union[str, Path]]] = None,
        heavy: bool = False,
        **kwargs
    ) -> Generator[str, None, None]:
        """Synchronous completion (blocks until complete)."""
        # Route to provider
        provider_name, connection = _Router.get_provider_for_model(model, provider)
        
        # Build parameters
        params = _Params.build(
            provider_name=provider_name,
            connection=connection,
            data=data,
            messages=messages,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            thinking=thinking,
            search=search,
            attachment=attachment,
            **kwargs
        )
        
        # Check if provider is async-native
        async_providers = {"Dolphin", "DevsDo", "Mercury", "LLMChat", "Upstage"}
        
        if provider_name in async_providers:
            # Async provider in sync context - use bridge
            async_gen = Completion.achat(
                model=model,
                data=data,
                messages=messages,
                provider=provider_name,
                system=system,
                temperature=temperature,
                max_tokens=max_tokens,
                thinking=thinking,
                search=search,
                attachment=attachment,
                heavy=heavy,
                **kwargs
            )
            yield from _Bridge.async_to_sync(async_gen)
        else:
            # Sync provider - direct call
            client = get_client(heavy=heavy)
            provider_instance = client.get_provider(provider_name)
            yield from provider_instance.chat(**params)

    @staticmethod
    async def achat(
        model: str,
        data: Optional[str] = None,
        messages: Optional[List[Dict]] = None,
        provider: Optional[str] = None,
        system: Optional[str] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        thinking: Optional[bool] = None,
        search: Optional[bool] = None,
        attachment: Optional[List[Union[str, Path]]] = None,
        heavy: bool = False,
        **kwargs
    ) -> AsyncGenerator[str, None]:
        """Asynchronous completion (async generator)."""
        # Route to provider
        provider_name, connection = _Router.get_provider_for_model(model, provider)
        
        # Build parameters
        params = _Params.build(
            provider_name=provider_name,
            connection=connection,
            data=data,
            messages=messages,
            system=system,
            temperature=temperature,
            max_tokens=max_tokens,
            thinking=thinking,
            search=search,
            attachment=attachment,
            **kwargs
        )
        
        # Get client
        client = await get_client_async(heavy=heavy)
        
        # Get provider instance
        async_providers = {"Dolphin", "DevsDo", "Mercury", "LLMChat", "Upstage"}
        
        if provider_name in async_providers:
            # Async provider
            provider_instance = await client.get_provider_async(provider_name)
            async for token in provider_instance.chat(**params):
                yield token
        else:
            # Sync provider - wrap in async
            provider_instance = client.get_provider(provider_name)
            for token in provider_instance.chat(**params):
                yield token
                await asyncio.sleep(0)  # Yield control to event loop