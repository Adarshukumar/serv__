"""
SSE helpers
"""
from __future__ import annotations
import json
from typing import Any, Dict

def _json_safe(data: Any) -> Any:
    if isinstance(data, dict):
        return {str(k): _json_safe(v) for k, v in data.items()}
    if isinstance(data, (list, tuple)):
        return [_json_safe(v) for v in data]
    if isinstance(data, (str, int, float, bool)) or data is None:
        return data
    return str(data)

def sse_event(event: str, payload: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(_json_safe(payload), ensure_ascii=False)}\n\n"

def sse_data(payload: Dict[str, Any]) -> str:
    return f"data: {json.dumps(_json_safe(payload), ensure_ascii=False)}\n\n"
