import type { InceptionErrorKind, Source, ThinkingMode } from '../site';

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface AssistantMeta {
  thinking: ThinkingMode;
  webSearch: boolean;
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

export interface Settings {
  thinking: ThinkingMode;
  webSearch: boolean;
  system: string;
  theme: ThemeChoice;
  readingSize: number;
  readingFace: ReadingFace;
  dropCaps: boolean;
  followUps: boolean;
}

export type ConnectionStatus = 'connecting' | 'live' | 'challenge' | 'offline' | 'error' | 'preview';

export interface ConnectionState {
  status: ConnectionStatus;
  message?: string;
  detail?: string;
  fetchedAt: number | null;
  issuedAt: number | null;
  refreshCount: number;
  browserOpen: boolean;
}

export interface UiState {
  sidebarOpen: boolean;
  settingsOpen: boolean;
}

export interface AppState {
  ready: boolean;
  settings: Settings;
  connection: ConnectionState;
  list: ConversationMeta[];
  active: Conversation | null;
  streamingId: string | null;
  ui: UiState;
}
