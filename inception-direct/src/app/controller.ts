import {
  SourceCollector,
  createId,
  toInceptionError,
  type ChatTurn,
  type InceptionError,
} from '../site';
import { LocalClient, PreviewOnlyError, type CompanionStatus } from './localClient';
import * as storage from './storage';
import { createStore } from './store';
import type { AppState, AssistantMeta, ConnectionState, Conversation, Message, Settings } from './types';

/**
 * The app's brain. No official API, no key, no extension, no remote proxy.
 *
 * Start → the localhost companion opens Inception in a dedicated Chrome profile →
 * same-origin /api/session → live → /api/chat SSE, sources, follow-ups. Only the
 * companion holds the session token. The UI sees typed stream events, not cookies.
 */

const STREAM_FRAME_MS = 40;
const POLL_MS = 2_500;
const initialSettings = storage.loadSettings();
const client = new LocalClient();

export const store = createStore<AppState>({
  ready: false,
  settings: initialSettings,
  connection: { status: 'connecting', fetchedAt: null, issuedAt: null, refreshCount: 0, browserOpen: false },
  list: [], active: null, streamingId: null,
  ui: { sidebarOpen: false, settingsOpen: false },
});

/** Conversations touched this session (active one, and any that is still streaming). */
const cache = new Map<string, Conversation>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
let streaming: { convId: string; messageId: string; controller: AbortController } | null = null;
let pendingRetry: { convId: string; messageId: string } | null = null;
let connectRun = 0;
let initialised = false;
let polling = false;

/* ────────────────────────────── setup ────────────────────────────── */

export async function init(): Promise<void> {
  if (initialised) return;
  initialised = true;

  // The previous version required an official API key. It must not be left around
  // on the user's device; this version never reads or sends it.
  try { localStorage.removeItem('inception-direct.api-key.v1'); } catch { /* disabled */ }
  try { sessionStorage.removeItem('inception-direct.api-key.v1'); } catch { /* disabled */ }

  const list = await storage.listConversations().catch(() => []);
  store.set((s) => ({ ...s, list, ready: true }));
  await syncStatus();
  window.setInterval(() => { if (document.visibilityState === 'visible') void syncStatus(); }, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncStatus();
  });
  window.addEventListener('online', () => {
    if (store.get().connection.status === 'offline') void connect();
  });
}

/* ─────────────────────────── connection ─────────────────────────── */

function setConnection(patch: Partial<ConnectionState>): void {
  store.set((s) => ({ ...s, connection: { ...s.connection, ...patch } }));
}

function applyStatus(status: CompanionStatus): void {
  setConnection({
    status: status.status, message: status.message, detail: status.detail,
    fetchedAt: status.fetchedAt, issuedAt: status.issuedAt,
    refreshCount: status.refreshCount, browserOpen: status.browserOpen,
  });
  if (status.status === 'live' && pendingRetry && !streaming) {
    const { convId, messageId } = pendingRetry;
    pendingRetry = null;
    void retry(messageId, convId);
  }
}

async function syncStatus(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    applyStatus(await client.status());
  } catch (error) {
    if (error instanceof PreviewOnlyError) {
      setConnection({ status: 'preview', message: error.message, detail: undefined });
    } else {
      const err = toInceptionError(error);
      setConnection({ status: 'offline', message: err.message, detail: err.detail });
    }
  } finally { polling = false; }
}

export async function connect(): Promise<boolean> {
  if (store.get().connection.status === 'preview') return false;
  const run = ++connectRun;
  setConnection({ status: 'connecting', message: 'Opening the site browser and creating a session…', detail: undefined });
  try {
    const status = await client.connect();
    if (run !== connectRun) return false;
    applyStatus(status);
    return status.status === 'live';
  } catch (error) {
    if (run !== connectRun) return false;
    handleFailure(toInceptionError(error));
    return false;
  }
}

function handleFailure(err: InceptionError): void {
  if (err.kind === 'aborted') return;
  if (err.kind === 'challenge') setConnection({ status: 'challenge', message: err.message, detail: err.detail });
  else if (err.kind === 'network') setConnection({ status: 'offline', message: err.message, detail: err.detail });
  else if (err.kind === 'auth') setConnection({ status: 'error', message: err.message, detail: err.detail });
  // Rate limits, other HTTP errors and stream cuts belong to the message only.
}

/** Show the site's real security check; never try to solve or bypass it. */
export async function verify(): Promise<void> {
  try { await client.showSite(); }
  catch (error) { handleFailure(toInceptionError(error)); }
}

/* ─────────────────────────── conversations ─────────────────────────── */

function updateConversation(id: string, fn: (c: Conversation) => Conversation): void {
  const current = cache.get(id) ?? (store.get().active?.id === id ? store.get().active : null);
  if (!current) return;
  const next = fn(current);
  cache.set(id, next);
  if (store.get().active?.id === id) store.set((s) => ({ ...s, active: next }));
  schedulePersist(id);
}

