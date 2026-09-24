"""
test_converted.py — offline unit tests + LIVE chain tests against mock_upstage.

Run offline:   python3 -m pytest test_converted.py -v
Run live:      python3 -m pytest test_converted.py -k Live -v
               (expects mock_upstage on :8485 and api_server on :8484)
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import List, Tuple

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from upstage_kit import (                      # noqa: E402
    SSEParser, Sources, ThinkSplitter, TurnUsage, SessionUsage,
    UpstageAuthError, UpstageProvider, UpstageStreamError,
    find_action_id, resolve_model, MODELS,
    OPEN_THINK, CLOSE_THINK,
)

MOCK = os.environ.get("MOCK_URL", "http://127.0.0.1:8485")
API = os.environ.get("API_URL", "http://127.0.0.1:8484")
LIVE = os.environ.get("KIT_LIVE") == "1"
live = pytest.mark.skipif(not LIVE, reason="set KIT_LIVE=1 for live tests")


def run(coro):
    return asyncio.run(coro)


def make_provider(**kw) -> UpstageProvider:
    up = UpstageProvider(**kw)
    up._connected = True
    return up


def canned(events: List[Tuple[str, str]]):
    async def fake(payload):
        for ev in events:
            yield ev
    return fake


# ═══════════════════════════════════════════════════════════
# OFFLINE — parser / splitter / sources / payload / assembly
# ═══════════════════════════════════════════════════════════
class TestSSE:
    def test_content_delta(self):
        line = 'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}'
        assert SSEParser.parse_line(line) == [("t-delta", "hi")]

    def test_reasoning_delta(self):
        line = 'data: {"choices":[{"delta":{"reasoning_content":"hmm"},"finish_reason":null}]}'
        assert SSEParser.parse_line(line) == [("r-delta", "hmm")]

    def test_done_sentinel(self):
        assert SSEParser.parse_line("data: [DONE]") == [("done", "")]

    def test_finish_stop(self):
        line = 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}'
        assert SSEParser.parse_line(line) == [("done", "")]

    def test_usage_with_stop_done_last(self):
        line = ('data: {"choices":[{"delta":{},"finish_reason":"stop"}],'
                '"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}')
        evs = SSEParser.parse_line(line)
        assert [e[0] for e in evs] == ["usage", "done"]

    def test_search_start_finish(self):
        line = ('data: {"search":{"status":{"action":"search_start","description":"d"},'
                '"search_queries":[{"query":"q1","results":[]}]}}')
        assert SSEParser.parse_line(line) == [("s-start", "q1")]
        sq = [{"query": "q", "results": [{"url": "u", "title": "t"}]}]
        line2 = "data: " + json.dumps({"search": {
            "status": {"action": "search_finish", "description": "d"},
            "search_queries": sq}})
        assert SSEParser.parse_line(line2) == [("source", json.dumps(sq))]

    def test_garbage(self):
        assert SSEParser.parse_line("") == []
        assert SSEParser.parse_line("event: ping") == []
        assert SSEParser.parse_line("data: {not json") == []


class TestThinkSplitter:
    def test_holds_partial_tag(self):
        sp = ThinkSplitter()
        assert sp.feed("ab") == []
        assert sp.feed("let me ") == [("content", "abl")]
        assert sp.flush() == [("content", "et me ")]

    def test_inline_block_split_across_tokens(self):
        sp = ThinkSplitter()
        got = []
        got += sp.feed("hi" + OPEN_THINK[:4])
        got += sp.feed(OPEN_THINK[4:] + "R1" + CLOSE_THINK[:3])
        got += sp.feed(CLOSE_THINK[3:] + "ok")
        got += sp.flush()
        assert "".join(t for k, t in got if k == "content") == "hiok"
        assert "".join(t for k, t in got if k == "thinking") == "R1"

    def test_ended_inside_think(self):
        sp = ThinkSplitter()
        out = sp.feed(OPEN_THINK + "never closed")
        assert out == [("thinking", "never")]
        assert sp.flush() == [("thinking", " closed")]


class TestSources:
    RAW = json.dumps([{
        "query": "q",
        "results": [
            {"url": "https://a.com", "title": "A", "score": 0.9, "content": "x" * 300},
            {"url": "https://a.com", "title": "dup", "score": 0.5, "content": "dup"},
            {"url": "", "title": "skip", "score": 0.1, "content": "s"},
        ],
    }])

    def test_parse_dedup_index_snippet(self):
        got = Sources.parse([self.RAW])
        assert [s["url"] for s in got] == ["https://a.com"]
        assert got[0]["index"] == 1
        assert got[0]["snippet"].endswith("...")
        assert "📚 Sources (1)" in Sources.format_text(got)
        blob = json.loads(Sources.format_json(got))
        assert set(blob["sources"][0]) == {"title", "url", "score"}


class TestModels:
    def test_alias_and_fuzzy(self):
        assert resolve_model("pro2") == "solar-pro2"
        assert resolve_model("mini") == "upstage/solar-1-mini-chat"
        assert resolve_model("solar-pro") == "solar-pro3"
        assert resolve_model("") == "solar-pro3"
    def test_registry(self):
        assert len(MODELS) == 4


class TestPayload:
    def _p(self, up, search=False, reasoning=None):
        return up._build_payload(
            [{"role": "user", "content": "hi"}], up.model,
            search, reasoning, None, None)

    def test_search_flags(self):
        up = make_provider()
        p = self._p(up, search=True)
        assert p["messages"][-1]["mode"] == ["search"]
        assert p["search_provider"] == "tavily"
        assert p["reasoning_effort"] == "high"

    def test_no_search_low_reasoning(self):
        up = make_provider()
        p = self._p(up, search=False)
        assert "mode" not in p["messages"][-1]
        assert p["reasoning_effort"] == "low"

    def test_explicit_reasoning_wins(self):
        up = make_provider()
        assert self._p(up, search=False, reasoning="high")["reasoning_effort"] == "high"

    def test_mini_no_reasoning(self):
        up = make_provider()
        p = up._build_payload(
            [{"role": "user", "content": "hi"}],
            "upstage/solar-1-mini-chat", False, None, None, None)
        assert "reasoning_effort" not in p


class TestStreamAssembly:
    def test_data_mode_basic(self):
        up = make_provider()
        up._stream_events = canned([("t-delta", "Hel"), ("t-delta", "lo"), ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="hi")]
        evs = run(go())
        assert [e.kind for e in evs] == ["content", "done"]
        assert up.last_response == "Hello"
        assert [m["role"] for m in up.history] == ["user", "assistant"]

    def test_r_delta_thinking_and_inline_split(self):
        up = make_provider()
        feed = ["ab" + OPEN_THINK[:5], OPEN_THINK[5:] + "R" + CLOSE_THINK[:4],
                CLOSE_THINK[4:] + "cd"]
        up._stream_events = canned(
            [("r-delta", "hmm"), ("t-delta", feed[0]), ("t-delta", feed[1]),
             ("t-delta", feed[2]), ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="q")]
        evs = run(go())
        assert "".join(e.text for e in evs if e.kind == "thinking") == "hmmR"
        assert "".join(e.text for e in evs if e.kind == "content") == "abcd"
        assert OPEN_THINK not in up.last_response
        assert CLOSE_THINK not in up.last_reasoning

    def test_sources_first_usage_captured(self):
        up = make_provider()
        sq = [{"query": "q", "results": [{"url": "https://x.com", "title": "X"}]}]
        up._stream_events = canned([
            ("source", json.dumps(sq)),
            ("t-delta", "Paris"),
            ("usage", json.dumps({"prompt_tokens": 5, "completion_tokens": 3,
                                  "total_tokens": 8})),
            ("done", "")])

        async def go():
            return [ev async for ev in up.stream(data="cap?", search=True)]
        evs = run(go())
        assert evs[0].kind == "sources"
        assert evs[-1].kind == "done"
        assert up.last_usage.api_usage["total_tokens"] == 8
        assert up.last_usage.tokens_estimated is False
        assert up.last_usage.n_sources == 1

    def test_early_break_finalizes(self):
        up = make_provider()
        up._stream_events = canned([("t-delta", "ab"), ("t-delta", "cd"), ("done", "")])

        async def go():
            async for ev in up.stream(data="q"):
                break
            return up
        up2 = run(go())
        # generator finalization runs at asyncio.run shutdown
        u = up2.last_usage
        assert u is not None and u.ok is False and "interrupted" in u.error

    def test_auth_retry(self):
        up = make_provider()
        calls = {"n": 0}

        async def fake(payload):
            calls["n"] += 1
            if calls["n"] == 1:
                raise UpstageAuthError("401")
            yield ("t-delta", "ok")
            yield ("done", "")

        async def fake_capture():
            calls["cap"] = calls.get("cap", 0) + 1

        up._stream_events = fake
        up._creds.capture = fake_capture

        async def go():
            return up.last_response if False else [
                ev async for ev in up.stream(data="q")]
        evs = run(go())
        assert up.last_response == "ok"
        assert calls["n"] == 2 and calls["cap"] == 1

    def test_chat_contract(self):
        up = make_provider()
        sq = [{"query": "q", "results": [{"url": "https://x.com", "title": "X"}]}]
        up._stream_events = canned([
            ("source", json.dumps(sq)), ("t-delta", "Paris"), ("done", "")])

        async def go():
            return [t async for t in up.chat(data="cap?", search=True)]
        toks = run(go())
        assert all(isinstance(t, str) for t in toks)
        assert toks[0].startswith('{"sources"')

    def test_requires_input(self):
        up = make_provider()

        async def go():
            async for _ in up.stream():
                pass
        with pytest.raises(ValueError):
            run(go())


class TestFindActionId:
    def test_pinned_to_own_name(self):
        a1, a2 = "a" * 42, "b" * 42
        js = (f'createServerReference)("{a1}",x.callServer,void 0,x.findSourceMapURL,"authAction"),'
              f'createServerReference)("{a2}",x.callServer,void 0,x.findSourceMapURL,"getConsoleCsrfToken")')
        assert find_action_id(js, "getConsoleCsrfToken") == a2
        assert find_action_id(js, "authAction") == a1

    def test_missing(self):
        assert find_action_id("nothing", "getConsoleCsrfToken") is None


class TestUsage:
    def test_estimate_and_api_pref(self):
        u = TurnUsage(model="m", thinking_chars=100, content_chars=100, elapsed_s=2.0)
        assert u.tokens == 50 and u.tokens_estimated is True
        u.api_usage = {"total_tokens": 77}
        assert u.tokens == 77 and u.tokens_estimated is False

    def test_session_report(self):
        su = SessionUsage()
        su.add(TurnUsage(model="m", content_chars=40, elapsed_s=1.0))
        assert "TOTAL" in su.format_report()
        assert "1 turns" in su.format_report()


# ═══════════════════════════════════════════════════════════
# LIVE CHAIN — real HTTP against mock_upstage (:8485)
# ═══════════════════════════════════════════════════════════
class TestLiveMockChain:
    mark = live

    @pytest.fixture(autouse=True)
    def _point_at_mock(self, tmp_path, monkeypatch):
        monkeypatch.setenv("UPSTAGE_CONSOLE_URL", MOCK)
        monkeypatch.setenv("UPSTAGE_API_BASE", MOCK)
        monkeypatch.setenv("UPSTAGE_CACHE_DIR", str(tmp_path))

    def test_fresh_credential_capture(self):
        up = UpstageProvider()

        async def go():
            await up.connect()
            return await up._creds.verify()
        token = run(asyncio.wait_for(go(), 30))
        assert token and token.startswith("csrf-")
        assert up._creds.action_token
        assert (Path(os.environ["UPSTAGE_CACHE_DIR"]) / "upstage_creds.json").exists()

    def test_realtime_chat_response_type(self):
        up = UpstageProvider()

        async def go():
            loop = asyncio.get_event_loop()
            times, done_at = [], None
            async for ev in up.stream(data="What is 2+2? One word.", max_tokens=100):
                if ev.kind in ("thinking", "content") and ev.text:
                    times.append(loop.time())
                elif ev.kind == "done":
                    done_at = loop.time()
            return times, done_at
        times, done_at = run(asyncio.wait_for(go(), 60))
        assert len(times) >= 2
        assert done_at is not None and all(t < done_at for t in times)
        assert times == sorted(times)          # no reordering ⇒ realtime
        assert "4" in up.last_response
        assert OPEN_THINK not in up.last_response
        assert OPEN_THINK not in up.last_reasoning
        assert up.last_usage.ok and up.last_usage.api_usage
        assert up.last_usage.tokens_estimated is False

    def test_search_stream(self):
        up = UpstageProvider()

        async def go():
            return [ev async for ev in up.stream(
                data="What is the capital of France?", search=True, max_tokens=120)]
        events = run(asyncio.wait_for(go(), 60))
        kinds = [e.kind for e in events]
        assert "sources" in kinds
        assert kinds.index("sources") < kinds.index("done")
        assert up.last_sources and len(up.last_sources) == 2   # deduped
        assert up.last_sources[0]["url"].startswith("http")
        assert "📚 Sources" in up.last_sources_text

    def test_multi_turn_and_usage_dept(self):
        up = UpstageProvider()

        async def go():
            async for _ in up.chat(data="My name is Ada.", max_tokens=80):
                pass
            async for _ in up.chat(data="What is my name? One word.", max_tokens=80):
                pass
            return up
        up = run(asyncio.wait_for(go(), 60))
        assert [m["role"] for m in up.history] == ["user", "assistant", "user", "assistant"]
        assert "Ada" in up.last_response
        assert up.session_usage.totals()["turns"] == 2
        assert "TOTAL" in up.session_usage.format_report()

    def test_auth_retry_on_403(self):
        import urllib.request
        req = urllib.request.Request(f"{MOCK}/__test/flaky_auth", method="POST")
        urllib.request.urlopen(req, timeout=5).read()

        up = UpstageProvider()

        async def go():
            async for _ in up.chat(data="retry me", max_tokens=60):
                pass
            return up
        up = run(asyncio.wait_for(go(), 60))
        assert up.last_response            # succeeded after one re-capture
        # mock counted the injected 403
        stats = json.loads(urllib.request.urlopen(f"{MOCK}/health", timeout=5).read())
        assert stats["flaky_hits"] >= 1

    def test_payload_reaches_wire(self):
        import urllib.request
        up = UpstageProvider()

        async def go():
            async for _ in up.chat(data="wire check", model="syn-pro",
                                   search=True, max_tokens=50):
                pass
        run(asyncio.wait_for(go(), 60))
        last = json.loads(urllib.request.urlopen(f"{MOCK}/__test/payloads", timeout=5).read())
        assert last["count"] >= 1
        p = last["last"]
        assert p["model"] == "syn-pro"
        assert p["stream"] is True
        assert p["search_provider"] == "tavily"
        assert p["messages"][-1]["mode"] == ["search"]
        assert p["reasoning_effort"] == "high"
        assert p["metadata"]["quality"] == 4


# ═══════════════════════════════════════════════════════════
# LIVE API — HTTP API wrapper (:8484)
# ═══════════════════════════════════════════════════════════
class TestLiveApiServer:
    mark = live

    def _post(self, path: str, body: dict):
        import urllib.request
        req = urllib.request.Request(
            f"{API}{path}",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read().decode()

    def test_health(self):
        import urllib.request
        h = json.loads(urllib.request.urlopen(f"{API}/health", timeout=10).read())
        assert h["ok"] is True
        assert h["console"].startswith("http")

    def test_models_endpoint(self):
        import urllib.request
        m = json.loads(urllib.request.urlopen(f"{API}/v1/models", timeout=10).read())
        assert len(m["models"]) == 4

    def test_chat_json_response(self):
        status, body = self._post("/v1/chat", {
            "prompt": "What is 2+2? One word.",
            "max_tokens": 100,
        })
        j = json.loads(body)
        assert status == 200 and j["ok"] is True
        assert "4" in j["response"]
        assert j["usage"]["tokens"] > 0
        assert j["history_roles"] == ["user", "assistant"]

    def test_chat_stream_sse_frames(self):
        import urllib.request
        req = urllib.request.Request(
            f"{API}/v1/chat/stream",
            data=json.dumps({"prompt": "Count 1 to 3", "max_tokens": 80}).encode(),
            headers={"content-type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            assert "text/event-stream" in r.headers.get_content_type() or \
                   r.headers.get("content-type", "").startswith("text/event-stream")
            raw = r.read().decode()

        frames = [f for f in raw.split("\n\n") if f.strip()]
        kinds = []
        for f in frames:
            for ln in f.split("\n"):
                if ln.startswith("event: "):
                    kinds.append(ln[7:])
        assert "content" in kinds or "thinking" in kinds
        assert "done" in kinds
        assert "usage" in kinds
        # done before usage trailer
        assert kinds.index("done") < kinds.index("usage")
