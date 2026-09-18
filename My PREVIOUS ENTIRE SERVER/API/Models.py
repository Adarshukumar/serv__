"""
══════════════════════════════════════════════════════════════
  📚 Model Registry (Complete & Accurate)

  Unified model registry for cross-provider compatibility.
  Based on actual provider implementations:

    Provider       │ Models │ Notes
    ───────────────┼────────┼──────────────────────────────
    Upstage        │   4    │ Solar / Syn models
    Mercury        │   1    │ Mercury high-reasoning
    mCloudFlare    │   4    │ Thin wrapper over CF Workers AI
    LLMChat        │  24    │ CF Workers AI (own endpoint)
    Dolphin        │   2    │ Dolphin server models
    DevsDo         │  52    │ CF Workers AI (largest catalog)
    ───────────────┴────────┴──────────────────────────────

  Usage:
      from models import ModelRegistry

      model = ModelRegistry.get("kimi-k2.5")

      if "DevsDo" in model.providers:
          provider_id = model.connection["DevsDo"]

      best = model.get_best_provider()

      reasoning_models = ModelRegistry.by_capability("reasoning")
      vision_models    = ModelRegistry.filter(vision=True)

      all_models = ModelRegistry.all()
══════════════════════════════════════════════════════════════
"""

from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional, Any
from collections import defaultdict
from datetime import datetime




DEFAULT_FAVICON_MAP = {
    "Meta": "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/meta-color.png",
    "Qwen": "https://qwenlm.github.io/img/logo.png",
    "Google": "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/google-color.png",
    "Mistral": "https://mistral.ai/favicon.ico",
    "DeepSeek": "https://deepseek.com/favicon.ico",
    "Upstage": "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/upstage-color.png",
    "Dolphin": "https://chat.dphn.ai/favicon.png",
    "NousResearch": "https://nousresearch.com/wp-content/uploads/2024/03/android-chrome-512x512-1-150x150.png",
    "OpenAI": "https://openai.com/favicon.ico",
    "AI Singapore": "https://aisingapore.org/favicon.ico",
    "Defog": "https://defog.ai/favicon.ico",
    "FBLGit": "https://huggingface.co/favicon.ico",
    "HuggingFace": "https://huggingface.co/favicon.ico",
    "IBM": "https://ibm.com/favicon.ico",
    "Intel": "https://intel.com/favicon.ico",
    "Mercury": "https://framerusercontent.com/images/CmVpEAGEr2HzKSXUSE9Iw1BeiY.png",
    "Microsoft": "https://microsoft.com/favicon.ico",
    "Moonshot AI": "https://cdn-avatars.huggingface.co/v1/production/uploads/641c1e77c3983aa9490f8121/X1yT2rsaIbR9cdYGEVu0X.jpeg",
    "NVIDIA": "https://nvidia.com/favicon.ico",
    "NexusFlow": "https://www.nexusflowtrading.com/img/favicon.png",
    "OpenChat": "https://raw.githubusercontent.com/lobehub/lobe-icons/refs/heads/master/packages/static-png/light/openchat-color.png",
    "TII UAE": "https://www.tii.ae/themes/custom/tech/favicon.ico",
    "TheBloke": "https://cdn-avatars.huggingface.co/v1/production/uploads/6426d3f3a7723d62b53c259b/waPyqc71Im-fpVAOiC0BW.jpeg",
    "TinyLlama": "https://cdn-avatars.huggingface.co/v1/production/uploads/63565cc56d7fcf1bedb7d347/DRv8Ln7nvK22iXkLmAGb_.png",
    "ZHIPU AI": "https://www.gravatar.com/avatar/c4c20c9926e438f62921e2aa95ac4538?d=retro&size=100",
}


def _merge_capabilities(capability_maps: Dict[str, Dict[str, bool]]) -> Dict[str, bool]:
    merged = {
        "reasoning": False,
        "vision": False,
        "search": False,
        "attachment": False,
    }
    for caps in capability_maps.values():
        for key, value in caps.items():
            if value:
                merged[key] = True
    return merged


def _model_to_family_api(model: "Model") -> Dict[str, Any]:
    return {
        "id": model.name,
        "name": getattr(model, "display", model.name),
        "author": getattr(model, "family", "Unknown"),
        "description": getattr(model, "description", ""),
        "capabilities": _merge_capabilities(model.capabilities),
    }




# ═══════════════════════════════════════════════════════════
# §1 — MODEL DATACLASS
# ═══════════════════════════════════════════════════════════
@dataclass
class Model:
    """Model metadata with provider-specific capabilities."""

    name: str                                       # Internal lookup key
    display: str                                    # Human-readable name
    family: str                                     # Model family / org
    providers: Tuple[str, ...]                      # Available providers
    connection: Dict[str, str]                      # Provider → model ID
    capabilities: Dict[str, Dict[str, bool]]        # Provider → caps
    working: Dict[str, bool]                        # Provider → status
    max_tokens: Dict[str, int]                      # Provider → context
    aliases: Tuple[str, ...] = field(default_factory=tuple)
    description: str = ""
    best: Optional[str] = None                      # Recommended provider

    def get_best_provider(self) -> str:
        """Get recommended or first working provider."""
        if self.best and self.working.get(self.best, False):
            return self.best
        for provider in self.providers:
            if self.working.get(provider, False):
                return provider
        return self.providers[0] if self.providers else "Unknown"

    def supports(self, feature: str) -> bool:
        """Check if ANY provider supports a feature."""
        return any(
            caps.get(feature, False)
            for caps in self.capabilities.values()
        )


# ═══════════════════════════════════════════════════════════
# Helper — build caps dict for common no-frills CF models
# ═══════════════════════════════════════════════════════════
def _cf_caps(
    *providers: str,
    reasoning: bool = False,
    vision: bool = False,
    attachment: bool = False,
    search: bool = False,
) -> Dict[str, Dict[str, bool]]:
    c = {
        "reasoning": reasoning,
        "vision": vision,
        "attachment": attachment,
        "search": search,
    }
    return {p: dict(c) for p in providers}


