#!/usr/bin/env python3
"""
══════════════════════════════════════════════════════════════
  💬  upstage_interactive.py — live chat REPL for Upstage Solar (v3)

  Run:   python3 upstage_interactive.py
         python3 upstage_interactive.py --model pro2 --search
         python3 upstage_interactive.py --thinking high
         python3 upstage_interactive.py --selftest     (offline smoke check)

  Type messages and hit enter — tokens stream in live over a single
  asyncio loop (curl_cffi AsyncSession, no threads).

  Rendering:
    assistant ▸ 💭 thinking tokens (dim)
                📝 answer tokens   (bright)
       ⏱ 3.2s · first token 1.1s · ~128 tok (est) · 40 tok/s · solar-pro3

  Commands:
    /help                      this list
    /models                    list models (★ = active)
    /model <name|alias>        switch model (solar3, pro2, syn, mini…)
    /system <text>             set the system prompt
    /search on|off             web search (auto-high reasoning when on)
    /think auto|low|med|high   reasoning effort (auto = search-based)
    /history                   show conversation turns
    /sources                   show sources from the last search
    /usage                     session usage report (the usage department)
    /clear                     drop conversation history
    /reset                     clear history + last_* state + usage stats
    /credits                   force credential re-capture (~2-5s)
    /quit                      exit (also: Ctrl-D)
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from upstage_provider import UpstageProvider   # noqa: E402

# ─────────────────────────────────────────────────────────────
# colors (auto-off when piped / NO_COLOR set)
# ─────────────────────────────────────────────────────────────
HAS_COLOR = sys.stdout.isatty() and os.environ.get("NO_COLOR") is None

def c(text: str, code: str) -> str:
    return f"\033[{code}m{text}\033[0m" if HAS_COLOR else text

DIM, BOLD, CYAN, GREEN, YELLOW, RED, MAGENTA = "2", "1", "36", "32", "33", "31", "35"

PROMPT      = c("you ▸ ", BOLD + CYAN)
CONT_PROMPT = c("   ⋮ ", BOLD + CYAN)
BANNER_RULE = "─" * 62


# ─────────────────────────────────────────────────────────────
# command parsing (pure → unit-testable)
# ─────────────────────────────────────────────────────────────
VALID_MODELS_ALIASES = {
    "solar-pro3", "solar-pro2", "syn-pro", "upstage/solar-1-mini-chat",
    "solar3", "solar2", "syn", "mini", "pro3", "pro2",
}
VALID_THINKING = {"auto", "low", "med", "medium", "high"}


def parse_command(line: str) -> tuple[str, str]:
    """
    '  /model pro2 ' → ("model", "pro2")
    'hello world'    → ("chat", "hello world")
    '/'              → ("help", "")
    """
    s = line.strip()
    if not s:
        return ("help", "")
    if s.startswith("/"):
        cmd, _, arg = s[1:].partition(" ")
        return (cmd.strip().lower() or "help", arg.strip())
    return ("chat", s)


# ─────────────────────────────────────────────────────────────
# the REPL
# ─────────────────────────────────────────────────────────────
class Session:
    def __init__(self, args):
        self.up = UpstageProvider(
            model=args.model or None,
            search=bool(args.search),
        )
        self.thinking: str | None = None
        if args.thinking and args.thinking != "auto":
            self.thinking = "medium" if args.thinking == "med" else args.thinking

    # ── one chat turn (realtime, typed events) ───────────
    async def chat(self, text: str):
        kwargs: dict = {}
        if self.thinking:
            kwargs["reasoning"] = self.thinking

        print(c("assistant ▸ ", BOLD + MAGENTA), end="", flush=True)
        phase: str | None = None       # None → "thinking" → "content"
        prefix_len = len("assistant ▸ ")
        try:
            async for ev in self.up.stream(data=text, **kwargs):
                if ev.kind == "sources":
                    try:
                        n = len(json.loads(ev.text)["sources"])
                    except Exception:
                        n = "?"
                    print(c(f"  [📚 {n} sources collected]", DIM),
                          end="", flush=True)
                elif ev.kind == "thinking":
                    if phase is None:
                        print(c("💭 ", YELLOW), end="", flush=True)
                        phase = "thinking"
                    print(c(ev.text, DIM), end="", flush=True)
                elif ev.kind == "content":
                    if phase is None:
                        pass  # starts right after "assistant ▸ "
                    elif phase == "thinking":
                        print("\n" + " " * prefix_len + c("📝 ", CYAN),
                              end="", flush=True)
                    phase = "content"
                    print(ev.text, end="", flush=True)
                elif ev.kind == "done":
                    pass
            print()  # newline after the stream
        except KeyboardInterrupt:
            print()
            print(c("… (interrupted)", YELLOW))
            return
        except Exception as e:
            print(f"\n⚠  {e}", end="")
            hint = "  ↳ try: /credits" if "auth" in str(e).lower() else ""
            print(c(hint, YELLOW if hint else RED))
            return

        u = self.up.last_usage
        if u:
            print(c("   " + u.format_line(), DIM))
        if self.up.last_sources:
            for s in self.up.last_sources[:3]:
                print(c(f"     [{s['index']}] {s['title']} — {s['url']}", DIM))
            if len(self.up.last_sources) > 3:
                print(c(f"     … {len(self.up.last_sources) - 3} more "
                        f"(/sources)", DIM))

    # ── commands ─────────────────────────────────────────
    async def handle(self, line: str) -> bool:
        """Return False to quit."""
        cmd, arg = parse_command(line)

        if cmd == "chat":
            await self.chat(arg)
            return True

        if cmd == "quit":
            print(c("bye 👋", DIM))
            return False

        if cmd == "help":
            print(__doc__.split("Commands:")[-1].strip())
            return True

        if cmd == "models":
            for m in self.up.list_models():
                mark = c("★", YELLOW) if m["active"] else " "
                print(f"  {mark} {m['name']:<28} "
                      f"reasoning={m['reasoning']}  max_tokens={m['max_tokens']}")
            return True

        if cmd == "model":
            if not arg:
                print(f"  current: {self.up.model}")
                return True
            self.up.set_model(arg)
            print(f"  model → {self.up.model}")
            return True

        if cmd == "system":
            self.up.set_system(arg)
            print(f"  system prompt set ({len(arg)} chars)" if arg
                  else "  system prompt cleared")
            return True

        if cmd == "search":
            on = arg.lower() in ("on", "1", "true", "yes") if arg else None
            if on is None:
                print(f"  search is {'ON' if self.up.search else 'off'} "
                      f"(usage: /search on|off)")
                return True
            self.up.set_search(on)
            print(f"  search {'ON 🔍 (auto-high reasoning)' if on else 'off'}")
            return True

        if cmd == "think":
            if not arg:
                cur = self.thinking or "auto"
                print(f"  thinking: {cur} (auto = high w/ search, low without)")
                return True
            a = arg.lower()
            if a not in VALID_THINKING:
                print(c(f"  ✗ unknown effort {arg!r} — use auto|low|med|high", RED))
                return True
            self.thinking = ("medium" if a == "med" else a) if a != "auto" else None
            print(f"  thinking: {self.thinking or 'auto'}")
            return True

        if cmd == "history":
            hist = self.up.get_history()
            if not hist:
                print("  (empty)")
                return True
            for m in hist:
                body = m["content"].replace("\n", " ")
                if len(body) > 100:
                    body = body[:100] + "…"
                print(f"  {c(m['role'] + ':', DIM)} {body}")
            return True

        if cmd == "sources":
            if not self.up.last_sources:
                print("  (no sources yet — use /search on)")
                return True
            print(self.up.last_sources_text)
            return True

        if cmd in ("usage", "stats"):
            report = self.up.session_usage.format_report()
            if "no turns yet" in report:
                print("  (no turns yet)")
                return True
            print(report)
            return True

        if cmd == "clear":
            self.up.clear_history()
            print("  history cleared")
            return True

        if cmd == "reset":
            self.up.new_session()
            print("  session reset (history + sources + traces + usage stats)")
            return True

        if cmd == "credits":
            print("  re-capturing credentials (pure HTTP, ~2-5s)…", flush=True)
            try:
                await self.up.refresh_credentials()
                tok = await self.up._creds.verify()
                print(c("  ✓ fresh credentials" if tok
                        else "  ✗ verify failed", GREEN if tok else RED))
            except Exception as e:
                print(c(f"  ✗ {e}", RED))
            return True

        print(c(f"  ✗ unknown /{cmd} — try /help", YELLOW))
        return True


# ─────────────────────────────────────────────────────────────
# async REPL driver — one event loop for the whole session
# ─────────────────────────────────────────────────────────────
async def run_repl(s: Session) -> None:
    print(c("⏳ connecting (cached creds → instant, else ~2-5s capture)…",
            DIM), flush=True)
    try:
        await s.up.connect()
        print(c("✓ connected", GREEN))
    except Exception as e:
        print(c(f"✗ connect failed: {e}\n  (credentials will be retried on "
                f"first message)", RED))
    print()

    while True:
        try:
            line = input(PROMPT)
        except (EOFError, KeyboardInterrupt):
            print(c("\nbye 👋", DIM))
            return

        # multi-line: trailing backslash continues
        while line.rstrip().endswith("\\"):
            try:
                line = line.rstrip()[:-1] + "\n" + input(CONT_PROMPT)
            except (EOFError, KeyboardInterrupt):
                print()
                return

        if not line.strip():
            continue
        try:
            if not await s.handle(line):
                return
        except KeyboardInterrupt:
            print(c("\n… (cancelled)", YELLOW))
        except Exception as e:
            print(c(f"✗ {type(e).__name__}: {e}", RED))


# ─────────────────────────────────────────────────────────────
# selftest — offline smoke check, no network
# ─────────────────────────────────────────────────────────────
def selftest() -> int:
    print("selftest: starting (offline)…")
    assert parse_command("/model pro2") == ("model", "pro2")
    assert parse_command("  /SEARCH off  ") == ("search", "off")
    assert parse_command("/quit") == ("quit", "")
    assert parse_command("/") == ("help", "")
    assert parse_command("plain message") == ("chat", "plain message")
    assert parse_command("") == ("help", "")

    s = Session(argparse.Namespace(model=None, search=False, thinking=None))
    assert s.up.model == "solar-pro3"
    s.up.set_model("mini")
    assert s.up.model == "upstage/solar-1-mini-chat"
    s.up.set_search(True)
    assert s.up.search is True
    assert s.thinking is None
    assert s.up.list_models()
    assert UpstageProvider.model_info()["thinking"] is True

    # usage department (offline)
    from upstage_provider import TurnUsage, SessionUsage, ThinkSplitter
    tu = TurnUsage(model="solar-pro3", thinking_chars=120, content_chars=40,
                   elapsed_s=2.0, first_token_s=0.5, n_sources=2)
    assert tu.tokens == 40                       # (120+40)/4 estimate
    assert tu.tokens_estimated is True
    assert "solar-pro3" in tu.format_line()
    assert "📚 2" in tu.format_line()
    tu.api_usage = {"prompt_tokens": 10, "completion_tokens": 30, "total_tokens": 40}
    assert tu.tokens == 40 and tu.tokens_estimated is False
    su = SessionUsage()
    su.add(tu)
    rep = su.format_report()
    assert "TOTAL" in rep and "1 turns" in rep
    tu2 = TurnUsage(model="mini", ok=False, error="boom", elapsed_s=1.0)
    su.add(tu2)
    assert su.totals()["failed"] == 1
    # think splitter (last 6 chars held back as possible partial tag)
    sp = ThinkSplitter()
    assert sp.feed("ab") == []
    assert sp.feed("let me ") == [("content", "abl")]
    assert sp.feed("ok") == [("content", "et")]
    assert sp.flush() == [("content", " me ok")]
    sp2 = ThinkSplitter()
    assert sp2.feed("a<th") == []
    assert sp2.feed("ink>R") == [("content", "a")]
    assert sp2.feed("ans") == []
    assert sp2.flush() == [("thinking", "Rans")]
    print("selftest: ✅ all checks passed")
    return 0


# ─────────────────────────────────────────────────────────────
def banner(s: Session):
    print(c(BANNER_RULE, DIM))
    print(c("  ☀️  Upstage Solar — interactive (v3, fully async)", BOLD))
    print(c(BANNER_RULE, DIM))
    print(f"  {s.up}")
    print(f"  {c('type /help for commands · /usage for stats · /quit to exit', DIM)}\n")


def main() -> int:
    ap = argparse.ArgumentParser(description="Upstage Solar REPL")
    ap.add_argument("--model", default=None,
                    help="initial model (solar3, pro2, syn, mini, …)")
    ap.add_argument("--search", action="store_true",
                    help="start with web search ON")
    ap.add_argument("--thinking", default="auto",
                    choices=["auto", "low", "med", "high"],
                    help="reasoning effort (default: auto)")
    ap.add_argument("--selftest", action="store_true",
                    help="run offline smoke checks and exit")
    args = ap.parse_args()

    if args.selftest:
        return selftest()

    s = Session(args)
    banner(s)

    try:
        asyncio.run(run_repl(s))
    finally:
        pass
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print(c("\nbye 👋", DIM))
        raise SystemExit(0)
