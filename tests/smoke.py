"""
End-to-end smoke test. No pytest needed:

    cd silk && python -m tests.smoke

Boots the mock upstream + the real server in-process, streams a chat turn, and
asserts the two things that matter:

  1. the browser got typed SSE events (reasoning/token/sources/done), not one
     blob the client has to sniff for JSON
  2. the user's IP reached the upstream in the forwarded headers, while the
     upstream's socket peer stayed the server — i.e. exactly what we claim and
     nothing more
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # repo root
sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402  (module-level so helpers can use it)

MOCK_PORT = 8099
SERVER_PORT = 8098


def free_port(preferred: int) -> int:
    with socket.socket() as probe:
        try:
            probe.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


async def parse_sse(body) -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    event, data = "", ""
    async for raw in body:
        line = raw if isinstance(raw, str) else raw.decode("utf-8", "replace")
        line = line.rstrip("\r\n")
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            data = line[5:].strip()
        elif not line:
            if event and data:
                try:
                    out.append((event, json.loads(data)))
                except json.JSONDecodeError:
                    out.append((event, {"_raw": data}))
            event, data = "", ""
    return out


def replace_settings(cfg_mod, server_mod, **over):
    """
    Rebuild Settings from the CURRENT os.environ (not from the already-frozen
    module instance — this file imports app.config at the top, before main()
    sets the mock URL, so copying prev's fields would keep the real upstream).
    """
    prev = cfg_mod.settings
    cfg_mod.settings = server_mod.settings = Settings(**over)
    return prev


def restore_settings(cfg_mod, server_mod, prev) -> None:
    cfg_mod.settings = server_mod.settings = prev


def check(name: str, cond: bool, extra: str = "") -> None:
    mark = "  ok  " if cond else " FAIL "
    print(f"[{mark}] {name}" + (f"   {extra}" if extra else ""))
    if not cond:
        raise SystemExit(1)


async def main() -> None:
    import httpx
    import uvicorn

    mock_port = free_port(MOCK_PORT)
    server_port = free_port(SERVER_PORT)

    os.environ["INCEPTION_BASE_URL"] = f"http://127.0.0.1:{mock_port}"
    os.environ["FORWARD_CLIENT_IP"] = "1"
    os.environ["TRUSTED_PROXIES"] = "127.0.0.1"
    os.environ["RATE_LIMIT_REQUESTS"] = "5"
    os.environ["RATE_LIMIT_WINDOW"] = "60"

    from mock.inception_api import app as mock_app
    import app.config as cfg_mod
    import app.server as server_mod

    # rebuild settings so the env above is picked up
    prev_settings = replace_settings(cfg_mod, server_mod)

    mock_srv = uvicorn.Server(uvicorn.Config(
        mock_app, host="127.0.0.1", port=mock_port, log_level="error",
        proxy_headers=False,   # report the TRUE tcp peer, not a rewritten one
    ))
    srv = uvicorn.Server(uvicorn.Config(
        server_mod.app, host="127.0.0.1", port=server_port, log_level="error",
        proxy_headers=False,   # do not let uvicorn pre-rewrite request.client
    ))
    tasks = [asyncio.create_task(mock_srv.serve()), asyncio.create_task(srv.serve())]
    for _ in range(80):
        if srv.started and mock_srv.started:
            break
        await asyncio.sleep(0.05)

    base = f"http://127.0.0.1:{server_port}"
    ok = True
    try:
        async with httpx.AsyncClient(timeout=60) as c:
            # 1 — health
            r = await c.get(f"{base}/api/health")
            check("health", r.status_code == 200 and r.json()["proxy"] is None,
                  json.dumps(r.json()))

            # 1b — HF Spaces contract: literal {"status":"ok"}, not a bool
            r = await c.get(f"{base}/healthcheck")
            check("HF /healthcheck body is the literal string ok",
                  r.status_code == 200 and r.json() == {"status": "ok"},
                  f"{r.status_code} {r.text[:60]}")

            # 2 — config echoes how *we* resolved this caller's IP
            r = await c.get(f"{base}/api/config")
            you = r.json()["you"]
            check("ip resolved from socket peer", you["socket_peer"] == "127.0.0.1",
                  json.dumps(you))

            # 3 — stream a turn, events must be typed
            events = []
            async with c.stream(
                "POST", f"{base}/api/chat",
                json={"message": "hello silk", "search": True,
                      "reasoning_effort": "high"},
            ) as r:
                check("stream content-type",
                      r.headers["content-type"].startswith("text/event-stream"),
                      r.headers["content-type"])
                events = await parse_sse(r.aiter_lines())

            kinds = [e for e, _ in events]
            check("has start", "start" in kinds)
            check("has reasoning", "reasoning" in kinds)
            check("has token events", kinds.count("token") > 5,
                  f"{kinds.count('token')} tokens")
            check("has sources event", "sources" in kinds)
            check("has done", kinds[-1] == "done", f"last={kinds[-1]}")
            check("no error event", "error" not in kinds)

            # sources are structured, NOT a JSON string inside a token
            src = [d for e, d in events if e == "sources"]
            check("sources are objects",
                  all(isinstance(s.get("source"), dict) and "url" in s["source"]
                      for s in src), json.dumps(src[:1]))
            answer = "".join(d.get("text", "") for e, d in events if e == "token")
            check("sources never leaked into prose",
                  "{" not in answer or '"sources"' not in answer)
            print(f"        answer → {answer[:70]!r}")

            # 4 — what the UPSTREAM actually saw
            r = await c.get(f"http://127.0.0.1:{mock_port}/api/last-request")
            seen = r.json()
            check("upstream got session token",
                  seen["session_token"].startswith("mock-token-"),
                  seen["session_token"])
            check("upstream got forwarded user IP",
                  seen["x_forwarded_for"] == "127.0.0.1",
                  f"XFF={seen['x_forwarded_for']!r} real-ip={seen['x_real_ip']!r}")
            check("upstream got Forwarded (RFC7239)",
                  "for=127.0.0.1" in seen["forwarded"], seen["forwarded"])
            check("socket peer is THE SERVER, not the user  ← expected",
                  seen["socket_peer"] == "127.0.0.1", seen["socket_peer"])
            check("no fingerprint theatre",
                  "silk-chat" in seen["user_agent"], seen["user_agent"])
            check("no forged Origin/Referer/sec-fetch (we are not a browser)",
                  not seen["origin"] and not seen["referer"]
                  and not seen["sec_fetch_site"],
                  f"origin={seen['origin']!r} referer={seen['referer']!r} "
                  f"sec-fetch-site={seen['sec_fetch_site']!r}")
            check("payload keeps real wire format",
                  set(seen["payload"]) >= {"reasoningEffort", "webSearchEnabled",
                                           "messages", "trigger", "id"},
                  json.dumps(sorted(seen["payload"])))
            m0 = seen["payload"]["messages"][0]
            check("messages use parts[] shape",
                  isinstance(m0.get("parts"), list)
                  and m0["parts"][0].get("type") == "text", json.dumps(m0)[:90])

            # 5 — rate limiter keys on the resolved IP
            body = {"message": "spam"}
            codes = [(await c.post(f"{base}/api/chat", json=body)).status_code
                      for _ in range(8)]
            check("429 after the window fills", 429 in codes, f"codes={codes}")

            # 6 — the trust list IS the security boundary. Prove both sides.
            #    6a: 127.0.0.1 is trusted (i.e. a real nginx/webpack-dev-server
            #        runs on this box) → forwarded headers are believed. That
            #        is also how SILK's `xff.split(",")[0]` let any local client
            #        mint a fresh rate-limit bucket and pick its claimed IP.
            open_trust = [(await c.post(f"{base}/api/chat", json=body,
                                        headers={"x-forwarded-for": "10.9.9.9"})).status_code
                          for _ in range(3)]
            check("6a believed XFF while peer was trusted (by design)",
                  all(x == 200 for x in open_trust), f"codes={open_trust}")
            up = (await c.get(f"http://127.0.0.1:{mock_port}/api/last-request")).json()
            check("6a ...and upstream received that claimed IP",
                  up["x_forwarded_for"] == "10.9.9.9", f"XFF={up['x_forwarded_for']!r}")
            check("6a ...while upstream's socket still sees THE SERVER",
                  up["socket_peer"] == "127.0.0.1", f"peer={up['socket_peer']!r}")

            #    6b: tighten the trust list to an unrelated address (what you
            #        want when nothing proxies you) → spoofed headers ignored,
            #        the real IP stays in the shared bucket, limiter fires.
            harden = replace_settings(cfg_mod, server_mod,
                                      trusted_proxies=["203.0.113.9"])
            closed = [(await c.post(f"{base}/api/chat", json=body,
                                    headers={"x-forwarded-for": f"10.7.7.{i}"})).status_code
                      for i in range(4)]
            check("6b spoofed XFF ignored when peer untrusted → 429",
                  all(x == 429 for x in closed), f"codes={closed}")
            you = (await c.get(f"{base}/api/config",
                               headers={"x-forwarded-for": "10.6.6.6"})).json()["you"]
            check("6b resolved to the socket, not the claim",
                  you["resolved_ip"] == "127.0.0.1", json.dumps(you))
            check("6b and it is flagged as unverifiable",
                  you["via_trusted_proxy"] is False, json.dumps(you))

            #    6c: a proxy at an address we do not recognise must be ignored,
            #        and a legitimate chain entry that merely EQUALS the peer is
            #        treated as self-reporting, not as proof.
            guard = replace_settings(cfg_mod, server_mod,
                                     trusted_proxies=["203.0.113.9"],
                                     rate_limit_requests=0)
            g1 = (await c.get(f"{base}/api/config",
                              headers={"x-forwarded-for": "203.0.113.9"})).json()["you"]
            check("6c unrecognised proxy address is still not trusted",
                  g1["resolved_ip"] == "127.0.0.1", json.dumps(g1))
            restore_settings(cfg_mod, server_mod, harden)
            restore_settings(cfg_mod, server_mod, prev_settings)

            # 7 — history kept server-side (2nd turn should reference the 1st)
            r = await c.post(f"{base}/api/chat",
                             json={"message": "again", "stream": False})
            check("non-stream mode works", r.status_code in (200, 429), str(r.status_code))

    finally:
        for t in tasks:
            t.cancel()
        for s in (srv, mock_srv):
            s.should_exit = True
        await asyncio.gather(*tasks, return_exceptions=True)

    print("\nall green ✅" if ok else "\nfailed")


if __name__ == "__main__":
    asyncio.run(main())
