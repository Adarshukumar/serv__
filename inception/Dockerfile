# Inception Mercury — Docker for Hugging Face Spaces + Local
# Uses inception file, creates session on first entry, every request using user IP
# Browser network log shows server URL not infest URL, but real inception server sees user IP via headers
# Connect using user IP !! Not server IP

FROM python:3.11-slim

WORKDIR /app

# Install system deps for curl_cffi
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Hugging Face Spaces expects 7860
EXPOSE 7860

# For Hugging Face: create session on startup, use user IP for every request
ENV PYTHONUNBUFFERED=1
ENV PORT=7860

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "7860", "--proxy-headers", "--forwarded-allow-ips=*"]
