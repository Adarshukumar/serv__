#!/usr/bin/env python3
"""
SILK launcher.

    python run.py                # real upstream (https://chat.inceptionlabs.ai)
    python run.py --mock         # + local fake upstream on :8099, nothing external touched
    python run.py --port 8080 --mock
    python run.py --mock --mock-port 8099 --host 0.0.0.0

THE MOCK LISTENS ON --host, NOT ON LOOPBACK
  It used to hardcode 127.0.0.1, which broke any environment that reaches the
  sandbox over a proxied hostname (Arena preview, a Docker network, a remote
  dev box): the app itself works fine because it talks to the mock over
  loopback, but a port bound to loopback is invisible to everyone else, and
  "which port is listening" tooling flags it as a misconfiguration. Binding to
  0.0.0.0 costs nothing here because INCEPTION_BASE_URL keeps pointing at
  127.0.0.1 — the mock is still only reachable from inside the box/network.
  If you want it loopback-only again, pass --mock-host 127.0.0.1.
    python run.py --check        # print the resolved config and exit

--mock exists so you can develop the app without sending a single request to
the real service, and so the test suite can assert on what the "backend"
received instead of trusting a claim.
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))          # makes `app` importable from anywhere
os.chdir(HERE)


def allow_hint(cfg) -> list[str]:
    return [p for p in cfg.trusted_proxies if p.strip()]


def main() -> int:
    ap = argparse.ArgumentParser(description="SILK chat server")
    ap.add_argument("--port", type=int, default=int(os.getenv("PORT", "7860")))
    ap.add_argument("--host", default=os.getenv("HOST", "0.0.0.0"))
    ap.add_argument("--mock", action="store_true", help="run a fake upstream locally")
    ap.add_argument("--mock-port", type=int, default=8099)
    ap.add_argument("--mock-host", default=None,
                    help="defaults to --host; pass 127.0.0.1 to pin it to loopback")
    ap.add_argument("--log", default=os.getenv("LOG_LEVEL", "info"))
    ap.add_argument("--check", action="store_true", help="print config and exit")
    args = ap.parse_args()

    mock_host = args.mock_host or args.host
    if args.mock:
        # The app reaches the mock over loopback regardless of what the mock
        # binds to — the app runs in this same box/network namespace.
        os.environ["INCEPTION_BASE_URL"] = f"http://127.0.0.1:{args.mock_port}"

    from app.config import banner, settings

    print("─── SILK " + "─" * 54)
    print(banner())
    print(f"serving    : http://localhost:{args.port}")
    print("───" + "─" * 61)

    if args.check:
        warns = []
        if settings.trust_all_proxies:
            warns.append("TRUST_ALL_PROXIES=1 → any client can pick its own "
                         "identity; per-IP limits are cosmetic")
        if not allow_hint(settings) and not settings.trust_all_proxies:
            warns.append("TRUSTED_PROXIES is empty → X-Forwarded-For ignored, "
                         "every user shares one bucket (correct if exposed "
                         "directly; wrong if a proxy is in front)")
        if not settings.forward_client_ip:
            warns.append("FORWARD_CLIENT_IP=0 → upstream gets no client attribution at all")
        if "chat.inceptionlabs.ai" in settings.base_url:
            warns.append("upstream is the live API: prompts leave this box. "
                         "Use --mock while developing")
        for w in warns:
            print(f"  ⚠ {w}")
        if not warns:
            print("  no configuration warnings")
        return 0

    mock_proc = None
    if args.mock:
        mock_proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "mock.inception_api:app",
             "--host", mock_host, "--port", str(args.mock_port),
             "--log-level", "warning", "--no-proxy-headers"],
            cwd=str(HERE),
        )
        # wait for the mock to answer before the app warms up
        import urllib.request
        for _ in range(60):
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{args.mock_port}/api/session", timeout=1
                ):
                    break
            except Exception:
                time.sleep(0.1)
        else:
            print("mock upstream did not start", file=sys.stderr)
            mock_proc.kill()
            return 1

    cmd = [sys.executable, "-m", "uvicorn", "app.server:app",
           "--host", args.host, "--port", str(args.port), "--log-level", args.log]
    # One trust decision, not two: only let uvicorn rewrite request.client when
    # we also declared those addresses trusted. See app/server.py:main().
    allow = [p for p in settings.trusted_proxies if p.strip()]
    if not allow and not settings.trust_all_proxies:
        cmd.append("--no-proxy-headers")
    elif allow:
        cmd += ["--forwarded-allow-ips", ",".join(allow)]

    if mock_proc:
        print(f"mock upstream pid={mock_proc.pid} on {mock_host}:{args.mock_port} "
              f"(app connects via 127.0.0.1)")

    # Docker CMD ["python","run.py"] makes this process PID 1, and PID 1 does
    # not inherit the default SIGTERM action — without this, `docker stop`
    # ignores the 10s grace period and SIGKILLs uvicorn mid-stream, so open SSE
    # connections get an abrupt reset instead of a clean close.
    child = {"p": None}

    def _forward(sig, _frm):
        for proc in (child["p"], mock_proc):
            if proc and proc.poll() is None:
                try:
                    proc.send_signal(sig)
                except Exception:
                    pass

    signal.signal(signal.SIGTERM, _forward)
    signal.signal(signal.SIGHUP, _forward)

    try:
        return subprocess.call(cmd)
    except KeyboardInterrupt:
        return 130
    finally:
        if mock_proc and mock_proc.poll() is None:
            mock_proc.send_signal(signal.SIGTERM)
            try:
                mock_proc.wait(5)
            except subprocess.TimeoutExpired:
                mock_proc.kill()


if __name__ == "__main__":
    raise SystemExit(main())