# ═══════════════════════════════════════════════════════════
# §2 — MODEL DEFINITIONS
#
#   Provider connection-ID conventions
#   ───────────────────────────────────
#   DevsDo      → full CF id   e.g. "@cf/meta/llama-3.1-8b-instruct-fast"
#   LLMChat     → org/model    e.g. "meta/llama-3.1-8b-instruct"
#                  (prefix @cf/ or @hf/ is prepended by provider)
#   mCloudFlare → short key    e.g. "llama-3.2-3b"
#   Upstage     → model slug   e.g. "solar-pro3"
#   Mercury     → model slug   e.g. "mercury-high"
#   Dolphin     → server tag   e.g. "dolphinserver:24B"
# ═══════════════════════════════════════════════════════════


# ┌─────────────────────────────────────────────────────────┐
# │  UPSTAGE / SOLAR                                        │
# └─────────────────────────────────────────────────────────┘

solar_pro3 = Model(
    name="solar-pro3",
    display="Solar Pro 3",
    family="Upstage",
    providers=("Upstage",),
    connection={"Upstage": "solar-pro3"},
    capabilities={"Upstage": {"reasoning": True, "vision": False, "attachment": False, "search": True}},
    working={"Upstage": True},
    max_tokens={"Upstage": 65536},
    aliases=("solar3", "pro3", "solar-3"),
    description="Upstage Solar Pro 3 — Flagship with reasoning (low/medium/high) and web search",
    best="Upstage",
)

solar_pro2 = Model(
    name="solar-pro2",
    display="Solar Pro 2",
    family="Upstage",
    providers=("Upstage",),
    connection={"Upstage": "solar-pro2"},
    capabilities={"Upstage": {"reasoning": True, "vision": False, "attachment": False, "search": True}},
    working={"Upstage": True},
    max_tokens={"Upstage": 16383},
    aliases=("solar2", "pro2", "solar-2"),
    description="Upstage Solar Pro 2 — Efficient reasoning with web search (low/high)",
    best="Upstage",
)

syn_pro = Model(
    name="syn-pro",
    display="Syn Pro",
    family="Upstage",
    providers=("Upstage",),
    connection={"Upstage": "syn-pro"},
    capabilities={"Upstage": {"reasoning": True, "vision": False, "attachment": False, "search": True}},
    working={"Upstage": True},
    max_tokens={"Upstage": 16384},
    aliases=("syn",),
    description="Upstage Syn Pro — Synthetic-data-oriented with reasoning (low/high)",
    best="Upstage",
)

solar_mini = Model(
    name="solar-mini",
    display="Solar 1 Mini Chat",
    family="Upstage",
    providers=("Upstage",),
    connection={"Upstage": "upstage/solar-1-mini-chat"},
    capabilities={"Upstage": {"reasoning": False, "vision": False, "attachment": False, "search": True}},
    working={"Upstage": True},
    max_tokens={"Upstage": 16383},
    aliases=("mini", "solar-1-mini"),
    description="Upstage Solar 1 Mini — Compact model with web search, no reasoning",
    best="Upstage",
)


# ┌─────────────────────────────────────────────────────────┐
# │  MERCURY                                                │
# └─────────────────────────────────────────────────────────┘

mercury_high = Model(
    name="mercury",
    display="Mercury",
    family="Mercury",
    providers=("Mercury",),
    connection={"Mercury": "mercury-high"},
    capabilities={"Mercury": {"reasoning": True, "vision": False, "attachment": False, "search": True}},
    working={"Mercury": False},
    max_tokens={"Mercury": 32768},
    aliases=("mercury-high",),
    description="Mercury — High-quality reasoning with web search (always high mode)",
    best="Mercury",
)


# ┌─────────────────────────────────────────────────────────┐
# │  DOLPHIN                                                │
# └─────────────────────────────────────────────────────────┘

dolphin_24b = Model(
    name="dolphin-24b",
    display="Dolphin 24B",
    family="Dolphin",
    providers=("Dolphin",),
    connection={"Dolphin": "dolphinserver:24B"},
    capabilities={"Dolphin": {"reasoning": False, "vision": False, "attachment": True, "search": False}},
    working={"Dolphin": True},
    max_tokens={"Dolphin": 8192},
    aliases=("dolphin",),
    description="Dolphin 24B — General purpose with file attachments (images + text)",
    best="Dolphin",
)

dolphin_flash = Model(
    name="dolphin-flash",
    display="Dolphin 3 Flash",
    family="Dolphin",
    providers=("Dolphin",),
    connection={"Dolphin": "dp3:flash"},
    capabilities={"Dolphin": {"reasoning": False, "vision": False, "attachment": True, "search": False}},
    working={"Dolphin": True},
    max_tokens={"Dolphin": 8192},
    aliases=("dp3", "dp3-flash"),
    description="Dolphin 3 Flash — Fast inference with file attachments",
    best="Dolphin",
)


# ┌─────────────────────────────────────────────────────────┐
# │  OPENAI OSS (via Cloudflare)                            │
# └─────────────────────────────────────────────────────────┘

gpt_oss_120b = Model(
    name="gpt-oss-120b",
    display="GPT-OSS 120B",
    family="OpenAI",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/openai/gpt-oss-120b"},
    capabilities=_cf_caps("DevsDo", reasoning=True),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 128000},
    aliases=("gpt-oss",),
    description="OpenAI GPT-OSS 120B — Largest open-source GPT on CF",
    best="DevsDo",
)