function updateMessage(convId: string, messageId: string, patch: Partial<Message>): void {
  updateConversation(convId, (c) => ({
    ...c,
    messages: c.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
  }));
}

function schedulePersist(id: string, delay = 800): void {
  const existing = persistTimers.get(id);
  if (existing) clearTimeout(existing);
  persistTimers.set(
    id,
    setTimeout(() => {
      persistTimers.delete(id);
      void persist(id);
    }, delay),
  );
}

async function persist(id: string): Promise<void> {
  const conversation = cache.get(id);
  if (!conversation || conversation.messages.length === 0) return;
  try {
    await storage.saveConversation(conversation);
    const meta = storage.toMeta(conversation);
    store.set((s) => ({
      ...s,
      list: [meta, ...s.list.filter((m) => m.id !== id)].sort((a, b) => b.updatedAt - a.updatedAt),
    }));
  } catch (error) {
    console.warn('[inception-direct] could not save conversation', error);
  }
}

function persistNow(id: string): void {
  const existing = persistTimers.get(id);
  if (existing) clearTimeout(existing);
  persistTimers.delete(id);
  void persist(id);
}

function makeTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'New conversation';
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

export function newChat(): void {
  pendingRetry = null;
  store.set((s) => ({ ...s, active: null, ui: { ...s.ui, sidebarOpen: false } }));
}

export async function selectChat(id: string): Promise<void> {
  pendingRetry = null;
  const conversation = cache.get(id) ?? (await storage.loadConversation(id));
  if (!conversation) return;
  cache.set(id, conversation);
  store.set((s) => ({ ...s, active: conversation, ui: { ...s.ui, sidebarOpen: false } }));
}

export async function deleteChat(id: string): Promise<void> {
  if (pendingRetry?.convId === id) pendingRetry = null;
  if (streaming?.convId === id) streaming.controller.abort();
  const timer = persistTimers.get(id);
  if (timer) clearTimeout(timer);
  persistTimers.delete(id);
  cache.delete(id);
  await storage.deleteConversation(id).catch(() => {});
  store.set((s) => ({
    ...s,
    list: s.list.filter((m) => m.id !== id),
    active: s.active?.id === id ? null : s.active,
  }));
}

export async function deleteAllChats(): Promise<void> {
  pendingRetry = null;
  streaming?.controller.abort();
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  cache.clear();
  await storage.clearConversations().catch(() => {});
  store.set((s) => ({ ...s, list: [], active: null }));
}

/* ─────────────────────────── chatting ─────────────────────────── */

function freshAssistantFields(now: number): Partial<Message> {
  const { settings } = store.get();
  const meta: AssistantMeta = {
    thinking: settings.thinking,
    webSearch: settings.webSearch,
    startedAt: now,
  };
  return {
    content: '',
    reasoning: '',
    sources: [],
    followUps: undefined,
    status: 'streaming',
    error: undefined,
    searching: false,
    searchFailed: false,
    meta,
  };
}

/** Finished turns before the given message, in the shape the client sends. */
function historyFor(messages: readonly Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const [index, m] of messages.entries()) {
    if (m.role === 'user') {
      const reply = messages[index + 1];
      // When starting a NEW answer, skip an older question whose answer failed
      // (or was stopped before writing anything). Otherwise two adjacent user
      // turns get merged by toWireMessages, repeating a failed prompt forever.
      // On retry the target assistant isn't in this slice, so its question stays.
      if (reply?.role === 'assistant' && (reply.status === 'error' || (reply.status === 'stopped' && !reply.content.trim()))) continue;
      turns.push({ id: m.id, role: 'user', text: m.content });
    } else if ((m.status === 'done' || m.status === 'stopped') && m.content.trim()) {
      turns.push({ id: m.id, role: 'assistant', text: m.content });
    }
  }
  return turns;
}

export async function send(text: string): Promise<void> {
  const value = text.trim();
  if (!value || streaming || store.get().connection.status !== 'live') return;
  const now = Date.now();

  let conversation = store.get().active;
  if (!conversation) {
    conversation = { id: createId(), title: makeTitle(value), createdAt: now, updatedAt: now, messages: [] };
    cache.set(conversation.id, conversation);
    store.set((s) => ({ ...s, active: conversation }));
  } else {
    cache.set(conversation.id, conversation);
  }

  const user: Message = { id: createId(), role: 'user', content: value, createdAt: now };
  const assistant: Message = { id: createId(), role: 'assistant', createdAt: now, ...freshAssistantFields(now) } as Message;
  updateConversation(conversation.id, (c) => ({ ...c, updatedAt: now, messages: [...c.messages, user, assistant] }));
  persistNow(conversation.id);

  await streamAnswer(conversation.id, assistant.id);
}

/** Run (or re-run) an assistant message. */
export async function retry(messageId: string, convId = store.get().active?.id): Promise<void> {
  if (!convId || streaming) return;
  if (pendingRetry?.messageId === messageId) pendingRetry = null;
  const conversation = cache.get(convId) ?? (store.get().active?.id === convId ? store.get().active : null);
  if (!conversation?.messages.some((m) => m.id === messageId && m.role === 'assistant')) return;
  cache.set(convId, conversation);
  updateMessage(convId, messageId, freshAssistantFields(Date.now()));
  await streamAnswer(convId, messageId);
}

