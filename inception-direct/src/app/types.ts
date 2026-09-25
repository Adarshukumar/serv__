import type { InceptionErrorKind, ModelInfo, ReasoningEffort, Usage } from '../core';

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface AssistantMeta {
  model: string;
  effort: ReasoningEffort;
  diffusing: boolean;
  /** max_completion_tokens that was sent. */
  maxTokens?: number;
  startedAt: number;
  firstTokenAt?: number;
  finishedAt?: number;
  finishReason?: string;
  usage?: Usage;
  /** Diffusing mode: how many denoising steps arrived. */
  steps?: number;
  warning?: string;
}

export interface MessageError {
  kind: InceptionErrorKind;
  message: string;
  detail?: string;
  code?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /* assistant only */
  reasoningSummary?: string;
  followUps?: string[];
  status?: MessageStatus;
  error?: MessageError;
  meta?: AssistantMeta;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type ThemeChoice = 'paper' | 'night' | 'system';
export type ReadingFace = 'serif' | 'sans';

export interface Settings {
  model: string;
  effort: ReasoningEffort;
  /** Show Mercury's denoising steps while it writes. */
  diffusing: boolean;
  /** Ask for a summary of the model's reasoning. */
  reasoningSummary: boolean;
  followUps: boolean;
  lengthLimit: number;
  system: string;
  theme: ThemeChoice;
  readingSize: number;
  readingFace: ReadingFace;
  dropCaps: boolean;
}

export type ConnectionStatus =
  /** No API key saved yet. */
  | 'no-key'
  /** Handshake in flight. */
  | 'connecting'
  | 'live'
  /** Inception rejected the key. */
  | 'auth'
  /** Out of credit / billing inactive. */
  | 'billing'
  | 'offline'
  | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  message?: string;
  detail?: string;
  /** Round trip of the last successful handshake. */
  latencyMs?: number;
  checkedAt: number | null;
  /** The key, masked (e.g. "sk_a…9fQ2"), or null. */
  keyHint: string | null;
  /** Saved in localStorage (true) or only for this tab (false). */
  remember: boolean;
}

export interface RetryNote {
  attempt: number;
  of: number;
  kind: InceptionErrorKind;
  until: number;
}

export interface UiState {
  sidebarOpen: boolean;
  settingsOpen: boolean;
  /** The key form is open on purpose (changing a working key). */
  keyEditor: boolean;
  /** A key submitted from the card is being checked — keep the card on screen meanwhile. */
  keyCheck: boolean;
}

export interface AppState {
  ready: boolean;
  settings: Settings;
  connection: ConnectionState;
  models: ModelInfo[];
  list: ConversationMeta[];
  active: Conversation | null;
  streamingId: string | null;
  /** Set while a request waits to be retried (429/5xx backoff). */
  retry: RetryNote | null;
  ui: UiState;
}
