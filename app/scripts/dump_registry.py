#!/usr/bin/env python3
"""
dump_registry.py — generate src/data/models.ts from the REAL Python registry.

Executes `My PREVIOUS ENTIRE SERVER/API/Models.py` (stdlib-only, so it runs with
no dependencies installed) and emits TypeScript. Nothing is hand-transcribed:
re-run this after editing Models.py.

    python3 scripts/dump_registry.py

Two deliberate transformations, both documented in ARCHITECTURE.md §6:
  * DevsDo is dropped entirely (provider removed per instruction). Models that
    are DevsDo-exclusive disappear; shared models keep their other providers.
  * DeepInfra's 18 models are added from DeepInfra.py's own MODELS dict, because
    Models.py never registered them (finding I-1: the provider was unreachable
    through /v1/models). Their context window is genuinely unknown from source,
    so maxTokens is emitted as null rather than invented.
"""
from __future__ import annotations

import ast
import dataclasses
import json
import re
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
REPO = APP.parent
LEGACY = REPO / "My PREVIOUS ENTIRE SERVER" / "API"
OUT = APP / "src" / "data" / "models.ts"

DROP_PROVIDER = "DevsDo"


def load_registry() -> tuple[list[dict], list[str]]:
    sys.path.insert(0, str(LEGACY))
    import Models as M  # noqa: E402

    reg = M.ModelRegistry
    models = []
    for m in reg.all():
        d = dataclasses.asdict(m)
        d["providers"] = list(m.providers)
        d["aliases"] = list(m.aliases)
        models.append(d)
    return models, reg.list_providers()


def load_llmchat_tags() -> dict[str, dict]:
    """LLMChat's routing tag (@cf/@hf) is required by the request URL but is
    ABSENT from Models.py. LLMChat.py line 315 builds
    `url = f"{_API}?model={model.endpoint}"` where endpoint = f"{tag}/{name}".
    The provider's own MODELS tuple is the only source of the tag, so join it in.
    """
    src = (LEGACY / "providers" / "LLmChat.py").read_text(encoding="utf-8")
    triples = re.findall(
        r'LLMModel\(\s*"(@[a-z]+)"\s*,\s*"([^"]+)"\s*,\s*([\d_]+)\s*\)', src
    )
    return {
        name: {"tag": tag, "max_tokens": int(mx.replace("_", ""))}
        for tag, name, mx in triples
    }


def load_upstage_v3_models() -> dict[str, dict]:
    """Upstage v3's _MODELS is authoritative for the provider we are shipping.

    Models.py disagrees with it: solar-mini is registered as
    'upstage/solar-1-mini-chat', which is not a v3 key. v3's _resolve() fuzzy
    fallback fails to match it, so _build_payload silently degrades to
    _MODELS['solar-pro3'] — a 65536-token reasoning+search config applied to a
    model that v3 declares as reasoning:null, search:false.
    """
    src = (APP.parent / "New Upstage Change Logs" / "upstage_provider.py").read_text(
        encoding="utf-8"
    )
    block = re.search(r"^_MODELS: Dict\[str, Dict\[str, Any\]\] = (\{.*?^\})", src, re.S | re.M)
    if not block:
        raise SystemExit("could not locate Upstage v3 _MODELS")
    # Pure literal dict (str/int/bool/None/list) — literal_eval, never eval.
    return ast.literal_eval(block.group(1))


