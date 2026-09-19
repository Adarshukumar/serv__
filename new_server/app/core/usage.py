from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional, List, Dict

@dataclass
class TurnUsage:
    model: str = "unknown"
    provider: str = "unknown"
    ok: bool = True
    error: str = ""
    prompt_chars: int = 0
    thinking_chars: int = 0
    content_chars: int = 0
    n_sources: int = 0
    elapsed_s: float = 0.0
    first_token_s: Optional[float] = None
    backend: str = "unknown"
    tokens: int = 0

    def __post_init__(self):
        if self.tokens == 0:
            total = self.prompt_chars + self.thinking_chars + self.content_chars
            self.tokens = max(1, round(total / 4))

    @property
    def tokens_per_s(self) -> float:
        return round(self.tokens / self.elapsed_s, 2) if self.elapsed_s > 0 else 0

    def format_line(self) -> str:
        status = "✓" if self.ok else "✗"
        ft = f"{self.first_token_s:.1f}s" if self.first_token_s is not None else "?"
        return f"{status} ⏱ {self.elapsed_s:.1f}s · first {ft} · ~{self.tokens} tok · {self.tokens_per_s} tok/s · {self.backend} · {self.provider}/{self.model} · 📚 {self.n_sources}"

@dataclass
class SessionUsage:
    turns: List[TurnUsage] = field(default_factory=list)

    def add(self, turn: TurnUsage):
        self.turns.append(turn)

    def clear(self):
        self.turns.clear()

    def totals(self) -> Dict:
        ok = [t for t in self.turns if t.ok]
        return {
            "total": len(self.turns),
            "ok": len(ok),
            "failed": len(self.turns) - len(ok),
            "elapsed": round(sum(t.elapsed_s for t in ok), 2),
            "tokens": sum(t.tokens for t in ok),
        }
