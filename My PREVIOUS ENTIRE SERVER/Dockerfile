# ══════════════════════════════════════════════════════════════
#  Dockerfile — Local AI Server for Hugging Face Spaces
#  Base : python:3.11-slim
#  Port : 7860  (HF Spaces default)
#  Extra: Chromium + DrissionPage + curl_cffi support
# ══════════════════════════════════════════════════════════════

FROM python:3.11-slim

# ── Non-root user (HF Spaces requirement) ─────────────────────
RUN groupadd --gid 1000 appuser \
 && useradd  --uid 1000 --gid 1000 --create-home appuser

# ── System deps: Chromium + all its shared libs ───────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
        # Core utilities
        curl \
        ca-certificates \
        git \
        # curl_cffi native build deps
        gcc \
        libffi-dev \
        # Chromium browser (for DrissionPage headless)
        chromium \
        chromium-driver \
        # Chromium runtime shared libs
        libnss3 \
        libatk1.0-0 \
        libatk-bridge2.0-0 \
        libcups2 \
        libdrm2 \
        libxkbcommon0 \
        libxcomposite1 \
        libxdamage1 \
        libxfixes3 \
        libxrandr2 \
        libgbm1 \
        libasound2 \
        libpango-1.0-0 \
        libpangocairo-1.0-0 \
        fonts-liberation \
        # Headless display (needed even in --headless=new mode)
        xvfb \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ── Tell DrissionPage where Chromium lives ────────────────────
ENV CHROME_BIN=/usr/bin/chromium \
    CHROMEDRIVER_PATH=/usr/bin/chromedriver

WORKDIR /app

# ── Python dependencies ────────────────────────────────────────
COPY requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r requirements.txt

# ── App code ──────────────────────────────────────────────────
COPY Server.py ./
COPY API/      ./API/

# ── Permissions ───────────────────────────────────────────────
RUN chown -R appuser:appuser /app

# ── Chrome sandbox dir writable by appuser ────────────────────
# DrissionPage writes its profile/cache here
RUN mkdir -p /tmp/.cache/upstage \
 && chown -R appuser:appuser /tmp/.cache

USER appuser

# ── Runtime env vars ──────────────────────────────────────────
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    # Server
    SERVER_HOST=0.0.0.0 \
    SERVER_PORT=7860 \
    SERVER_LOG_LEVEL=info \
    SERVER_RELOAD=0 \
    # Model defaults
    LOCAL_DEFAULT_MODEL=kimi-k2 \
    SERVER_SYSTEM_PROMPT="You are a So powerfUl assistant Powered By Adarsh Kumar" \
    # Session / concurrency
    SERVER_MAX_CONCURRENCY=16 \
    SERVER_MAX_SESSIONS=1024 \
    SERVER_MAX_HISTORY_TURNS=16 \
    SERVER_SESSION_TTL_SECONDS=3600 \
    # Background task intervals
    SERVER_CLEANUP_SECONDS=300 \
    SERVER_WARMUP_SECONDS=900 \
    SERVER_CRED_REFRESH_SECONDS=1800 \
    # DrissionPage — point to system Chromium, disable sandbox (needed in containers)
    DRISSIONPAGE_CHROMIUM_PATH=/usr/bin/chromium \
    # Mercury / Upstage credential cache dirs
    MERCURY_CACHE_DIR=/tmp/.cache/mercury \
    UPSTAGE_CACHE_DIR=/tmp/.cache/upstage

# ── Health check ──────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -f http://localhost:7860/health || exit 1

EXPOSE 7860

CMD ["python", "-m", "uvicorn", \
     "Server:app", \
     "--host", "0.0.0.0", \
     "--port", "7860", \
     "--log-level", "info", \
     "--no-access-log"]