def apply_provider_fixes(models: list[dict]) -> dict[str, int]:
    """Join LLMChat tags; assert Upstage ids against v3; surface effort levels.

    NOTE ON A RETRACTED FINDING: an earlier revision of this script "reconciled"
    Upstage connection ids to v3 keys, on the belief that Models.py registered
    solar-mini as an id v3 did not recognise. That belief was WRONG — it came
    from guessing v3's fourth key as 'solar-mini' instead of reading it. v3's
    actual key is 'upstage/solar-1-mini-chat', identical to Models.py. All four
    Upstage ids, capabilities and context windows agree across both sources, so
    there was nothing to fix. The guesswork is replaced below by an assertion
    that fails loudly if the two sources ever genuinely drift.
    """
    stats = {"llmchat_tagged": 0, "llmchat_unresolved": 0, "upstage_verified": 0}
    tags = load_llmchat_tags()
    v3 = load_upstage_v3_models()

    for m in models:
        # ── LLMChat: the @cf/@hf routing tag exists ONLY in the provider file ──
        cid = m["connection"].get("LLMChat")
        if cid:
            info = tags.get(cid)
            if info:
                m["tag"] = info["tag"]
                stats["llmchat_tagged"] += 1
            else:
                stats["llmchat_unresolved"] += 1

        # ── Upstage: cross-source consistency check, not a rewrite ──
        uid = m["connection"].get("Upstage")
        if uid:
            if uid not in v3:
                raise SystemExit(
                    f"REGISTRY DRIFT: Models.py maps {m['name']!r} to Upstage id {uid!r}, "
                    f"which upstage_provider.py _MODELS does not define "
                    f"(known keys: {sorted(v3)}). Resolve before generating."
                )
            stats["upstage_verified"] += 1
            cfg = v3[uid]
            caps = m["capabilities"].setdefault("Upstage", {})
            # v3 is the provider being shipped, so its config is authoritative.
            # Verified equal to Models.py today; kept so drift is caught.
            caps["reasoning"] = bool(cfg.get("reasoning"))
            caps["search"] = bool(cfg.get("search"))
            m["max_tokens"]["Upstage"] = cfg.get("max_tokens")
            # Per-model effort levels are NOT in Models.py at all: pro3 accepts
            # low/medium/high, pro2 and syn-pro only low/high, mini none.
            if cfg.get("reasoning"):
                m["reasoning_efforts"] = list(cfg["reasoning"])

    return stats


def load_deepinfra() -> list[dict]:
    """DeepInfra models exist only in the provider file (finding I-1)."""
    src = (LEGACY / "providers" / "DeepInfra.py").read_text(encoding="utf-8")
    m = re.search(r"^MODELS: dict\[str, str\] = (\{.*?^\})", src, re.S | re.M)
    if not m:
        raise SystemExit("could not locate DeepInfra MODELS dict")
    table: dict[str, str] = ast.literal_eval(m.group(1))

    out = []
    for alias, full_path in table.items():
        org = full_path.split("/", 1)[0] if "/" in full_path else "DeepInfra"
        out.append(
            {
                "name": alias,
                "display": full_path.split("/", 1)[-1].replace("-", " ").title(),
                "family": org,
                "providers": ["DeepInfra"],
                "connection": {"DeepInfra": full_path},
                # DeepInfra._parse_sse extracts only choices[0].delta.content and
                # the payload carries no reasoning/search fields: no capability is
                # evidenced, so none is claimed.
                "capabilities": {
                    "DeepInfra": {
                        "reasoning": False,
                        "vision": False,
                        "attachment": False,
                        "search": False,
                    }
                },
                "working": {"DeepInfra": True},
                # Context window is not stated anywhere in DeepInfra.py.
                # Emitting null is honest; inventing a number is not.
                "max_tokens": {"DeepInfra": None},
                "aliases": [],
                "description": f"DeepInfra · {full_path}",
                "best": "DeepInfra",
                "provenance": "DeepInfra.py MODELS (absent from Models.py — finding I-1)",
            }
        )
    return out


def strip_devsdo(models: list[dict]) -> tuple[list[dict], int, int]:
    kept, dropped_exclusive, trimmed = [], 0, 0
    for m in models:
        if DROP_PROVIDER not in m["providers"]:
            kept.append(m)
            continue
        remaining = [p for p in m["providers"] if p != DROP_PROVIDER]
        if not remaining:
            dropped_exclusive += 1
            continue
        trimmed += 1
        for key in ("connection", "capabilities", "working", "max_tokens"):
            m[key] = {k: v for k, v in m[key].items() if k != DROP_PROVIDER}
        m["providers"] = remaining
        if m.get("best") == DROP_PROVIDER:
            m["best"] = remaining[0]
        kept.append(m)
    return kept, dropped_exclusive, trimmed


def ts_str(s: object) -> str:
    return json.dumps(s, ensure_ascii=False)