gpt_oss_20b = Model(
    name="gpt-oss-20b",
    display="GPT-OSS 20B",
    family="OpenAI",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/openai/gpt-oss-20b"},
    capabilities=_cf_caps("DevsDo", reasoning=True),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 128000},
    aliases=("gpt-oss-small",),
    description="OpenAI GPT-OSS 20B — Smaller open-source GPT",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  NVIDIA NEMOTRON                                        │
# └─────────────────────────────────────────────────────────┘

nemotron_120b = Model(
    name="nemotron-120b",
    display="Nemotron 3 120B A12B",
    family="NVIDIA",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/nvidia/nemotron-3-120b-a12b"},
    capabilities=_cf_caps("DevsDo", reasoning=True),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 256000},
    aliases=("nemotron", "nemotron-super"),
    description="NVIDIA Nemotron 3 120B — 256K context flagship",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  MOONSHOT AI / KIMI                                     │
# └─────────────────────────────────────────────────────────┘

kimi_k2_5 = Model(
    name="kimi-k2.5",
    display="Kimi K2.5",
    family="Moonshot AI",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/moonshotai/kimi-k2.5",
        "LLMChat": "moonshotai/kimi-k2.5",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", reasoning=True),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 256000, "LLMChat": 200000},
    aliases=("kimi", "kimi-k2"),
    description="Moonshot Kimi K2.5 — 256K context reasoning flagship, DevsDo default",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  META LLAMA FAMILY                                      │
# └─────────────────────────────────────────────────────────┘

llama_4_scout = Model(
    name="llama-4-scout",
    display="Llama 4 Scout 17B 16E Instruct",
    family="Meta",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/meta/llama-4-scout-17b-16e-instruct",
        "LLMChat": "meta/llama-4-scout-17b-16e-instruct",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 131000, "LLMChat": 100000},
    aliases=("llama-4", "llama-scout"),
    description="Llama 4 Scout 17B — MoE early Llama 4",
    best="DevsDo",
)

llama_3_3_70b = Model(
    name="llama-3.3-70b",
    display="Llama 3.3 70B Instruct FP8 Fast",
    family="Meta",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        "LLMChat": "meta/llama-3.3-70b-instruct-fp8-fast",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 24000, "LLMChat": 23500},
    aliases=("llama-3.3", "llama-3.3-70b-instruct"),
    description="Llama 3.3 70B — FP8-optimised fast variant",
    best="DevsDo",
)

# NOTE: LLMChat has "meta/llama-3.1-70b-instruct" but DevsDo does NOT
# list a 3.1-70b. Only LLMChat serves it.
llama_3_1_70b = Model(
    name="llama-3.1-70b",
    display="Llama 3.1 70B Instruct",
    family="Meta",
    providers=("LLMChat",),
    connection={
        "LLMChat": "meta/llama-3.1-70b-instruct",
    },
    capabilities=_cf_caps("LLMChat"),
    working={"LLMChat": True},
    max_tokens={"LLMChat": 23500},
    aliases=("llama-70b", "llama-3.1-70b-instruct"),
    description="Llama 3.1 70B Instruct",
    best="LLMChat",
)

llama_3_2_11b_vision = Model(
    name="llama-3.2-11b-vision",
    display="Llama 3.2 11B Vision Instruct",
    family="Meta",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/meta/llama-3.2-11b-vision-instruct"},
    capabilities=_cf_caps("DevsDo", vision=True),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 128000},
    aliases=("llama-vision", "llama-3.2-vision"),
    description="Llama 3.2 11B Vision — Multimodal",
    best="DevsDo",
)

llama_3_1_8b = Model(
    name="llama-3.1-8b",
    display="Llama 3.1 8B Instruct Fast",
    family="Meta",
    providers=("DevsDo", "LLMChat", "mCloudFlare"),
    connection={
        "DevsDo": "@cf/meta/llama-3.1-8b-instruct-fast",
        "LLMChat": "meta/llama-3.1-8b-instruct",
        "mCloudFlare": "llama-3.1-8b",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", "mCloudFlare"),
    working={"DevsDo": True, "LLMChat": True, "mCloudFlare": True},
    max_tokens={"DevsDo": 32000, "LLMChat": 100000, "mCloudFlare": 7500},
    aliases=("llama-8b", "llama-3.1-8b-instruct"),
    description="Llama 3.1 8B Instruct — Fast variant on DevsDo",
    best="DevsDo",
)

llama_3_1_8b_fp8 = Model(
    name="llama-3.1-8b-fp8",
    display="Llama 3.1 8B Instruct FP8",
    family="Meta",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/meta/llama-3.1-8b-instruct-fp8"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 32000},
    aliases=("llama-3.1-8b-instruct-fp8",),
    description="Llama 3.1 8B FP8 quantised",
    best="DevsDo",
)

llama_3_1_8b_awq = Model(
    name="llama-3.1-8b-awq",
    display="Llama 3.1 8B Instruct AWQ",
    family="Meta",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/meta/llama-3.1-8b-instruct-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 8192},
    aliases=("llama-3.1-8b-instruct-awq",),
    description="Llama 3.1 8B AWQ quantised",
    best="DevsDo",
)

llama_3_2_3b = Model(
    name="llama-3.2-3b",
    display="Llama 3.2 3B Instruct",
    family="Meta",
    providers=("DevsDo", "LLMChat", "mCloudFlare"),
    connection={
        "DevsDo": "@cf/meta/llama-3.2-3b-instruct",
        "LLMChat": "meta/llama-3.2-3b-instruct",
        "mCloudFlare": "llama-3.2-3b",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", "mCloudFlare"),
    working={"DevsDo": True, "LLMChat": True, "mCloudFlare": True},
    max_tokens={"DevsDo": 80000, "LLMChat": 79500, "mCloudFlare": 2048},
    aliases=("llama-3b", "llama-3.2-3b-instruct"),
    description="Llama 3.2 3B — Small efficient model",
    best="DevsDo",
)

llama_3_2_1b = Model(
    name="llama-3.2-1b",
    display="Llama 3.2 1B Instruct",
    family="Meta",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/meta/llama-3.2-1b-instruct",
        "LLMChat": "meta/llama-3.2-1b-instruct",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 60000, "LLMChat": 59500},
    aliases=("llama-1b", "llama-3.2-1b-instruct"),
    description="Llama 3.2 1B — Tiny model",
    best="DevsDo",
)

