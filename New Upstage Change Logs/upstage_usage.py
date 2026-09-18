"""
══════════════════════════════════════════════════════════════
  📖  upstage_usage.py — every feature, one runnable script (v3)

  Run:  python3 upstage_usage.py

  Fully async, realtime streaming over curl_cffi.
  Makes a few tiny real API calls (max_tokens kept low).

  The last demo prints the SESSION USAGE REPORT — the
  "usage department": per-turn timing, time-to-first-token,
  token counts, thinking/answer sizes, sources, totals.
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from upstage_provider import UpstageProvider

HAS_COLOR = sys.stdout.isatty() and __import__("os").environ.get("NO_COLOR") is None

def _c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if HAS_COLOR else text

DIM, BOLD, YELLOW, CYAN, GREEN = "2", "1", "33", "36", "32"


def rule(title: str):
    print(f"\n{'═' * 66}\n  {title}\n{'═' * 66}")


def usage_line(up: UpstageProvider):
    if up.last_usage:
        print(_c("   " + up.last_usage.format_line(), DIM))


# ─────────────────────────────────────────────────────────────
async def demo_1_realtime_stream():
    rule("1 · REALTIME STREAM — plain chat(), tokens as they land")

    up = UpstageProvider()                     # default: solar-pro3
    print(f"provider: {up}")

    print("assistant ▸ ", end="", flush=True)
    async for token in up.chat(data="Say hello in exactly five words.",
                               max_tokens=100):
        print(token, end="", flush=True)
    print()
    print(f"   ↳ last_response: {up.last_response!r}")
    print(f"   ↳ history now:   {len(up.history)} messages")
    usage_line(up)


# ─────────────────────────────────────────────────────────────
async def demo_2_typed_events_and_thinking():
    rule("2 · TYPED EVENTS — stream(): thinking (dim) vs answer (bright)")

    up = UpstageProvider(system="Global fallback system prompt (unused here)")

    print("assistant ▸ ", end="", flush=True)
    phase = None
    async for ev in up.stream(
        messages=[
            {"role": "system",    "content": "You are Bob, a pirate."},
            {"role": "user",      "content": "Greet me in one short line."},
            {"role": "assistant", "content": "Ahoy!"},
            {"role": "user",      "content": "Again, but laconic."},
        ],
        model="solar-pro2",          # per-call override
        reasoning="high",            # per-call override
        max_tokens=200,
    ):
        if ev.kind == "thinking":
            if phase is None:
                print(_c("💭 ", YELLOW), end="", flush=True)
                phase = "thinking"
            print(_c(ev.text, DIM), end="", flush=True)
        elif ev.kind == "content":
            if phase == "thinking":
                print(f"\n{' ' * 14}{_c('📝 ', CYAN)}", end="", flush=True)
            phase = "content"
            print(ev.text, end="", flush=True)
    print()
    print(f"   ↳ history (messages mode replaces it): "
          f"{[m['role'] for m in up.history]}")
    usage_line(up)


# ─────────────────────────────────────────────────────────────
async def demo_3_web_search():
    rule("3 · WEB SEARCH — sources streamed first, then the answer")

    up = UpstageProvider()

    print("assistant ▸ ", end="", flush=True)
    got_sources = False
    async for ev in up.stream(
        data="What is the capital of France? Answer in at most 5 words.",
        search=True,             # → tavily + high reasoning (auto)
        max_tokens=200,
    ):
        if ev.kind == "sources":
            blob = json.loads(ev.text)
            print(_c(f"  [📚 {len(blob['sources'])} sources collected]\n", DIM),
                  end="")
            got_sources = True
        elif ev.kind == "thinking":
            pass                  # skipped for demo brevity
        elif ev.kind == "content":
            print(ev.text, end="", flush=True)
    print()
    print(f"   ↳ first streamed event was sources: {got_sources}")
    print(f"   ↳ last_response: {up.last_response!r}")
    print(f"   ↳ last_sources : {len(up.last_sources)} unique URLs")
    print(up.last_sources_text)   # pretty text block
    usage_line(up)


# ─────────────────────────────────────────────────────────────
async def demo_4_session_usage_department():
    rule("4 · USAGE DEPARTMENT — several turns, then the session report")

    up = (UpstageProvider()
          .set_model("mini")          # alias → upstage/solar-1-mini-chat
          .set_search(False)
          .set_temperature(0.2))

    for q, mt in [
        ("Count from 1 to 4, nothing else.", 120),
        ("What colour is the sky? One word.", 60),
    ]:
        print(f"you ▸ {q}")
        print("assistant ▸ ", end="", flush=True)
        async for ev in up.stream(data=q, max_tokens=mt):
            if ev.kind == "content":
                print(ev.text, end="", flush=True)
        print()
        usage_line(up)

    if up.last_reasoning:
        print(f"   ↳ (last turn: {len(up.last_reasoning)} chars of thinking "
              f"kept out of the answer)")

    print()
    print(up.session_usage.format_report())

    # chainable setters + session management
    print("   ↳ models:")
    for m in up.list_models():
        mark = "★" if m["active"] else " "
        print(f"     {mark} {m['name']:<28} max_tokens={m['max_tokens']} "
              f"reasoning={m['reasoning']}")

    print("   ↳ history before reset:",
          [m["role"] for m in up.get_history()])
    up.new_session()
    print(f"   ↳ after new_session(): history={up.history}, "
          f"last_response={up.last_response!r}, "
          f"usage turns={up.session_usage.totals()['turns']}")


# ─────────────────────────────────────────────────────────────
async def demo_5_credentials_and_lifecycle():
    rule("5 · CONTEXT MANAGER + CREDENTIAL REFRESH (pure HTTP)")

    async with UpstageProvider() as up:
        await up.connect()          # loads cached creds (or re-captures)
        token = await up._creds.verify()
        print(f"   ↳ cached token valid: {bool(token)}")
        # force a pure-HTTP re-capture (~2-5s, no browser):
        await up.refresh_credentials()
        token2 = await up._creds.verify()
        print(f"   ↳ after refresh_credentials(): token valid: {bool(token2)}")
        print(f"   ↳ action id (len {len(up._creds.action_token)}): "
              f"{up._creds.action_token[:16]}…")
        print(f"   ↳ {up}")


# ═════════════════════════════════════════════════════════════
async def main():
    print(_c("☀️  Upstage Solar — usage walkthrough (v3, fully async, "
             "live calls, tiny budgets)", BOLD))
    try:
        await demo_1_realtime_stream()
        await demo_2_typed_events_and_thinking()
        await demo_3_web_search()
        await demo_4_session_usage_department()
        await demo_5_credentials_and_lifecycle()
    except Exception as e:
        print(f"\n⚠ stopped: {type(e).__name__}: {e}", file=sys.stderr)
        print("  (credential problem? try: "
              "python3 -c \"import asyncio, upstage_provider as p; "
              "asyncio.run(p.UpstageProvider.clear_credentials())\")",
              file=sys.stderr)
        raise SystemExit(1)
    print(f"\n{'═' * 66}\n  ✅ all demos finished\n{'═' * 66}")


if __name__ == "__main__":
    asyncio.run(main())