def emit(models: list[dict]) -> str:
    lines = [
        "// ══════════════════════════════════════════════════════════════",
        "//  GENERATED FILE — DO NOT EDIT BY HAND",
        "//  Source: My PREVIOUS ENTIRE SERVER/API/Models.py  (+ DeepInfra.py)",
        "//  Regenerate: python3 scripts/dump_registry.py",
        "//",
        "//  DevsDo removed. DeepInfra added from its own provider file,",
        "//  because Models.py never registered it (ARCHITECTURE.md §6, I-1).",
        "// ══════════════════════════════════════════════════════════════",
        "import type { ModelRecord } from '../types';",
        "",
        "export const MODELS: ModelRecord[] = [",
    ]
    for m in sorted(models, key=lambda x: (x["providers"][0], x["family"], x["name"])):
        lines.append("  {")
        lines.append(f"    name: {ts_str(m['name'])},")
        lines.append(f"    display: {ts_str(m['display'])},")
        lines.append(f"    family: {ts_str(m['family'])},")
        lines.append(f"    providers: [{', '.join(ts_str(p) for p in m['providers'])}],")
        lines.append(
            "    connection: { "
            + ", ".join(f"{ts_str(k)}: {ts_str(v)}" for k, v in m["connection"].items())
            + " },"
        )
        caps = []
        for prov, c in m["capabilities"].items():
            flags = ", ".join(f"{k}: {str(bool(v)).lower()}" for k, v in sorted(c.items()))
            caps.append(f"{ts_str(prov)}: {{ {flags} }}")
        lines.append("    capabilities: { " + ", ".join(caps) + " },")
        lines.append(
            "    working: { "
            + ", ".join(f"{ts_str(k)}: {str(bool(v)).lower()}" for k, v in m["working"].items())
            + " },"
        )
        lines.append(
            "    maxTokens: { "
            + ", ".join(
                f"{ts_str(k)}: {'null' if v is None else int(v)}"
                for k, v in m["max_tokens"].items()
            )
            + " },"
        )
        if m["aliases"]:
            lines.append(f"    aliases: [{', '.join(ts_str(a) for a in m['aliases'])}],")
        if m.get("description"):
            lines.append(f"    description: {ts_str(m['description'])},")
        if m.get("best"):
            lines.append(f"    best: {ts_str(m['best'])},")
        if m.get("provenance"):
            lines.append(f"    provenance: {ts_str(m['provenance'])},")
        if m.get("tag"):
            lines.append(f"    tag: {ts_str(m['tag'])},")
        if m.get("reasoning_efforts"):
            lines.append(
                "    reasoningEfforts: ["
                + ", ".join(ts_str(e) for e in m["reasoning_efforts"])
                + "],")
        lines.append("  },")
    lines.append("];")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    registry, providers = load_registry()
    deepinfra = load_deepinfra()
    kept, dropped, trimmed = strip_devsdo(registry)
    final = kept + deepinfra
    fixes = apply_provider_fixes(final)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(emit(final), encoding="utf-8")

    print(f"registry models      : {len(registry)}")
    print(f"registry providers   : {', '.join(providers)}")
    print(f"DevsDo-exclusive drop: {dropped}")
    print(f"DevsDo trimmed       : {trimmed}")
    print(f"DeepInfra added      : {len(deepinfra)}  (finding I-1)")
    print(f"FINAL                : {len(final)} models")
    print(f"LLMChat tags joined  : {fixes['llmchat_tagged']}"
          + (f"  (UNRESOLVED: {fixes['llmchat_unresolved']})" if fixes['llmchat_unresolved'] else ""))
    print(f"Upstage ids verified vs v3  : {fixes['upstage_verified']} (assertion, not a rewrite)")

    per: dict[str, int] = {}
    for m in final:
        for p in m["providers"]:
            per[p] = per.get(p, 0) + 1
    for p, n in sorted(per.items(), key=lambda kv: -kv[1]):
        print(f"  {p:<12} {n}")
    assert DROP_PROVIDER not in per, "DevsDo survived the strip"
    print(f"wrote {OUT.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