llama_3_8b = Model(
    name="llama-3-8b",
    display="Llama 3 8B Instruct",
    family="Meta",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/meta/llama-3-8b-instruct",
        "LLMChat": "meta/llama-3-8b-instruct",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 7968, "LLMChat": 7500},
    aliases=("llama-3-8b-instruct",),
    description="Llama 3 8B Instruct",
    best="DevsDo",
)

llama_3_8b_awq = Model(
    name="llama-3-8b-awq",
    display="Llama 3 8B Instruct AWQ",
    family="Meta",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/meta/llama-3-8b-instruct-awq",
        "LLMChat": "meta/llama-3-8b-instruct-awq",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 8192, "LLMChat": 8000},
    aliases=("llama-3-8b-instruct-awq",),
    description="Llama 3 8B AWQ quantised",
    best="DevsDo",
)

# LLMChat has "@hf/meta-llama/meta-llama-3-8b-instruct" as a separate entry
llama_3_8b_hf = Model(
    name="llama-3-8b-hf",
    display="Llama 3 8B Instruct (HF)",
    family="Meta",
    providers=("LLMChat",),
    connection={"LLMChat": "meta-llama/meta-llama-3-8b-instruct"},
    capabilities=_cf_caps("LLMChat"),
    working={"LLMChat": True},
    max_tokens={"LLMChat": 7500},
    aliases=("llama-3-8b-meta",),
    description="Llama 3 8B Instruct — HuggingFace hosted variant",
    best="LLMChat",
)

llama_guard_3 = Model(
    name="llama-guard-3",
    display="Llama Guard 3 8B",
    family="Meta",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/meta/llama-guard-3-8b"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 131072},
    aliases=("llama-guard",),
    description="Llama Guard 3 — Content-moderation model",
    best="DevsDo",
)

llama_2_7b_fp16 = Model(
    name="llama-2-7b-fp16",
    display="Llama 2 7B Chat FP16",
    family="Meta",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/meta/llama-2-7b-chat-fp16"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("llama-2-7b-chat-fp16",),
    description="Llama 2 7B FP16",
    best="DevsDo",
)

llama_2_7b_int8 = Model(
    name="llama-2-7b-int8",
    display="Llama 2 7B Chat INT8",
    family="Meta",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/meta/llama-2-7b-chat-int8",
        "LLMChat": "meta/llama-2-7b-chat-int8",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 8192, "LLMChat": 8000},
    aliases=("llama-2-7b-chat-int8",),
    description="Llama 2 7B INT8 quantised",
    best="DevsDo",
)

llama_2_7b_lora = Model(
    name="llama-2-7b-lora",
    display="Llama 2 7B Chat HF LoRA",
    family="Meta",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/meta-llama/llama-2-7b-chat-hf-lora"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 8192},
    aliases=("llama-2-7b-chat-hf-lora",),
    description="Llama 2 7B with LoRA adapters",
    best="DevsDo",
)

llama_2_13b = Model(
    name="llama-2-13b",
    display="Llama 2 13B Chat AWQ",
    family="Meta",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/thebloke/llama-2-13b-chat-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("llama-2-13b-awq",),
    description="Llama 2 13B AWQ (TheBloke quantisation)",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  QWEN / ALIBABA FAMILY                                  │
# └─────────────────────────────────────────────────────────┘

qwq_32b = Model(
    name="qwq-32b",
    display="Qwen QWQ 32B",
    family="Qwen",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/qwen/qwq-32b",
        "LLMChat": "qwen/qwq-32b",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", reasoning=True),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 24000, "LLMChat": 23500},
    aliases=("qwq","qwq"),
    description="Qwen QWQ 32B — Thinking model with <think> tags",
    best="DevsDo",
)
qwq_32b = Model(
    name="qwq-32b",
    display="Qwen QWQ 32B",
    family="Qwen",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/qwen/qwq-32b",
        "LLMChat": "qwen/qwq-32b",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", reasoning=True),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 24000, "LLMChat": 23500},
    aliases=("qwq",),
    description="Qwen QWQ 32B — Thinking model with <think> tags",
    best="DevsDo",
)

qwen_coder_32b = Model(
    name="qwen-coder-32b",
    display="Qwen 2.5 Coder 32B Instruct",
    family="Qwen",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/qwen/qwen2.5-coder-32b-instruct",
        "LLMChat": "qwen/qwen2.5-coder-32b-instruct",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 32768, "LLMChat": 32500},
    aliases=("qwen-coder", "coder-32b"),
    description="Qwen 2.5 Coder 32B — Code-specialised",
    best="DevsDo",
)

qwen3_30b = Model(
    name="qwen3-30b",
    display="Qwen 3 30B A3B FP8",
    family="Qwen",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/qwen/qwen3-30b-a3b-fp8",
        "LLMChat": "qwen/qwen3-30b-a3b-fp8",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", reasoning=True),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 32768, "LLMChat": 32500},
    aliases=("qwen-30b",),
    description="Qwen 3 30B FP8 — Reasoning model",
    best="DevsDo",
)

qwen_1_5_14b = Model(
    name="qwen1.5-14b",
    display="Qwen 1.5 14B Chat AWQ",
    family="Qwen",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/qwen/qwen1.5-14b-chat-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 7500},
    aliases=("qwen-14b",),
    description="Qwen 1.5 14B AWQ quantised",
    best="DevsDo",
)

