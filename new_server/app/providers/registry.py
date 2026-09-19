"""
Provider Registry — provider-based (not just model-based), with health, fallback
"""
from __future__ import annotations
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass

from ..config import DEFAULT_PROVIDER, DEFAULT_MODEL

@dataclass
class ProviderInfo:
    name: str
    display: str
    models: List[str]
    capabilities: Dict[str, bool]
    requires_network: bool
    concurrency: int

@dataclass
class ModelInfo:
    id: str
    display: str
    owned_by: str
    provider: str
    capabilities: Dict[str, bool]
    context: int = 0

class ProviderRegistry:
    def __init__(self):
        self._providers: Dict[str, ProviderInfo] = {}
        self._models: Dict[str, ModelInfo] = {}
        self._model_to_provider: Dict[str, str] = {}
        self._build()

    def _build(self):
        # RAGSrv — always works, no API dependency, 48 models
        try:
            from .ragsrv import MODELS as RAGSRV_LIST, MODEL_ALIASES as RAGSRV_ALIASES
            ragsrv_models = [m["id"] for m in RAGSRV_LIST] + list(RAGSRV_ALIASES.keys())
            self._providers["ragsrv"] = ProviderInfo(
                name="ragsrv",
                display="RAGSrv (48 models, simulated + proxy, no API dependency)",
                models=ragsrv_models,
                capabilities={"reasoning": True, "search": True, "vision": False, "always_works": True},
                requires_network=False,
                concurrency=50,
            )
            for m in RAGSRV_LIST:
                mid = m["id"]
                if mid not in self._models:
                    self._models[mid] = ModelInfo(id=mid, display=m["name"], owned_by=m["family"], provider="ragsrv", capabilities={"reasoning": m["think"], "search": True, "vision": False}, context=m["context"])
                    self._model_to_provider[mid] = "ragsrv"
            for alias, full in RAGSRV_ALIASES.items():
                if alias not in self._models:
                    base = self._models.get(full)
                    if base:
                        self._models[alias] = ModelInfo(id=alias, display=alias, owned_by=base.owned_by, provider="ragsrv", capabilities=base.capabilities, context=base.context)
                    else:
                        self._models[alias] = ModelInfo(id=alias, display=alias, owned_by="RAGSrv", provider="ragsrv", capabilities={"reasoning": False, "search": True, "vision": False})
                    self._model_to_provider[alias] = "ragsrv"
        except Exception as e:
            print(f"[Registry] RAGSrv build failed: {e}")

        # DeepInfra
        try:
            from .deepinfra import MODELS as DI_MODELS
            self._providers["deepinfra"] = ProviderInfo(
                name="deepinfra",
                display="DeepInfra (20+ models, OpenAI compat, user IP forwarding)",
                models=list(DI_MODELS.keys()),
                capabilities={"reasoning": False, "search": True, "vision": False, "always_works": False},
                requires_network=True,
                concurrency=10,
            )
            for alias, full in DI_MODELS.items():
                if alias not in self._models:
                    self._models[alias] = ModelInfo(id=alias, display=alias, owned_by=full.split("/")[0] if "/" in full else "DeepInfra", provider="deepinfra", capabilities={"reasoning": False, "search": True, "vision": False}, context=8192)
                    self._model_to_provider[alias] = "deepinfra"
        except Exception as e:
            print(f"[Registry] DeepInfra build failed: {e}")

        # mCloudFlare v2
        try:
            from .mcloudflare import MODELS as CF_MODELS
            self._providers["mcloudflare"] = ProviderInfo(
                name="mcloudflare",
                display="mCloudFlare v2 (35+ models, official+fallback, user IP, native search)",
                models=list(CF_MODELS.keys()),
                capabilities={"reasoning": True, "search": True, "vision": True, "always_works": False},
                requires_network=True,
                concurrency=10,
            )
            for alias in CF_MODELS.keys():
                if alias not in self._models:
                    self._models[alias] = ModelInfo(id=alias, display=alias, owned_by="Cloudflare", provider="mcloudflare", capabilities={"reasoning": "qwq" in alias or "deepseek" in alias, "search": True, "vision": "vision" in alias}, context=8192)
                    self._model_to_provider[alias] = "mcloudflare"
        except Exception as e:
            print(f"[Registry] mCloudFlare build failed: {e}")

        # Upstage v3
        try:
            from .upstage import _MODELS as UP_MODELS
            self._providers["upstage"] = ProviderInfo(
                name="upstage",
                display="Upstage v3 (4 models, pure HTTP creds, ThinkSplitter, native search)",
                models=list(UP_MODELS.keys()),
                capabilities={"reasoning": True, "search": True, "vision": False, "always_works": False},
                requires_network=True,
                concurrency=10,
            )
            for alias in UP_MODELS.keys():
                if alias not in self._models:
                    self._models[alias] = ModelInfo(id=alias, display=alias, owned_by="Upstage", provider="upstage", capabilities={"reasoning": True, "search": True, "vision": False}, context=65536 if "pro3" in alias else 16384)
                    self._model_to_provider[alias] = "upstage"
        except Exception as e:
            print(f"[Registry] Upstage build failed: {e}")

        # Inception (Mercury) — with user IP forwarding, works everywhere if respects headers
        try:
            from .inception import MODELS as INC_MODELS
            self._providers["inception"] = ProviderInfo(
                name="inception",
                display="Inception Mercury (3 models, cloudscraper+proxy, user IP forwarding, auto search)",
                models=list(INC_MODELS.keys()),
                capabilities={"reasoning": True, "search": True, "vision": False, "always_works": False},
                requires_network=True,
                concurrency=10,
            )
            for alias in INC_MODELS.keys():
                if alias not in self._models:
                    self._models[alias] = ModelInfo(id=alias, display=alias, owned_by="Inception", provider="inception", capabilities={"reasoning": True, "search": True, "vision": False}, context=32768)
                    self._model_to_provider[alias] = "inception"
        except Exception as e:
            print(f"[Registry] Inception build failed: {e}")

        # Ensure default model exists
        if DEFAULT_MODEL not in self._models:
            # Fallback to first ragsrv model
            if self._models:
                first = list(self._models.keys())[0]
                self._models[DEFAULT_MODEL] = self._models[first]

    def get(self, model_name: str) -> Optional[ModelInfo]:
        if not model_name:
            return None
        if model_name in self._models:
            return self._models[model_name]
        low = model_name.lower().strip()
        if low in self._models:
            return self._models[low]
        # Fuzzy
        for key, info in self._models.items():
            if low in key.lower() or key.lower() in low:
                return info
        return None

    def get_provider(self, provider_name: str) -> Optional[ProviderInfo]:
        if not provider_name:
            return None
        return self._providers.get(provider_name.lower().strip())

    def get_provider_class(self, model_or_provider: str) -> Tuple[type, str]:
        # First check if it's a provider name
        prov_info = self.get_provider(model_or_provider)
        if prov_info:
            provider_name = prov_info.name
            return self._class_for_provider(provider_name), provider_name

        # Then check model
        model_info = self.get(model_or_provider)
        if model_info:
            provider_name = model_info.provider
            return self._class_for_provider(provider_name), provider_name

        # Default to ragsrv (always works)
        try:
            from .ragsrv import RAGSrvProvider
            return RAGSrvProvider, "ragsrv"
        except ImportError:
            from .ragsrv import RAGSrvProvider as RAGSrvProviderAsync
            return RAGSrvProviderAsync, "ragsrv"

    def _class_for_provider(self, provider_name: str):
        if provider_name == "deepinfra":
            from .deepinfra import DeepInfraProvider
            return DeepInfraProvider
        elif provider_name == "mcloudflare":
            from .mcloudflare import MCloudFlareProvider
            return MCloudFlareProvider
        elif provider_name == "upstage":
            try:
                from .upstage import UpstageProvider
                return UpstageProvider
            except ImportError:
                from .ragsrv import RAGSrvProvider
                return RAGSrvProvider
        elif provider_name == "inception":
            try:
                from .inception import InceptionProvider
                return InceptionProvider
            except ImportError:
                from .ragsrv import RAGSrvProvider
                return RAGSrvProvider
        elif provider_name == "ragsrv":
            from .ragsrv import RAGSrvProvider
            return RAGSrvProvider
        else:
            from .ragsrv import RAGSrvProvider
            return RAGSrvProvider

    def all_providers(self) -> List[ProviderInfo]:
        return list(self._providers.values())

    def all_models(self) -> List[ModelInfo]:
        return list(self._models.values())

    def all_model_ids(self) -> List[str]:
        return list(self._models.keys())

global_registry = ProviderRegistry()
