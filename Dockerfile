# ══════════════════════════════════════════════════════════════
#  SILK — Hugging Face Spaces, Docker SDK
#
#  python:3.12-slim · app_id 7860 · non-root · no browser, no proxy
#
#  The image this replaces installed chromium + chromedriver + xvfb (~700 MB)
#  to drive a headless browser past Cloudflare, and shipped a hardcoded
#  third-party HTTP proxy that every user's traffic flowed through. This one
#  installs four Python packages and connects directly.
# ══════════════════════════════════════════════════════════════
# ---
# title: SILK
# emoji: "🧵"
# sdk: docker
# app_file: Server.py
# app_port: 7860
# pinned: false
# short_description: "Streaming chat over a direct, proxy-free upstream client"
# tags:
#   - api
#   - fastapi
#   - streaming
# ---

FROM python:3.12-slim

# HF Spaces requires a non-root user with uid 1000.
RUN groupadd --gid 1000 appuser \
 && useradd  --uid 1000 --gid 1000 --create-home appuser

WORKDIR /app

# ── deps first, for layer caching ───────────────────────────
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt \
 && rm -rf ~/.cache/pip

# ── app code ────────────────────────────────────────────────
# mock/ + tests/ are intentionally NOT copied: the fake upstream and the
# suite have no business being reachable in a production image.
COPY app/   ./app/
COPY web/   ./web/
COPY run.py Server.py ./

# ── Space runtime contract ─────────────────────────────────
# The app must read env vars itself: a process manager in front of it would
# need root. 7860 is fixed by the Space definition.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOST=0.0.0.0 \
    PORT=7860 \
    LOG_LEVEL=info \
    # On a Space every request arrives from the local proxy, so forwarded
    # headers are the only attribution signal available. See README §HF.
    TRUSTED_PROXIES=127.0.0.1,::1 \
    FORWARD_CLIENT_IP=1 \
    HOST_GUARD=1 \
    # modest, because one free CPU and a shared upstream IP
    MAX_CONCURRENCY=4 \
    RATE_LIMIT_REQUESTS=12 \
    RATE_LIMIT_WINDOW=60

# bind before copy so the copied files aren't owned by root
RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; \
sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:7860/healthcheck',timeout=4).status==200 else 1)"

# run.py wires uvicorn's proxy trust to TRUSTED_PROXIES, so there is one
# trust decision instead of two disagreeing ones.
CMD ["python", "run.py"]
