# ONE DOCKERFILE — Clone this branch that folder to run using it — As soon as you put Dockerfile it starts working
# This Dockerfile clones branch arena/01a0b57f-serv inception folder exactly and runs it
# For Hugging Face Spaces: Put this single Dockerfile in your Space repo root, push, it will start working

FROM python:3.11-slim

WORKDIR /app

# Install git (needed to clone)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Clone this branch that folder exactly
# Branch: arena/01a0b57f-serv
# Repo: Adarshukumar/serv__
# Folder: inception/
RUN git clone --branch arena/01a0b57f-serv https://github.com/Adarshukumar/serv__.git /tmp/repo || \
    git clone https://github.com/Adarshukumar/serv__.git /tmp/repo && \
    cp -r /tmp/repo/inception/* /app/ && \
    rm -rf /tmp/repo && \
    ls -la /app/

# Install deps from inception folder
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r /app/requirements.txt

# Hugging Face Spaces expects 7860
EXPOSE 7860

ENV PYTHONUNBUFFERED=1
ENV PORT=7860
ENV PYTHONPATH=/app

# As soon as you put Dockerfile it starts working — runs inception with user IP forwarding, session on entry
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--proxy-headers", "--forwarded-allow-ips=*"]
