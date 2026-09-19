"""
Base provider — StreamEvent, ThinkSplitter
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import List, Tuple

@dataclass
class StreamEvent:
    kind: str  # sources, thinking, content, done
    text: str = ""

_OPEN = "<think>"
_CLOSE = "</think>"

class ThinkSplitter:
    def __init__(self, open_tag: str = _OPEN, close_tag: str = _CLOSE):
        self._open = open_tag
        self._close = close_tag
        self._buf = ""
        self._in = False

    def feed(self, text: str) -> List[Tuple[str, str]]:
        out = []
        self._buf += text
        while True:
            if self._in:
                j = self._buf.find(self._close)
                if j == -1:
                    hold = len(self._close) - 1
                    if len(self._buf) > hold:
                        seg, self._buf = self._buf[:-hold], self._buf[-hold:]
                    else:
                        seg = ""
                    if seg:
                        out.append(("thinking", seg))
                    break
                seg = self._buf[:j]
                if seg:
                    out.append(("thinking", seg))
                self._in = False
                self._buf = self._buf[j + len(self._close):]
            else:
                i = self._buf.find(self._open)
                if i == -1:
                    hold = len(self._open) - 1
                    if len(self._buf) > hold:
                        seg, self._buf = self._buf[:-hold], self._buf[-hold:]
                    else:
                        seg = ""
                    if seg:
                        out.append(("content", seg))
                    break
                seg = self._buf[:i]
                if seg:
                    out.append(("content", seg))
                self._in = True
                self._buf = self._buf[i + len(self._open):]
        return out

    def flush(self) -> List[Tuple[str, str]]:
        if not self._buf:
            return []
        kind = "thinking" if self._in else "content"
        seg, self._buf = self._buf, ""
        return [(kind, seg)]