qwen_1_5_7b = Model(
    name="qwen1.5-7b",
    display="Qwen 1.5 7B Chat AWQ",
    family="Qwen",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/qwen/qwen1.5-7b-chat-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 20000},
    aliases=("qwen-7b",),
    description="Qwen 1.5 7B AWQ quantised",
    best="DevsDo",
)

qwen_1_5_1_8b = Model(
    name="qwen1.5-1.8b",
    display="Qwen 1.5 1.8B Chat",
    family="Qwen",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/qwen/qwen1.5-1.8b-chat"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 32000},
    aliases=("qwen-1.8b",),
    description="Qwen 1.5 1.8B — Compact",
    best="DevsDo",
)

qwen_1_5_0_5b = Model(
    name="qwen1.5-0.5b",
    display="Qwen 1.5 0.5B Chat",
    family="Qwen",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/qwen/qwen1.5-0.5b-chat"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 32000},
    aliases=("qwen-0.5b",),
    description="Qwen 1.5 0.5B — Tiny",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  DEEPSEEK FAMILY                                        │
# └─────────────────────────────────────────────────────────┘

deepseek_r1_32b = Model(
    name="deepseek-r1-32b",
    display="DeepSeek R1 Distill Qwen 32B",
    family="DeepSeek",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
        "LLMChat": "deepseek-ai/deepseek-r1-distill-qwen-32b",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", reasoning=True),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 80000, "LLMChat": 79500},
    aliases=("deepseek-r1", "deepseek-32b"),
    description="DeepSeek R1 Distill — Thinking model with <think> tags",
    best="DevsDo",
)

deepseek_math_7b = Model(
    name="deepseek-math-7b",
    display="DeepSeek Math 7B Instruct",
    family="DeepSeek",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/deepseek-ai/deepseek-math-7b-instruct"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("deepseek-math",),
    description="DeepSeek Math 7B — Math specialist",
    best="DevsDo",
)

deepseek_coder_base = Model(
    name="deepseek-coder-base",
    display="DeepSeek Coder 6.7B Base AWQ",
    family="DeepSeek",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/thebloke/deepseek-coder-6.7b-base-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("deepseek-coder-6.7b-base",),
    description="DeepSeek Coder Base 6.7B (TheBloke AWQ)",
    best="DevsDo",
)

deepseek_coder_instruct = Model(
    name="deepseek-coder-instruct",
    display="DeepSeek Coder 6.7B Instruct AWQ",
    family="DeepSeek",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/thebloke/deepseek-coder-6.7b-instruct-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("deepseek-coder", "deepseek-coder-6.7b"),
    description="DeepSeek Coder Instruct 6.7B (TheBloke AWQ)",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  GOOGLE GEMMA FAMILY                                    │
# └─────────────────────────────────────────────────────────┘

gemma_4_26b = Model(
    name="gemma-4-26b",
    display="Gemma 4 26B A4B IT",
    family="Google",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/google/gemma-4-26b-a4b-it"},
    capabilities=_cf_caps("DevsDo", reasoning=True),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 256000},
    aliases=("gemma-4", "gemma-26b"),
    description="Google Gemma 4 26B — 256K context reasoning",
    best="DevsDo",
)

gemma_3_12b = Model(
    name="gemma-3-12b",
    display="Gemma 3 12B IT",
    family="Google",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/google/gemma-3-12b-it",
        "LLMChat": "google/gemma-3-12b-it",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 80000, "LLMChat": 79500},
    aliases=("gemma-12b",),
    description="Gemma 3 12B IT",
    best="DevsDo",
)

gemma_7b = Model(
    name="gemma-7b",
    display="Gemma 7B IT",
    family="Google",
    providers=("DevsDo", "mCloudFlare"),
    connection={
        "DevsDo": "@hf/google/gemma-7b-it",
        "mCloudFlare": "gemma-7b",
    },
    capabilities=_cf_caps("DevsDo", "mCloudFlare"),
    working={"DevsDo": True, "mCloudFlare": True},
    max_tokens={"DevsDo": 8192, "mCloudFlare": 2048},
    aliases=("gemma",),
    description="Gemma 7B Instruct",
    best="DevsDo",
)

gemma_2b_lora = Model(
    name="gemma-2b-lora",
    display="Google Gemma 2B IT LoRA",
    family="Google",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/google/gemma-2b-it-lora",
        "LLMChat": "google/gemma-2b-it-lora",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 8192, "LLMChat": 8000},
    aliases=("gemma-2b",),
    description="Google Gemma 2B with LoRA",
    best="DevsDo",
)

gemma_7b_lora = Model(
    name="gemma-7b-lora",
    display="Google Gemma 7B IT LoRA",
    family="Google",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/google/gemma-7b-it-lora"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 3500},
    aliases=("gemma-7b-it-lora",),
    description="Google Gemma 7B with LoRA",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  MISTRAL FAMILY                                         │
# └─────────────────────────────────────────────────────────┘

mistral_small_3_1 = Model(
    name="mistral-small-3.1",
    display="Mistral Small 3.1 24B Instruct",
    family="Mistral",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/mistralai/mistral-small-3.1-24b-instruct",
        "LLMChat": "mistralai/mistral-small-3.1-24b-instruct",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 128000, "LLMChat": 76500},
    aliases=("mistral-small", "mistral-24b"),
    description="Mistral Small 3.1 24B — 128K context",
    best="DevsDo",
)

