"""
test_upstage.py — v3 provider test suite
══════════════════════════════════════════════════════════════
  Offline (always run):  parser, splitter, sources, models, payload,
                         stream assembly (canned events), creds, usage.
  Live (UPSTAGE_LIVE=1): real API — connect, realtime stream, search,
                         multi-turn, fresh credential capture.

  Run:  python3 -m pytest test_upstage.py -v
        UPSTAGE_LIVE=1 python3 -m pytest test_upstage.py -k Live -v
══════════════════════════════════════════════════════════════
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import List, Tuple

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))

from upstage_provider import (          # noqa: E402
    UpstageProvider,
    UpstageAuthError,
    UpstageStreamError,
    _SSE,
    _Sources,
    _find_action_id,
    _Creds,
    _resolve_model,
    _MODELS,
    ThinkSplitter,
    StreamEvent,
    TurnUsage,
    SessionUsage,
)

# think tags built from fragments (literal tags get mangled by file tools)
_OPEN  = "<" + "think" + ">"
_CLOSE = "</" + "think" + ">"

LIVE = os.environ.get("UPSTAGE_LIVE") == "1"
live = pytest.mark.skipif(not LIVE, reason="set UPSTAGE_LIVE=1 for live tests")


def run(coro):
    return asyncio.run(coro)


def make_provider(**kw) -> UpstageProvider:
    up = UpstageProvider(**kw)
    up._connected = True          # skip credential pipeline in unit tests
    return up


def canned(events: List[Tuple[str, str]]):
    """A fake _stream_events: assign as up._stream_events = canned([...])."""
    async def fake(payload):
        for ev in events:
            yield ev
    return fake


# ═══════════════════════════════════════════════════════════
# SSE PARSER
# ═══════════════════════════════════════════════════════════
class TestSSE:

    def test_content_delta(self):
        line = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}'
        assert _SSE.parse_line(line) == [("t-delta", "hi")]

    def test_reasoning_delta(self):
        line = 'data: {"choices":[{"delta":{"reasoning_content":"hmm"},"finish_reason":null}]}'
        assert _SSE.parse_line(line) == [("r-delta", "hmm")]

    def test_done_sentinel(self):
        assert _SSE.parse_line("data: [DONE]") == [("done", "")]

    def test_finish_stop(self):
        line = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'
        assert _SSE.parse_line(line) == [("done", "")]

    def test_empty_delta_skipped(self):
        line = 'data: {"choices":[{"delta":{"content":""},"finish_reason":null}]}'
        assert _SSE.parse_line(line) == []

    def test_garbage(self):
        assert _SSE.parse_line("") == []
        assert _SSE.parse_line("event: ping") == []
        assert _SSE.parse_line("data: {not json") == []

    def test_search_start(self):
        line = ('data: {"search":{"status":{"action":"search_start","description":"d"},'
                '"search_queries":[{"query":"q1","results":[]}]}}')
        assert _SSE.parse_line(line) == [("s-start", "q1")]

    def test_search_finish(self):
        sq = [{"query": "q1", "results": [{"url": "u", "title": "t"}]}]
        obj = {"search": {"status": {"action": "search_finish", "description": "d"},
                          "search_queries": sq}}
        line = "data: " + json.dumps(obj)
        evs = _SSE.parse_line(line)
        assert evs == [("source", json.dumps(sq))]

    def test_summarizing(self):
        line = ('data: {"search":{"status":{"action":"summarizing","description":"sum"},'
                '"search_queries":null}}')
        assert _SSE.parse_line(line) == [("s-summary", "sum")]

    def test_usage_zero_ignored(self):
        line = ('data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}],'
                '"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}')
        assert _SSE.parse_line(line) == [("t-delta", "x")]

    def test_usage_nonzero_emitted(self):
        line = ('data: {"choices":[{"delta":{"content":"x"},"finish_reason":null}],'
                '"usage":{"prompt_tokens":5,"completion_tokens":7,"total_tokens":12}}')
        evs = _SSE.parse_line(line)
        assert evs[0] == ("t-delta", "x")
        assert evs[1][0] == "usage"
        assert json.loads(evs[1][1])["total_tokens"] == 12

    def test_usage_with_stop_done_last(self):
        line = ('data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
                '"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}')
        evs = _SSE.parse_line(line)
        assert [e[0] for e in evs] == ["usage", "done"]


# ═══════════════════════════════════════════════════════════
# ACTION-ID EXTRACTION
# ═══════════════════════════════════════════════════════════
class TestFindActionId:
    A1 = "a" * 42
    A2 = "b" * 42

    def test_simple(self):
        js = f'createServerReference)("{self.A1}",x.callServer,void 0,x.findSourceMapURL,"getConsoleCsrfToken")'
        assert _find_action_id(js, "getConsoleCsrfToken") == self.A1

    def test_cross_wiring_guard(self):
        """Two actions on one line — id must stay pinned to its own name."""
        js = (f'createServerReference)("{self.A1}",x.callServer,void 0,x.findSourceMapURL,"authAction"),'
              f'createServerReference)("{self.A2}",x.callServer,void 0,x.findSourceMapURL,"getConsoleCsrfToken")')
        assert _find_action_id(js, "getConsoleCsrfToken") == self.A2
        assert _find_action_id(js, "authAction") == self.A1

    def test_missing(self):
        assert _find_action_id("nothing here", "getConsoleCsrfToken") is None

    def test_id_length_flexible(self):
        short = "c" * 40
        js = f'createServerReference)("{short}",x.callServer,void 0,x.findSourceMapURL,"authAction")'
        assert _find_action_id(js, "authAction") == short


# ═══════════════════════════════════════════════════════════
# THINK SPLITTER
# ═══════════════════════════════════════════════════════════
class TestThinkSplitter:

    def test_plain_content_holds_partial(self):
        sp = ThinkSplitter()
        assert sp.feed("ab") == []                       # held: possible partial tag
        assert sp.feed("let me ") == [("content", "abl")]
        assert sp.feed("ok") == [("content", "et")]
        assert sp.flush() == [("content", " me ok")]

    def test_full_block_one_feed(self):
        sp = ThinkSplitter()
        # trailing "cd" is held back as a possible partial tag → flush()
        out = sp.feed(f"ab{_OPEN}R1{_CLOSE}cd")
        assert out == [("content", "ab"), ("thinking", "R1")]
        assert sp.flush() == [("content", "cd")]

    def test_open_tag_split_across_feeds(self):
        sp = ThinkSplitter()
        assert sp.feed("a<th") == []                     # partial open held
        assert sp.feed("ink>R") == [("content", "a")]    # open tag completes
        assert sp.feed("reason") == []                   # short: all held back
        out = sp.feed(f"more{_CLOSE}after")
        assert out == [("thinking", "Rreasonmore")]
        assert sp.flush() == [("content", "after")]

    def test_close_tag_split_across_feeds(self):
        sp = ThinkSplitter()
        sp.feed(f"{_OPEN}R")
        sp.feed("1")
        out = sp.feed(f"</thi" + "nk>done")
        assert out == [("thinking", "R1")]
        assert sp.flush() == [("content", "done")]

    def test_ended_inside_think(self):
        sp = ThinkSplitter()
        out = sp.feed(f"{_OPEN}never closed")
        assert out == [("thinking", "never")]
        assert sp.flush() == [("thinking", " closed")]

    def test_multiple_blocks(self):
        sp = ThinkSplitter()
        out = sp.feed(f"{_OPEN}A{_CLOSE}mid{_OPEN}B{_CLOSE}end")
        assert out == [("thinking", "A"), ("content", "mid"), ("thinking", "B")]
        assert sp.flush() == [("content", "end")]

    def test_empty_feed_and_flush(self):
        sp = ThinkSplitter()
        assert sp.feed("") == []
        assert sp.flush() == []


# ═══════════════════════════════════════════════════════════
# SOURCES
# ═══════════════════════════════════════════════════════════
class TestSources:
    RAW = json.dumps([{
        "query": "q",
        "results": [
            {"url": "https://a.com", "title": "A", "score": 0.9,
             "content": "x" * 300},
            {"url": "https://a.com", "title": "A-dup", "score": 0.5,
             "content": "dup"},
            {"url": "https://b.com", "title": "", "score": 0.7,
             "content": "B content"},
            {"url": "", "title": "no-url", "score": 0.1, "content": "skip"},
        ],
    }])

    def test_parse_dedup_and_index(self):
        got = _Sources.parse([self.RAW])
        assert [s["url"] for s in got] == ["https://a.com", "https://b.com"]
        assert [s["index"] for s in got] == [1, 2]
        assert got[0]["query"] == "q"
        assert got[1]["title"] == "Untitled"

    def test_parse_snippet_truncation(self):
        got = _Sources.parse([self.RAW])
        assert len(got[0]["snippet"]) <= 203
        assert got[0]["snippet"].endswith("...")

    def test_parse_bad_input(self):
        assert _Sources.parse(["not json", "null", "[]"]) == []

    def test_format_text(self):
        got = _Sources.parse([self.RAW])
        txt = _Sources.format_text(got)
        assert "📚 Sources (2)" in txt
        assert "https://a.com" in txt and "https://b.com" in txt
        assert "Score: 0.9000" in txt
        assert _Sources.format_text([]) == ""

    def test_format_json(self):
        got = _Sources.parse([self.RAW])
        blob = json.loads(_Sources.format_json(got))
        assert len(blob["sources"]) == 2
        assert set(blob["sources"][0]) == {"title", "url", "score"}


# ═══════════════════════════════════════════════════════════
# MODEL RESOLUTION
# ═══════════════════════════════════════════════════════════
class TestModels:

    def test_alias(self):
        assert _resolve_model("pro2") == "solar-pro2"
        assert _resolve_model("mini") == "upstage/solar-1-mini-chat"
        assert _resolve_model("syn") == "syn-pro"

    def test_fuzzy(self):
        assert _resolve_model("solar-pro") == "solar-pro3"   # first match wins

    def test_unknown_passthrough(self):
        assert _resolve_model("custom/model") == "custom/model"

    def test_empty_default(self):
        assert _resolve_model("") == "solar-pro3"

    def test_list_models(self):
        up = make_provider()
        models = up.list_models()
        assert len(models) == 4
        assert [m for m in models if m["active"]] == [m for m in models if m["name"] == "solar-pro3"]

    def test_model_info(self):
        info = UpstageProvider.model_info()
        assert info["thinking"] is True and info["search"] is True
        assert set(info["models"]) == set(_MODELS)


# ═══════════════════════════════════════════════════════════
# PAYLOAD BUILDER
# ═══════════════════════════════════════════════════════════
class TestPayload:

    def _p(self, up, search=False, reasoning=None):
        return up._build_payload(
            [{"role": "user", "content": "hi"}], up.model,
            search, reasoning, None, None)

    def test_basic(self):
        up = make_provider()
        p = self._p(up)
        assert p["stream"] is True and p["model"] == "solar-pro3"
        assert p["messages"] == [{"role": "user", "content": "hi"}]
        assert "conversation_id" in p

    def test_search_mode_on_last_user(self):
        up = make_provider()
        p = self._p(up, search=True)
        assert p["messages"][-1]["mode"] == ["search"]
        assert p["search_provider"] == "tavily"
        assert p["reasoning_effort"] == "high"      # auto: search → high

    def test_no_search_low_reasoning(self):
        up = make_provider()
        p = self._p(up, search=False)
        assert "mode" not in p["messages"][-1]
        assert "search_provider" not in p
        assert p["reasoning_effort"] == "low"       # auto: no search → low

    def test_explicit_reasoning_wins(self):
        up = make_provider()
        assert self._p(up, search=True, reasoning="medium")["reasoning_effort"] == "medium"
        assert self._p(up, search=False, reasoning="high")["reasoning_effort"] == "high"

    def test_invalid_reasoning_ignored(self):
        up = make_provider()
        assert self._p(up, search=False, reasoning="banana")["reasoning_effort"] == "low"

    def test_min_model_has_no_reasoning(self):
        up = make_provider()
        p = up._build_payload([{"role": "user", "content": "hi"}],
                              "upstage/solar-1-mini-chat", False, None, None, None)
        assert "reasoning_effort" not in p

    def test_system_injected(self):
        up = make_provider(system="SYS")
        p = self._p(up)
        assert p["messages"][0] == {"role": "system", "content": "SYS"}

    def test_syn_metadata(self):
        up = make_provider()
        p = up._build_payload([{"role": "user", "content": "hi"}],
                              "syn-pro", False, None, None, None)
        assert p["metadata"]["quality"] == 4

    def test_input_not_mutated(self):
        up = make_provider()
        msgs = [{"role": "user", "content": "hi"}]
        up._build_payload(msgs, "solar-pro3", True, None, None, None)
        assert msgs == [{"role": "user", "content": "hi"}]     # no mode added in-place

    def test_overrides(self):
        up = make_provider(temperature=0.1, max_tokens=55)
        p = up._build_payload([{"role": "user", "content": "hi"}],
                              "solar-pro3", False, None, None, None)
        assert p["temperature"] == 0.1 and p["max_tokens"] == 55
        p2 = up._build_payload([{"role": "user", "content": "hi"}],
                               "solar-pro3", False, None, 0.9, 77)
        assert p2["temperature"] == 0.9 and p2["max_tokens"] == 77


# ═══════════════════════════════════════════════════════════
# STREAM ASSEMBLY (canned events, no network)
# ═══════════════════════════════════════════════════════════
class TestStreamAssembly:

    def test_data_mode_basic(self):
        up = make_provider()
        up._stream_events = canned([("t-delta", "Hel"), ("t-delta", "lo"),
                                    ("done", "")])

        async def go():
            evs = [ev async for ev in up.stream(data="hi")]
            return evs
        evs = run(go())
        # short tokens are held back by the splitter → one merged flush event
        assert [e.kind for e in evs] == ["content", "done"]
        assert up.last_response == "Hello"
        assert up.last_reasoning == ""
        roles = [m["role"] for m in up.history]
        assert roles == ["user", "assistant"]

    def test_messages_mode_replaces_history(self):
        up = make_provider()
        up._stream_events = canned([("t-delta", "Bob here"), ("done", "")])
        msgs = [
            {"role": "system", "content": "You are Bob."},
            {"role": "user", "content": "Name?"},
        ]

        async def go():
            return [ev async for ev in up.stream(messages=msgs)]
        run(go())
        assert up.last_response == "Bob here"
        # messages mode: per-call system is sent but not kept in history
        assert [m["role"] for m in up.history] == ["user", "assistant"]
        assert all(m["role"] != "system" for m in up.history)

    def test_r_delta_is_thinking(self):
        up = make_provider()
        up._stream_events = canned([("r-delta", "hmm"), ("r-delta", "…"),
                                    ("t-delta", "yes"), ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="q")]
        evs = run(go())
        assert [e.kind for e in evs] == ["thinking", "thinking", "content", "done"]
        assert up.last_reasoning == "hmm…"
        assert up.last_response == "yes"

    def test_inline_think_splitting(self):
        up = make_provider()
        feed = [f"ab{_OPEN}R", f"1{_CLOSE}cd"]         # tags split across tokens
        up._stream_events = canned([("t-delta", feed[0]),
                                    ("t-delta", feed[1]), ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="q")]
        evs = run(go())
        assert "".join(e.text for e in evs if e.kind == "content") == "abcd"
        assert "".join(e.text for e in evs if e.kind == "thinking") == "R1"
        assert up.last_response == "abcd"
        assert up.last_reasoning == "R1"

    def test_think_markup_never_leaks(self):
        up = make_provider()
        up._stream_events = canned([
            ("t-delta", f"x{_OPEN}A{_CLOSE}y"), ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="q")]
        run(go())
        assert _OPEN not in up.last_response and _CLOSE not in up.last_response
        assert _OPEN not in up.last_reasoning and _CLOSE not in up.last_reasoning

    def test_sources_yielded_first(self):
        up = make_provider()
        sq = [{"query": "q", "results": [{"url": "https://x.com", "title": "X"}]}]
        up._stream_events = canned([
            ("s-start", "q"),
            ("source", json.dumps(sq)),
            ("s-summary", "sum"),
            ("t-delta", "Paris"), ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="cap of france?", search=True)]
        evs = run(go())
        assert evs[0].kind == "sources"
        blob = json.loads(evs[0].text)
        assert blob["sources"][0]["url"] == "https://x.com"
        assert up.last_sources and up.last_sources[0]["url"] == "https://x.com"
        assert "📚 Sources (1)" in up.last_sources_text
        assert evs[-1].kind == "done"

    def test_usage_event_captured(self):
        up = make_provider()
        up._stream_events = canned([
            ("t-delta", "x"),
            ("usage", json.dumps({"prompt_tokens": 5,
                                  "completion_tokens": 3,
                                  "total_tokens": 8})),
            ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="q")]
        run(go())
        assert up.last_usage.api_usage["total_tokens"] == 8
        assert up.last_usage.tokens == 8
        assert up.last_usage.tokens_estimated is False

    def test_last_usage_fields(self):
        up = make_provider()
        up._stream_events = canned([("t-delta", "hello world"), ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="q")]
        run(go())
        u = up.last_usage
        assert u.ok is True and u.error == ""
        assert u.model == "solar-pro3"
        assert u.content_chars == len("hello world")
        assert u.prompt_chars > 0
        assert u.first_token_s is not None and u.first_token_s >= 0
        assert u.elapsed_s >= u.first_token_s
        assert u.tokens > 0 and u.tokens_estimated is True

    def test_session_usage_accumulates(self):
        up = make_provider()
        up._stream_events = canned([("t-delta", "a"), ("done", "")])

        async def go():
            async for _ in up.stream(data="1"):
                pass
            async for _ in up.stream(data="2"):
                pass
        run(go())
        tt = up.session_usage.totals()
        assert tt["turns"] == 2 and tt["ok"] == 2 and tt["failed"] == 0
        assert "TOTAL" in up.session_usage.format_report()

        up.new_session()
        assert up.session_usage.totals()["turns"] == 0
        assert up.history == [] and up.last_response == ""
        assert up.last_usage is None

    def test_early_break_finalizes_state(self):
        up = make_provider()
        up._stream_events = canned([("t-delta", "ab"), ("t-delta", "cd"),
                                    ("done", "")])

        async def go():
            n = 0
            async for ev in up.stream(data="q"):
                n += 1
                if n == 1:
                    break          # consumer abandons mid-stream
            return n
        assert run(go()) == 1
        # state still consistent (both deltas were buffered before the
        # first yield, so all of it is in last_response)
        assert up.last_response == "abcd"
        assert up.last_usage.ok is False
        assert "interrupted" in up.last_usage.error
        assert [m["role"] for m in up.history] == ["user"]   # no assistant appended

    def test_auth_retry_succeeds(self):
        up = make_provider()
        calls = {"stream": 0, "capture": 0}
        events = [("t-delta", "ok"), ("done", "")]

        async def fake_stream(payload):
            calls["stream"] += 1
            if calls["stream"] == 1:
                raise UpstageAuthError("401")
            for ev in events:
                yield ev

        async def fake_capture():
            calls["capture"] += 1

        up._stream_events = fake_stream
        up._creds.capture = fake_capture

        async def go():
            return [ev async for ev in up.stream(data="q")]
        evs = run(go())
        assert [e.kind for e in evs] == ["content", "done"]
        assert calls["stream"] == 2 and calls["capture"] == 1
        assert up.last_response == "ok"

    def test_auth_failure_twice_raises(self):
        up = make_provider()
        calls = {"capture": 0}

        async def fake_stream(payload):
            raise UpstageAuthError("403")
            yield            # pragma: no cover (async-gen marker)

        async def fake_capture():
            calls["capture"] += 1

        up._stream_events = fake_stream
        up._creds.capture = fake_capture

        async def go():
            async for _ in up.stream(data="q"):
                pass
        with pytest.raises(UpstageAuthError):
            run(go())
        assert calls["capture"] == 1                     # one re-capture, then give up
        assert up.last_usage.ok is False
        assert "auth" in up.last_usage.error

    def test_generic_error_wrapped(self):
        up = make_provider()

        async def fake_stream(payload):
            raise ConnectionError("socket blew up")
            yield          # pragma: no cover (async gen marker)

        up._stream_events = fake_stream

        async def go():
            async for _ in up.stream(data="q"):
                pass
        with pytest.raises(UpstageStreamError):
            run(go())
        assert up.last_usage.ok is False
        assert "socket blew up" in up.last_usage.error

    def test_chat_plain_string_contract(self):
        up = make_provider()
        sq = [{"query": "q", "results": [{"url": "https://x.com", "title": "X"}]}]
        up._stream_events = canned([("source", json.dumps(sq)),
                                    ("t-delta", "Paris"), ("done", "")])

        async def go():
            return [tok async for tok in up.chat(data="cap?", search=True)]
        toks = run(go())
        assert all(isinstance(t, str) for t in toks)
        assert toks[0].startswith('{"sources"')
        assert "".join(toks[1:]) == "Paris"

    def test_requires_input(self):
        up = make_provider()

        async def go():
            async for _ in up.stream():
                pass
        with pytest.raises(ValueError):
            run(go())

    def test_setters_chainable(self):
        up = UpstageProvider()
        out = (up.set_model("pro2").set_system("S").set_search(True)
               .set_temperature(0.5).set_max_tokens(42))
        assert out is up
        assert (up.model, up.system, up.search,
                up.temperature, up.max_tokens) == ("solar-pro2", "S", True, 0.5, 42)


# ═══════════════════════════════════════════════════════════
# CREDENTIALS (offline bits)
# ═══════════════════════════════════════════════════════════
class TestCreds:

    def test_load_missing(self, tmp_path):
        cr = _Creds(path=tmp_path / "nope.json")

        async def go():
            return await cr.load()
        assert run(go()) is False

    def test_save_load_roundtrip(self, tmp_path):
        p = tmp_path / "sub" / "creds.json"
        cr = _Creds(path=p)
        cr.action_token = "a" * 42
        cr.action_init = "b" * 42
        cr.cookies = {"session_id": "s1", "other": "o"}

        async def go():
            await cr.save()
            cr2 = _Creds(path=p)
            ok = await cr2.load()
            return ok, cr2
        ok, cr2 = run(go())
        assert ok is True
        assert cr2.action_token == "a" * 42
        assert cr2.cookies["session_id"] == "s1"
        assert cr2.session_id == "s1"

    def test_clear(self, tmp_path):
        p = tmp_path / "c.json"

        async def go():
            cr = _Creds(path=p)
            cr.action_token = "x"
            await cr.save()
            await cr.clear()
            return p.exists()
        assert run(go()) is False

    def test_verify_without_action_token(self, tmp_path):
        cr = _Creds(path=tmp_path / "c.json")

        async def go():
            return await cr.verify()
        assert run(go()) is None


# ═══════════════════════════════════════════════════════════
# USAGE DEPARTMENT
# ═══════════════════════════════════════════════════════════
class TestUsage:

    def test_estimate_tokens(self):
        u = TurnUsage(model="m", thinking_chars=100, content_chars=100,
                      elapsed_s=2.0)
        assert u.tokens == 50
        assert u.tokens_estimated is True
        assert u.tokens_per_s == 25.0

    def test_api_tokens_preferred(self):
        u = TurnUsage(model="m", thinking_chars=100, content_chars=100,
                      api_usage={"total_tokens": 77})
        assert u.tokens == 77 and u.tokens_estimated is False

    def test_format_line(self):
        u = TurnUsage(model="solar-pro3", thinking_chars=120, content_chars=40,
                      elapsed_s=2.0, first_token_s=0.5, n_sources=2)
        line = u.format_line()
        for frag in ("⏱ 2.0s", "first token 0.50s", "~40 tok (est)",
                     "20 tok/s", "💭 120c", "solar-pro3", "📚 2"):
            assert frag in line, line

    def test_format_line_failed(self):
        u = TurnUsage(model="m", ok=False, error="boom")
        assert "✗" in u.format_line()

    def test_session_report_empty(self):
        assert "no turns yet" in SessionUsage().format_report()

    def test_session_report_and_totals(self):
        su = SessionUsage()
        su.add(TurnUsage(model="m", thinking_chars=40, content_chars=20,
                         elapsed_s=1.0, n_sources=1))
        su.add(TurnUsage(model="m", ok=False, error="x", elapsed_s=0.5))
        tt = su.totals()
        assert tt["turns"] == 2 and tt["ok"] == 1 and tt["failed"] == 1
        assert tt["tokens"] == 15
        rep = su.format_report()
        assert "📊 Session usage" in rep
        assert "2 turns (1 ok, 1 failed)" in rep
        su.clear()
        assert su.totals()["turns"] == 0

    def test_stream_event_defaults(self):
        e = StreamEvent(kind="content")
        assert e.text == ""
        e2 = StreamEvent(kind="thinking", text="t")
        assert e2.text == "t"


# ═══════════════════════════════════════════════════════════
# INTERACTIVE (command parsing)
# ═══════════════════════════════════════════════════════════
class TestInteractive:

    def test_parse(self):
        from upstage_interactive import parse_command
        assert parse_command("/model pro2") == ("model", "pro2")
        assert parse_command("  /SEARCH off  ") == ("search", "off")
        assert parse_command("/quit") == ("quit", "")
        assert parse_command("/") == ("help", "")
        assert parse_command("hello") == ("chat", "hello")
        assert parse_command("") == ("help", "")
        assert parse_command("  ") == ("help", "")

    def test_session_toggles(self):
        import argparse
        from upstage_interactive import Session
        s = Session(argparse.Namespace(model="pro2", search=True, thinking="med"))
        assert s.up.model == "solar-pro2"
        assert s.up.search is True
        assert s.thinking == "medium"


# ═══════════════════════════════════════════════════════════
# LIVE TESTS  (UPSTAGE_LIVE=1)
# ═══════════════════════════════════════════════════════════
class TestLive:

    @live
    def test_connect_and_short_chat(self):
        up = UpstageProvider()

        async def go():
            await up.connect()
            toks = [t async for t in up.chat(data="What is 2+2? One word.",
                                             max_tokens=60)]
            return toks
        toks = run(asyncio.wait_for(go(), 120))
        assert up.last_response.strip()
        assert _OPEN not in up.last_response and _CLOSE not in up.last_response
        u = up.last_usage
        assert u.ok is True and u.elapsed_s > 0 and u.tokens > 0
        assert [m["role"] for m in up.history] == ["user", "assistant"]

    @live
    def test_stream_typed_and_realtime(self):
        up = UpstageProvider()

        async def go():
            loop = asyncio.get_event_loop()
            token_times = []
            done_time = None
            async for ev in up.stream(data="Count 1 to 3, nothing else.",
                                      max_tokens=80):
                if ev.kind in ("thinking", "content") and ev.text:
                    token_times.append(loop.time())
                elif ev.kind == "done":
                    done_time = loop.time()
            return token_times, done_time
        token_times, done_time = run(asyncio.wait_for(go(), 120))
        assert len(token_times) >= 1
        assert done_time is not None
        # realtime: every token event arrived BEFORE the stream ended
        assert all(t < done_time for t in token_times)
        # and arrivals are non-decreasing in time (no buffering reorder)
        assert token_times == sorted(token_times)

    @live
    def test_search_sources(self):
        up = UpstageProvider()

        async def go():
            events = [ev async for ev in up.stream(
                data="What is the capital of France? In one word.",
                search=True, max_tokens=120)]
            return events
        events = run(asyncio.wait_for(go(), 180))
        kinds = [e.kind for e in events]
        assert "sources" in kinds
        assert kinds.index("sources") < kinds.index("done")
        assert up.last_sources
        assert all(s["url"].startswith("http") for s in up.last_sources[:3])
        assert "📚 Sources" in up.last_sources_text
        assert up.last_usage.n_sources >= 1

    @live
    def test_multi_turn_history(self):
        up = UpstageProvider()

        async def go():
            async for _ in up.chat(data="My name is Ada. Remember it.",
                                   max_tokens=80):
                pass
            async for _ in up.chat(data="What is my name? One word.",
                                   max_tokens=80):
                pass
            return up
        up = run(asyncio.wait_for(go(), 180))
        roles = [m["role"] for m in up.history]
        assert roles == ["user", "assistant", "user", "assistant"]
        assert "ada" in up.last_response.lower()
        assert up.session_usage.totals()["turns"] == 2

    @live
    def test_fresh_credential_capture(self, tmp_path):
        """Full capture pipeline in a clean cache dir (no pre-existing creds)."""
        old = os.environ.get("UPSTAGE_CACHE_DIR")
        os.environ["UPSTAGE_CACHE_DIR"] = str(tmp_path)
        try:
            up = UpstageProvider()

            async def go():
                await up.connect()          # cold → capture path
                return await up._creds.verify()
            token = run(asyncio.wait_for(go(), 120))
            assert token
            assert up._creds.action_token
            assert (tmp_path / "upstage_creds.json").exists()
        finally:
            if old is None:
                os.environ.pop("UPSTAGE_CACHE_DIR", None)
            else:
                os.environ["UPSTAGE_CACHE_DIR"] = old

    @live
    def test_reasoning_no_leak(self):
        up = UpstageProvider()

        async def go():
            async for _ in up.chat(data="Is 97 prime? One word answer.",
                                   reasoning="high", max_tokens=300):
                pass
        run(asyncio.wait_for(go(), 180))
        assert _OPEN not in up.last_response and _CLOSE not in up.last_response
        assert _OPEN not in up.last_reasoning and _CLOSE not in up.last_reasoning