export function stop(): void {
  streaming?.controller.abort();
}

async function streamAnswer(convId: string, messageId: string): Promise<void> {
  const conversation = cache.get(convId);
  if (!conversation) return;
  const index = conversation.messages.findIndex((m) => m.id === messageId);
  if (index < 0) return;

  const turns = historyFor(conversation.messages.slice(0, index));
  const { settings } = store.get();
  const controller = new AbortController();
  streaming = { convId, messageId, controller };
  store.set((s) => ({ ...s, streamingId: messageId }));

  const meta: AssistantMeta = { ...(conversation.messages[index]!.meta as AssistantMeta) };
  const sources = new SourceCollector();
  let text = '';
  let reasoning = '';
  let pendingText = '';
  let pendingReasoning = '';
  let streamError: string | null = null;
  let frame: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (frame) {
      clearTimeout(frame);
      frame = null;
    }
    if (!pendingText && !pendingReasoning) return;
    text += pendingText;
    reasoning += pendingReasoning;
    pendingText = '';
    pendingReasoning = '';
    updateMessage(convId, messageId, { content: text, reasoning });
  };
  const scheduleFlush = () => {
    frame ??= setTimeout(flush, STREAM_FRAME_MS);
  };

  try {
    for await (const event of client.chat({
      chatId: convId,
      turns,
      thinking: settings.thinking,
      webSearch: settings.webSearch,
      system: settings.system,
      signal: controller.signal,
    })) {
      const now = Date.now();
      switch (event.type) {
        case 'reasoning-delta':
          if (!meta.reasoningStartedAt) {
            meta.reasoningStartedAt = now;
            updateMessage(convId, messageId, { meta: { ...meta } });
          }
          pendingReasoning += event.delta;
          scheduleFlush();
          break;
        case 'text-delta':
          if (!meta.firstTokenAt) {
            meta.firstTokenAt = now;
            if (meta.reasoningStartedAt && !meta.reasoningEndedAt) meta.reasoningEndedAt = now;
            updateMessage(convId, messageId, { meta: { ...meta }, searching: false });
          }
          pendingText += event.delta;
          scheduleFlush();
          break;
        case 'source':
          if (sources.add(event.source)) updateMessage(convId, messageId, { sources: sources.list() });
          break;
        case 'searching':
          updateMessage(convId, messageId, { searching: true });
          break;
        case 'search-error':
          updateMessage(convId, messageId, { searching: false, searchFailed: true });
          break;
        case 'error':
          streamError = event.message;
          break;
        case 'abort':
          streamError ??= 'The server stopped this answer early.';
          break;
        default:
          break;
      }
    }

    flush();
    meta.finishedAt = Date.now();
    if (meta.reasoningStartedAt && !meta.reasoningEndedAt) meta.reasoningEndedAt = meta.finishedAt;
    const error = streamError
      ? { kind: 'stream' as const, message: streamError }
      : !text.trim()
        ? { kind: 'protocol' as const, message: 'Mercury finished without writing an answer.' }
        : undefined;
    updateMessage(convId, messageId, { status: error ? 'error' : 'done', error, searching: false, meta: { ...meta } });
    if (store.get().connection.status !== 'live') void syncStatus();
    if (!error && settings.followUps) void loadFollowUps(convId, messageId, [...turns, { role: 'assistant', text }]);
  } catch (error) {
    flush();
    const err = toInceptionError(error);
    meta.finishedAt = Date.now();
    if (err.kind === 'aborted') {
      updateMessage(convId, messageId, { status: 'stopped', searching: false, meta: { ...meta } });
    } else {
      updateMessage(convId, messageId, {
        status: 'error',
        searching: false,
        meta: { ...meta },
        error: { kind: err.kind, message: err.message, detail: err.detail },
      });
      if (err.kind === 'challenge') pendingRetry = { convId, messageId };
      handleFailure(err);
    }
  } finally {
    if (streaming?.messageId === messageId) {
      streaming = null;
      store.set((s) => ({ ...s, streamingId: null }));
    }
    persistNow(convId);
  }

}

async function loadFollowUps(convId: string, messageId: string, turns: ChatTurn[]): Promise<void> {
  const list = await client.followUps(turns);
  if (list.length) updateMessage(convId, messageId, { followUps: list });
}

/* ─────────────────────────── settings & ui ─────────────────────────── */

export function updateSettings(patch: Partial<Settings>): void {
  const next = storage.sanitiseSettings({ ...store.get().settings, ...patch });
  storage.saveSettings(next);
  store.set((s) => ({ ...s, settings: next }));
}

export function setUi(patch: Partial<AppState['ui']>): void {
  store.set((s) => ({ ...s, ui: { ...s.ui, ...patch } }));
}