mistral_7b_v0_2 = Model(
    name="mistral-7b-v0.2",
    display="Mistral 7B Instruct v0.2",
    family="Mistral",
    providers=("DevsDo", "LLMChat", "mCloudFlare"),
    connection={
        "DevsDo": "@hf/mistral/mistral-7b-instruct-v0.2",
        "LLMChat": "mistral/mistral-7b-instruct-v0.2",
        "mCloudFlare": "mistral",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", "mCloudFlare"),
    working={"DevsDo": True, "LLMChat": True, "mCloudFlare": True},
    max_tokens={"DevsDo": 3072, "LLMChat": 14500, "mCloudFlare": 2048},
    aliases=("mistral", "mistral-7b"),
    description="Mistral 7B Instruct v0.2",
    best="DevsDo",
)

mistral_7b_v0_2_lora = Model(
    name="mistral-7b-v0.2-lora",
    display="Mistral 7B Instruct v0.2 LoRA",
    family="Mistral",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/mistral/mistral-7b-instruct-v0.2-lora",
        "LLMChat": "mistral/mistral-7b-instruct-v0.2-lora",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 15000, "LLMChat": 14500},
    aliases=("mistral-lora",),
    description="Mistral 7B v0.2 with LoRA",
    best="DevsDo",
)

mistral_7b_v0_1 = Model(
    name="mistral-7b-v0.1",
    display="Mistral 7B Instruct v0.1",
    family="Mistral",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/mistral/mistral-7b-instruct-v0.1"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 2824},
    aliases=("mistral-v0.1",),
    description="Mistral 7B Instruct v0.1",
    best="DevsDo",
)

