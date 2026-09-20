"""
HF Spaces compatibility shim.

A Docker-SDK Space whose metadata declares `app_file: Server.py` imports this
module to confirm `app` exists. The real entrypoint is `run.py` (it wires
uvicorn's proxy trust to TRUSTED_PROXIES, which matters — see README), so this
file is a thin re-export, not a second server.

If you drop the `app_file` line from the Dockerfile header and let the Space
use CMD, this file becomes dead weight and can be deleted.
"""
from app.server import app  # noqa: F401  (Space probes for `app`)

__all__ = ["app"]
