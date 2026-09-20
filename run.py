#!/usr/bin/env python3
"""
SILK launcher.

    python run.py                # real upstream (https://chat.inceptionlabs.ai)
    python run.py --mock         # + local fake upstream on :8099, nothing external touched
    python run.py --port 8080 --mock
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


def main() -> int:
    ap = argparse.ArgumentParser(description="SILK chat server")
    ap.add_argument("--port", type=int, default=int(os.getenv("PORT", "7860")))
    ap.add_argument("--host", default=os.getenv("HOST", "0.0.0.0"))
    ap.add_argument("--mock", action="store_true", help="run a fake upstream locally")
    ap.add_argument("--mock-port", type=int, default=8099)
    ap.add_argument("--log", default=os.getenv("LOG_LEVEL", "info"))
    ap.add_argument("--check", action="store_true", help="print config and exit")
    args = ap.parse_args()

    if args.mock:
        os.environ["INCEPTION_BASE_URL"] = f"http://127.0.0.1:{args.mock_port}"

    from app.config import banner, settings

    print("─── SILK " + "─" * 54)
    print(banner())
    print(f"serving    : http://localhost:{args.port}")
    print("───" + "─" * 61)

    if args.check:
        return 0

    mock_proc = None
    if args.mock:
        mock_proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "mock.inception_api:app",
             "--host", "127.0.0.1", "--port", str(args.mock_port),
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
        print(f"mock upstream pid={mock_proc.pid} → http://localhost:{args.mock_port}")

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