mistral_7b_v0_1_awq = Model(
    name="mistral-7b-v0.1-awq",
    display="Mistral 7B Instruct v0.1 AWQ",
    family="Mistral",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/thebloke/mistral-7b-instruct-v0.1-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("mistral-awq",),
    description="Mistral 7B v0.1 AWQ (TheBloke)",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  IBM GRANITE                                            │
# └─────────────────────────────────────────────────────────┘

granite_4_0_micro = Model(
    name="granite-4.0-micro",
    display="Granite 4.0 H Micro",
    family="IBM",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/ibm-granite/granite-4.0-h-micro",
        "LLMChat": "ibm-granite/granite-4.0-h-micro",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 131000, "LLMChat": 100000},
    aliases=("granite", "granite-micro"),
    description="IBM Granite 4.0 Micro",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  GLM / ZHIPU AI                                         │
# └─────────────────────────────────────────────────────────┘

glm_4_7_flash = Model(
    name="glm-4.7-flash",
    display="GLM 4.7 Flash",
    family="ZHIPU AI",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/zai-org/glm-4.7-flash",
        "LLMChat": "zai-org/glm-4.7-flash",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat", reasoning=True),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 131072, "LLMChat": 100000},
    aliases=("glm-flash", "glm-4.7", "glm"),
    description="ZHIPU AI GLM 4.7 Flash — Reasoning capable",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  AI SINGAPORE                                           │
# └─────────────────────────────────────────────────────────┘

sea_lion_27b = Model(
    name="sea-lion-27b",
    display="Gemma SEA-LION V4 27B IT",
    family="AI Singapore",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/aisingapore/gemma-sea-lion-v4-27b-it",
        "LLMChat": "aisingapore/gemma-sea-lion-v4-27b-it",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 128000, "LLMChat": 100000},
    aliases=("sea-lion",),
    description="AI Singapore SEA-LION V4 27B — Southeast Asia optimised",
    best="DevsDo",
)


# ┌─────────────────────────────────────────────────────────┐
# │  COMMUNITY / OTHER MODELS                               │
# └─────────────────────────────────────────────────────────┘

hermes_2_pro = Model(
    name="hermes-2-pro",
    display="Hermes 2 Pro Mistral 7B",
    family="NousResearch",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/nousresearch/hermes-2-pro-mistral-7b"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 24000},
    aliases=("hermes",),
    description="NousResearch Hermes 2 Pro Mistral 7B",
    best="DevsDo",
)

openhermes_2_5 = Model(
    name="openhermes-2.5",
    display="OpenHermes 2.5 Mistral 7B AWQ",
    family="NousResearch",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/thebloke/openhermes-2.5-mistral-7b-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("openhermes",),
    description="OpenHermes 2.5 Mistral 7B AWQ",
    best="DevsDo",
)

starling_7b = Model(
    name="starling-7b",
    display="Starling LM 7B Beta",
    family="NexusFlow",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/nexusflow/starling-lm-7b-beta"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("starling",),
    description="NexusFlow Starling LM 7B Beta",
    best="DevsDo",
)

neural_chat_7b = Model(
    name="neural-chat-7b",
    display="Neural Chat 7B v3.1 AWQ",
    family="Intel",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/thebloke/neural-chat-7b-v3-1-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("neural-chat",),
    description="Intel Neural Chat 7B v3.1 AWQ",
    best="DevsDo",
)

openchat_3_5 = Model(
    name="openchat-3.5",
    display="OpenChat 3.5 0106",
    family="OpenChat",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/openchat/openchat-3.5-0106"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 8192},
    aliases=("openchat",),
    description="OpenChat 3.5",
    best="DevsDo",
)

cybertron_7b = Model(
    name="cybertron-7b",
    display="Cybertron 7B v2 BF16",
    family="FBLGit",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/fblgit/una-cybertron-7b-v2-bf16"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 15000},
    aliases=("cybertron",),
    description="UNA Cybertron 7B v2 BF16",
    best="DevsDo",
)

discolm_german_7b = Model(
    name="discolm-german-7b",
    display="DiscoLM German 7B v1 AWQ",
    family="TheBloke",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/thebloke/discolm-german-7b-v1-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("discolm",),
    description="DiscoLM German 7B — German language model",
    best="DevsDo",
)

zephyr_7b = Model(
    name="zephyr-7b",
    display="Zephyr 7B Beta AWQ",
    family="HuggingFace",
    providers=("DevsDo",),
    connection={"DevsDo": "@hf/thebloke/zephyr-7b-beta-awq"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("zephyr",),
    description="Zephyr 7B Beta AWQ",
    best="DevsDo",
)

falcon_7b = Model(
    name="falcon-7b",
    display="Falcon 7B Instruct",
    family="TII UAE",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/tiiuae/falcon-7b-instruct"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 4096},
    aliases=("falcon",),
    description="TII Falcon 7B Instruct",
    best="DevsDo",
)

tinyllama_1_1b = Model(
    name="tinyllama-1.1b",
    display="TinyLlama 1.1B Chat v1.0",
    family="TinyLlama",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/tinyllama/tinyllama-1.1b-chat-v1.0"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 2048},
    aliases=("tinyllama",),
    description="TinyLlama 1.1B Chat",
    best="DevsDo",
)

phi_2 = Model(
    name="phi-2",
    display="Phi-2",
    family="Microsoft",
    providers=("DevsDo",),
    connection={"DevsDo": "@cf/microsoft/phi-2"},
    capabilities=_cf_caps("DevsDo"),
    working={"DevsDo": True},
    max_tokens={"DevsDo": 2048},
    aliases=("phi",),
    description="Phi-2 — Compact research model",
    best="DevsDo",
)

sqlcoder_7b = Model(
    name="sqlcoder-7b",
    display="SQLCoder 7B 2",
    family="Defog",
    providers=("DevsDo", "LLMChat"),
    connection={
        "DevsDo": "@cf/defog/sqlcoder-7b-2",
        "LLMChat": "defog/sqlcoder-7b-2",
    },
    capabilities=_cf_caps("DevsDo", "LLMChat"),
    working={"DevsDo": True, "LLMChat": True},
    max_tokens={"DevsDo": 10000, "LLMChat": 9500},
    aliases=("sqlcoder",),
    description="SQLCoder 7B — SQL generation specialist",
    best="DevsDo",
)


# ═══════════════════════════════════════════════════════════
# §3 — MODEL REGISTRY
# ═══════════════════════════════════════════════════════════
class ModelRegistry:
    """Unified model registry with lookups and filters."""

    _models: Dict[str, Model] = {
        # ── Upstage / Solar ───────────────────────────────
        "solar-pro3": solar_pro3,
        "solar-pro2": solar_pro2,
        "syn-pro": syn_pro,
        "solar-mini": solar_mini,

        # ── Mercury ───────────────────────────────────────
        "mercury": mercury_high,

        # ── Dolphin ───────────────────────────────────────
        "dolphin-24b": dolphin_24b,
        "dolphin-flash": dolphin_flash,

        # ── OpenAI OSS ────────────────────────────────────
        "gpt-oss-120b": gpt_oss_120b,
        "gpt-oss-20b": gpt_oss_20b,

        # ── NVIDIA ────────────────────────────────────────
        "nemotron-120b": nemotron_120b,

        # ── Moonshot AI / Kimi ────────────────────────────
        "kimi-k2.5": kimi_k2_5,

        # ── Meta Llama ────────────────────────────────────
        "llama-4-scout": llama_4_scout,
        "llama-3.3-70b": llama_3_3_70b,
        "llama-3.1-70b": llama_3_1_70b,
        "llama-3.2-11b-vision": llama_3_2_11b_vision,
        "llama-3.1-8b": llama_3_1_8b,
        "llama-3.1-8b-fp8": llama_3_1_8b_fp8,
        "llama-3.1-8b-awq": llama_3_1_8b_awq,
        "llama-3.2-3b": llama_3_2_3b,
        "llama-3.2-1b": llama_3_2_1b,
        "llama-3-8b": llama_3_8b,
        "llama-3-8b-awq": llama_3_8b_awq,
        "llama-3-8b-hf": llama_3_8b_hf,
        "llama-guard-3": llama_guard_3,
        "llama-2-7b-fp16": llama_2_7b_fp16,
        "llama-2-7b-int8": llama_2_7b_int8,
        "llama-2-7b-lora": llama_2_7b_lora,
        "llama-2-13b": llama_2_13b,

        # ── Qwen ──────────────────────────────────────────
        "qwq-32b": qwq_32b,
        "qwen-coder-32b": qwen_coder_32b,
        "qwen3-30b": qwen3_30b,
        "qwen1.5-14b": qwen_1_5_14b,
        "qwen1.5-7b": qwen_1_5_7b,
        "qwen1.5-1.8b": qwen_1_5_1_8b,
        "qwen1.5-0.5b": qwen_1_5_0_5b,

        # ── DeepSeek ──────────────────────────────────────
        "deepseek-r1-32b": deepseek_r1_32b,
        "deepseek-math-7b": deepseek_math_7b,
        "deepseek-coder-base": deepseek_coder_base,
        "deepseek-coder-instruct": deepseek_coder_instruct,

        # ── Google Gemma ──────────────────────────────────
        "gemma-4-26b": gemma_4_26b,
        "gemma-3-12b": gemma_3_12b,
        "gemma-7b": gemma_7b,
        "gemma-2b-lora": gemma_2b_lora,
        "gemma-7b-lora": gemma_7b_lora,

        # ── Mistral ───────────────────────────────────────
        "mistral-small-3.1": mistral_small_3_1,
        "mistral-7b-v0.2": mistral_7b_v0_2,
        "mistral-7b-v0.2-lora": mistral_7b_v0_2_lora,
        "mistral-7b-v0.1": mistral_7b_v0_1,
        "mistral-7b-v0.1-awq": mistral_7b_v0_1_awq,

        # ── IBM ───────────────────────────────────────────
        "granite-4.0-micro": granite_4_0_micro,

        # ── ZHIPU AI / GLM ────────────────────────────────
        "glm-4.7-flash": glm_4_7_flash,

        # ── AI Singapore ──────────────────────────────────
        "sea-lion-27b": sea_lion_27b,

        # ── Community / Other ─────────────────────────────
        "hermes-2-pro": hermes_2_pro,
        "openhermes-2.5": openhermes_2_5,
        "starling-7b": starling_7b,
        "neural-chat-7b": neural_chat_7b,
        "openchat-3.5": openchat_3_5,
        "cybertron-7b": cybertron_7b,
        "discolm-german-7b": discolm_german_7b,
        "zephyr-7b": zephyr_7b,
        "falcon-7b": falcon_7b,
        "tinyllama-1.1b": tinyllama_1_1b,
        "phi-2": phi_2,
        "sqlcoder-7b": sqlcoder_7b,
    }

    # ── Build alias map ───────────────────────────────────
    _aliases: Dict[str, str] = {}
    for _name, _model in _models.items():
        for _alias in _model.aliases:
            _aliases[_alias.lower()] = _name

    # ═══════════════════════════════════════════════════════
    # LOOKUP METHODS
    # ═══════════════════════════════════════════════════════
    @classmethod
    def get(cls, name: str) -> Optional[Model]:
        """Get model by name or alias (case-insensitive)."""
        key = name.lower().strip()

        # Direct lookup
        if key in cls._models:
            return cls._models[key]

        # Alias lookup
        if key in cls._aliases:
            return cls._models[cls._aliases[key]]

        # Partial match (first hit)
        for model_name, model in cls._models.items():
            if key in model_name:
                return model

        return None

    @classmethod
    def all(cls) -> List[Model]:
        """Return all registered models."""
        return list(cls._models.values())

    @classmethod
    def names(cls) -> List[str]:
        """Return all primary model names."""
        return list(cls._models.keys())

    @classmethod
    def by_provider(cls, provider: str) -> List[Model]:
        """Get all models available on a provider."""
        return [m for m in cls._models.values() if provider in m.providers]

    @classmethod
    def by_family(cls, family: str) -> List[Model]:
        """Get all models in a family."""
        fl = family.lower()
        return [m for m in cls._models.values() if m.family.lower() == fl]

    @classmethod
    def by_capability(cls, capability: str) -> List[Model]:
        """Get models that support a capability on ANY provider."""
        return [m for m in cls._models.values() if m.supports(capability)]

    @classmethod
    def filter(
        cls,
        provider: Optional[str] = None,
        family: Optional[str] = None,
        reasoning: Optional[bool] = None,
        vision: Optional[bool] = None,
        search: Optional[bool] = None,
        attachment: Optional[bool] = None,
        working: Optional[bool] = None,
        min_context: Optional[int] = None,
    ) -> List[Model]:
        """Filter models by multiple criteria."""
        result = cls.all()

        if provider:
            result = [m for m in result if provider in m.providers]
        if family:
            fl = family.lower()
            result = [m for m in result if m.family.lower() == fl]
        if reasoning is not None:
            result = [m for m in result if m.supports("reasoning") == reasoning]
        if vision is not None:
            result = [m for m in result if m.supports("vision") == vision]
        if search is not None:
            result = [m for m in result if m.supports("search") == search]
        if attachment is not None:
            result = [m for m in result if m.supports("attachment") == attachment]
        if working is not None:
            result = [m for m in result if any(m.working.values()) == working]
        if min_context is not None:
            result = [
                m for m in result
                if max(m.max_tokens.values(), default=0) >= min_context
            ]

        return result

    @classmethod
    def list_providers(cls) -> List[str]:
        """Get sorted list of all providers."""
        providers: set[str] = set()
        for model in cls._models.values():
            providers.update(model.providers)
        return sorted(providers)

    @classmethod
    def list_families(cls) -> List[str]:
        """Get sorted list of all model families."""
        return sorted({m.family for m in cls._models.values()})

    @classmethod
    def count(cls) -> int:
        """Total number of registered models."""
        return len(cls._models)
    
    @classmethod
    def family_payload(
        cls,
        server: str = "Adarsh v1",
        version: str = "1.0.0",
        favicon_map: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Return models grouped by family in this format:

        {
          "server": "...",
          "version": "...",
          "timestamp": ...,
          "generated_at": "...",
          "total_models": ...,
          "total_families": ...,
          "families": [
            {
              "family": "...",
              "count": ...,
              "favicon": "...",
              "models": [...]
            }
          ]
        }
        """
        if favicon_map is None:
            favicon_map = DEFAULT_FAVICON_MAP

        grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)

        for model in cls.all():
            family_name = getattr(model, "family", "Unknown")
            grouped[family_name].append(_model_to_family_api(model))

        families: List[Dict[str, Any]] = []
        for family_name in sorted(grouped.keys(), key=lambda x: x.lower()):
            models = grouped[family_name]
            models.sort(key=lambda x: x["id"])
            families.append({
                "family": family_name,
                "count": len(models),
                "favicon": favicon_map.get(
                    family_name,
                    "https://huggingface.co/favicon.ico",
                ),
                "models": models,
            })

        families.sort(key=lambda x: (-x["count"], x["family"].lower()))

        return {
            "server": server,
            "version": version,
            "timestamp": int(datetime.now().timestamp()),
            "generated_at": datetime.now().isoformat(),
            "total_models": sum(item["count"] for item in families),
            "total_families": len(families),
            "families": families,
        }

    @classmethod
    def summary(cls) -> str:
        """Print a summary table."""
        lines = [
            f"{'Name':<28} {'Family':<14} {'Providers':<30} {'MaxCtx':>8} {'Reason':>6} {'Vision':>6}",
            "─" * 96,
        ]
        for name, m in cls._models.items():
            ctx = max(m.max_tokens.values(), default=0)
            provs = ", ".join(m.providers)
            r = "✓" if m.supports("reasoning") else "·"
            v = "✓" if m.supports("vision") else "·"
            lines.append(f"{name:<28} {m.family:<14} {provs:<30} {ctx:>8,} {r:>6} {v:>6}")
        return "\n".join(lines)


# ═══════════════════════════════════════════════════════════
# §4 — EXPORTS
# ═══════════════════════════════════════════════════════════
__all__ = [
    "Model",
    "ModelRegistry",
]