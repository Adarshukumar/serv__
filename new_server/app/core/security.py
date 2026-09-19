"""
Security module — input validation, sanitization, CORS
"""
from __future__ import annotations
import re
import html
from typing import List, Dict, Any

BLOCKED_PATTERNS = [
    r"ignore previous instructions",
    r"disregard previous",
    r"system:\s*you are",
    r"<\s*script",
    r"javascript:",
    r"data:text/html",
]
BLOCKED_RE = re.compile("|".join(BLOCKED_PATTERNS), re.IGNORECASE)

def sanitize_prompt(prompt: str, max_length: int = 8000) -> str:
    if not prompt:
        return ""
    prompt = prompt.strip()[:max_length]
    prompt = prompt.replace("\x00", "")
    # Collapse whitespace
    prompt = re.sub(r'\s+', ' ', prompt)
    return prompt

def sanitize_for_log(text: str, max_len: int = 200) -> str:
    if not text:
        return ""
    return html.escape(text[:max_len])

def is_safe_prompt(prompt: str) -> bool:
    if not prompt:
        return False
    if BLOCKED_RE.search(prompt):
        return False
    return True

def validate_messages(messages: List[Dict[str, Any]]):
    if not messages:
        return
    if len(messages) > 50:
        raise ValueError("Too many messages, max 50")
    for m in messages:
        if not isinstance(m, dict):
            raise ValueError("Invalid message format")
        content = m.get("content", "")
        if isinstance(content, str) and len(content) > 8000:
            raise ValueError("Message content too long")

def get_cors_origins() -> List[str]:
    return ["*"]
