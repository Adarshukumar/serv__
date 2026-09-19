from __future__ import annotations
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field, field_validator

class ChatRequest(BaseModel):
    user_id: Optional[str] = None
    user: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    messages: Optional[List[Dict[str, Any]]] = None
    system: Optional[str] = None
    stream: bool = True
    # search is AUTO now — like inception.py and upstage, no manual toggle, no Tavily
    # Kept for backward compat but ignored — sources auto via SSE if needed
    search: Optional[bool] = Field(default=None, description="Deprecated: search auto")
    thinking: Optional[bool] = None
    temperature: Optional[float] = Field(default=None, ge=0, le=2)
    max_tokens: Optional[int] = Field(default=None, ge=1, le=8192)
    max_output_tokens: Optional[int] = Field(default=None, ge=1, le=8192)
    clear_history: bool = False
    client_ip: Optional[str] = None

    @field_validator('prompt')
    @classmethod
    def validate_prompt(cls, v):
        if v and len(v) > 8000:
            raise ValueError('Prompt too long, max 8000 chars')
        return v

    @field_validator('messages')
    @classmethod
    def validate_messages(cls, v):
        if v and len(v) > 50:
            raise ValueError('Too many messages, max 50')
        return v

    @property
    def resolved_user_id(self) -> str:
        return (self.user_id or self.user or "anon").strip()[:128]

    @property
    def resolved_max_tokens(self) -> Optional[int]:
        return self.max_output_tokens or self.max_tokens

class LoadTestRequest(BaseModel):
    n_users: int = Field(default=10, ge=1, le=200, description="Number of parallel users")
    prompt: str = Field(default="Hi in one word", description="Prompt for all users")
    provider: Optional[str] = Field(default=None, description="Provider to test")
    model: Optional[str] = Field(default=None, description="Model to test")
    parallel: bool = Field(default=True, description="Parallel via asyncio.gather")
    # search auto now
    search: Optional[bool] = Field(default=None, description="Deprecated auto")

class ProviderTestRequest(BaseModel):
    provider: str = Field(description="Provider name")
    model: Optional[str] = None
    prompt: str = Field(default="Hello! in one word")
    search: Optional[bool] = Field(default=None, description="Deprecated auto")
