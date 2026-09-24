import type { InceptionErrorKind, Source, ThinkingMode } from '../core';
import type { TransportMode } from '../platform/transport';

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface AssistantMeta {
  thinking: ThinkingMode;
  webSearch: boolean;
  mode: TransportMode;
  startedAt: number;
  reasoningStartedAt?: number;
  reasoningEndedAt?: number;
  firstTokenAt?: number;
  finishedAt?: number;
}

export interface MessageError {
  kind: InceptionErrorKind;
  message: string;
  detail?: string;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  /* assistant only */
  reasoning?: string;
  sources?: Source[];
  followUps?: string[];
  status?: MessageStatus;
  error?: MessageError;
  searching?: boolean;
  searchFailed?: boolean;
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
export type TransportChoice = 'auto' | 'direct' | 'bridge';

export interface Settings {
  thinking: ThinkingMode;
  webSearch: boolean;
  system: string;
  theme: ThemeChoice;
  readingSize: number;
  readingFace: ReadingFace;
  dropCaps: boolean;
  followUps: boolean;
  transport: TransportChoice;
}

export type ConnectionStatus =
  | 'connecting'
  | 'live'
  | 'challenge'
  | 'verifying'
  | 'offline'
  | 'blocked'
  | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  mode: TransportMode;
  message?: string;
  detail?: string;
  fetchedAt: number | null;
  issuedAt: number | null;
  refreshCount: number;
  /** Progress text while a security check is running. */
  progress?: string;
}

export interface UiState {
  sidebarOpen: boolean;
  settingsOpen: boolean;
}

export interface AppState {
  ready: boolean;
  runtime: 'extension' | 'web';
  settings: Settings;
  connection: ConnectionState;
  list: ConversationMeta[];
  active: Conversation | null;
  streamingId: string | null;
  ui: UiState;
}
