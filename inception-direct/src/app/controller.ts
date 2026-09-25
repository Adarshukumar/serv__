import {
  FALLBACK_MODELS,
  InceptionClient,
  createId,
  toInceptionError,
  type ChatTurn,
  type InceptionError,
  type ModelInfo,
  type RetryInfo,
} from '../core';
import { API_URL } from './env';
import * as storage from './storage';
import { createStore } from './store';
import type { AppState, AssistantMeta, ConnectionState, Conversation, Message, Settings } from './types';

/**
 * The app's brain. React components only read the store and call these functions.
 *
 *   open the page ─► key saved? ── no ──► key card (paste once, kept in this browser)
 *                        │ yes
 *                        ▼
 *        handshake: one tiny real completion ─► live ─┬─ send → stream real text → follow-ups
 *                        │                             └─ 429 / 5xx → back off and retry
 *                        └─ 401 → key card · 402 → billing · offline → retry when back online
 *
 * Every request goes from this browser straight to Inception's API. Nothing in between.
 */

const STREAM_FRAME_MS = 40;

const initialSettings = storage.loadSettings();
const storedKey = storage.loadKey();
let apiKey: string | null = storedKey?.key ?? null;

export const store = createStore<AppState>({
  ready: false,
  settings: initialSettings,
  connection: {
    status: apiKey ? 'connecting' : 'no-key',
    checkedAt: null,
    keyHint: apiKey ? storage.maskKey(apiKey) : null,
    remember: storedKey?.remember ?? true,
  },
  models: [...FALLBACK_MODELS],
  list: [],
  active: null,
  streamingId: null,
  retry: null,
  ui: { sidebarOpen: false, settingsOpen: false, keyEditor: false, keyCheck: false },
});

const client = new InceptionClient({
  apiUrl: API_URL,
  getKey: () => apiKey,
  onRetry: (info) => onRetry(info),
});

/** Conversations touched this session (the active one, and any that is still streaming). */
const cache = new Map<string, Conversation>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

let streaming: { convId: string; messageId: string; controller: AbortController } | null = null;
/** An answer that failed for want of a working key/credit — retried once that's fixed. */
let pendingRetry: { convId: string; messageId: string } | null = null;
let connectRun = 0;
let initialised = false;

/* ────────────────────────────── setup ────────────────────────────── */

export async function init(): Promise<void> {
  if (initialised) return;
  initialised = true;

  const list = await storage.listConversations().catch(() => []);
  store.set((s) => ({ ...s, list, ready: true }));

  window.addEventListener('online', () => {
    const { status } = store.get().connection;
    if (status === 'offline' || status === 'error') void connect();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const { status } = store.get().connection;
    if (status === 'offline') void connect();
  });

  void loadModels();
  // "On the start, create the session": prove key + route with one real round trip.
  if (apiKey) await connect();
}

async function loadModels(): Promise<void> {
  try {
    const models = await client.models();
    store.set((s) => ({ ...s, models }));
    if (!models.some((m) => m.id === store.get().settings.model)) updateSettings({ model: models[0]!.id });
  } catch {
    // keep the built-in list
  }
}

export function currentModel(): ModelInfo {
  const { models, settings } = store.get();
  return models.find((m) => m.id === settings.model) ?? models[0] ?? FALLBACK_MODELS[0]!;
}

function maxTokensFor(model: ModelInfo, settings: Settings): number {
  return Math.min(settings.lengthLimit, model.maxOutput ?? settings.lengthLimit);
}

/* ─────────────────────────── connection ─────────────────────────── */

function setConnection(patch: Partial<ConnectionState>): void {
  store.set((s) => ({ ...s, connection: { ...s.connection, ...patch } }));
}

/** The handshake. Resolves true when Inception accepted key, model and route. */
export async function connect(): Promise<boolean> {
  if (!apiKey) {
    setConnection({ status: 'no-key', message: undefined, detail: undefined });
    return false;
  }
  const run = ++connectRun;
  setConnection({ status: 'connecting', message: undefined, detail: undefined });
  try {
    const { latencyMs } = await client.verify(currentModel().id);
    if (run !== connectRun) return false;
    setConnection({ status: 'live', latencyMs, checkedAt: Date.now(), message: undefined, detail: undefined });
    if (pendingRetry && !streaming) {
      const { convId, messageId } = pendingRetry;
      pendingRetry = null;
      void retry(messageId, convId);
    }
    return true;
  } catch (error) {
    if (run !== connectRun) return false;
    applyFailure(toInceptionError(error));
    return false;
  }
}

/** What a failure means for the connection as a whole. */
function applyFailure(err: InceptionError): void {
  switch (err.kind) {
    case 'aborted':
      return;
    case 'no-key':
      setConnection({ status: 'no-key', message: undefined, detail: undefined });
      return;
    case 'auth':
      setConnection({ status: 'auth', message: err.message, detail: err.detail });
      return;
    case 'billing':
      setConnection({ status: 'billing', message: err.message, detail: err.detail });
      return;
    case 'network':
      setConnection({ status: 'offline', message: err.message, detail: err.detail });
      return;
    default:
      setConnection({ status: 'error', message: err.message, detail: err.detail });
  }
}

/** Save a key (this browser only) and run the handshake with it. */
export async function saveApiKey(raw: string, remember: boolean): Promise<boolean> {
  const key = storage.cleanKey(raw);
  if (!key) return false;
  apiKey = key;
  storage.saveKey(key, remember);
  setConnection({ keyHint: storage.maskKey(key), remember });
  setUi({ keyCheck: true });
  try {
    const ok = await connect();
    if (ok) setUi({ keyEditor: false });
    return ok;
  } finally {
    setUi({ keyCheck: false });
  }
}

export function forgetApiKey(): void {
  streaming?.controller.abort();
  storage.forgetKey();
  apiKey = null;
  connectRun++;
  pendingRetry = null;
  setConnection({ status: 'no-key', keyHint: null, message: undefined, detail: undefined, latencyMs: undefined, checkedAt: null });
  setUi({ keyEditor: false });
}

function onRetry(info: RetryInfo): void {
  if (!streaming) return;
  store.set((s) => ({ ...s, retry: { attempt: info.attempt, of: info.of, kind: info.kind, until: Date.now() + info.delayMs } }));
}

function clearRetry(): void {
  if (store.get().retry) store.set((s) => ({ ...s, retry: null }));
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
  store.set((s) => ({ ...s, active: null, ui: { ...s.ui, sidebarOpen: false } }));
}

export async function selectChat(id: string): Promise<void> {
  const conversation = cache.get(id) ?? (await storage.loadConversation(id));
  if (!conversation) return;
  cache.set(id, conversation);
  store.set((s) => ({ ...s, active: conversation, ui: { ...s.ui, sidebarOpen: false } }));
}

export async function deleteChat(id: string): Promise<void> {
  if (streaming?.convId === id) streaming.controller.abort();
  if (pendingRetry?.convId === id) pendingRetry = null;
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
  streaming?.controller.abort();
  pendingRetry = null;
  for (const timer of persistTimers.values()) clearTimeout(timer);
  persistTimers.clear();
  cache.clear();
  await storage.clearConversations().catch(() => {});
  store.set((s) => ({ ...s, list: [], active: null }));
}

/* ─────────────────────────── chatting ─────────────────────────── */

function freshAssistantFields(now: number): Partial<Message> {
  const { settings } = store.get();
  const model = currentModel();
  const meta: AssistantMeta = {
    model: model.id,
    effort: settings.effort,
    diffusing: settings.diffusing,
    maxTokens: maxTokensFor(model, settings),
    startedAt: now,
  };
  return { content: '', reasoningSummary: undefined, followUps: undefined, status: 'streaming', error: undefined, meta };
}

/** Finished turns before the given message, in the shape the client sends. */
function historyFor(messages: readonly Message[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    if (m.role === 'user') turns.push({ role: 'user', text: m.content });
    else if ((m.status === 'done' || m.status === 'stopped') && m.content.trim()) turns.push({ role: 'assistant', text: m.content });
  }
  return turns;
}

export async function send(text: string): Promise<void> {
  const value = text.trim();
  if (!value || streaming) return;
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
  const assistant = { id: createId(), role: 'assistant', createdAt: now, ...freshAssistantFields(now) } as Message;
  updateConversation(conversation.id, (c) => ({ ...c, updatedAt: now, messages: [...c.messages, user, assistant] }));
  persistNow(conversation.id);

  await streamAnswer(conversation.id, assistant.id);
}

/** Run (or re-run) an assistant message with the current settings. */
export async function retry(messageId: string, convId = store.get().active?.id): Promise<void> {
  if (!convId || streaming) return;
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
  const meta: AssistantMeta = { ...(conversation.messages[index]!.meta as AssistantMeta) };
  const controller = new AbortController();
  streaming = { convId, messageId, controller };
  if (pendingRetry?.messageId === messageId) pendingRetry = null;
  store.set((s) => ({ ...s, streamingId: messageId, retry: null }));

  let text = '';
  let pending = '';
  let canvas: string | null = null;
  let summary: string | undefined;
  let streamError: { message: string; code?: string } | null = null;
  let frame: ReturnType<typeof setTimeout> | null = null;

  // Paint at most every 40 ms: smooth, and cheap even at Mercury's speed.
  const flush = () => {
    if (frame) {
      clearTimeout(frame);
      frame = null;
    }
    if (meta.diffusing) {
      if (canvas === null || canvas === text) return;
      text = canvas;
    } else {
      if (!pending) return;
      text += pending;
      pending = '';
    }
    updateMessage(convId, messageId, { content: text, meta: { ...meta } });
  };
  const scheduleFlush = () => {
    frame ??= setTimeout(flush, STREAM_FRAME_MS);
  };
  const markFirst = (now: number) => {
    if (meta.firstTokenAt) return;
    meta.firstTokenAt = now;
    clearRetry();
    updateMessage(convId, messageId, { meta: { ...meta } });
  };

  try {
    for await (const event of client.chat({
      model: meta.model,
      turns,
      system: settings.system,
      effort: meta.effort,
      diffusing: meta.diffusing,
      maxTokens: meta.maxTokens ?? settings.lengthLimit,
      reasoningSummary: settings.reasoningSummary,
      signal: controller.signal,
    })) {
      const now = Date.now();
      switch (event.type) {
        case 'delta':
          markFirst(now);
          pending += event.text;
          scheduleFlush();
          break;
        case 'canvas':
          // An empty frame never wipes text that has already arrived.
          if (!event.text && canvas) break;
          markFirst(now);
          canvas = event.text;
          meta.steps = (meta.steps ?? 0) + 1;
          scheduleFlush();
          break;
        case 'reasoning-summary':
          if (event.summary.status === 'complete' && event.summary.content.trim()) summary = event.summary.content.trim();
          break;
        case 'usage':
          meta.usage = event.usage;
          break;
        case 'finish':
          meta.finishReason = event.reason;
          break;
        case 'warning':
          meta.warning = event.message;
          break;
        case 'error':
          streamError = { message: event.message, code: event.code };
          break;
        default:
          break;
      }
    }

    flush();
    meta.finishedAt = Date.now();
    const error = streamError
      ? { kind: 'stream' as const, message: streamError.message, code: streamError.code }
      : !text.trim()
        ? {
            kind: 'protocol' as const,
            message:
              meta.finishReason === 'length'
                ? 'Mercury used the whole length limit before writing anything — raise it in Settings.'
                : 'Mercury finished without writing an answer.',
          }
        : undefined;
    updateMessage(convId, messageId, { content: text, status: error ? 'error' : 'done', error, reasoningSummary: summary, meta: { ...meta } });
    if (store.get().connection.status !== 'live') {
      setConnection({ status: 'live', message: undefined, detail: undefined, checkedAt: Date.now() });
    }
    if (!error && settings.followUps) void loadFollowUps(convId, messageId, meta.model, [...turns, { role: 'assistant', text }]);
  } catch (error) {
    flush();
    const err = toInceptionError(error);
    meta.finishedAt = Date.now();
    if (err.kind === 'aborted') {
      updateMessage(convId, messageId, { status: 'stopped', reasoningSummary: summary, meta: { ...meta } });
    } else {
      updateMessage(convId, messageId, {
        status: 'error',
        reasoningSummary: summary,
        meta: { ...meta },
        error: { kind: err.kind, message: err.message, detail: err.detail, code: err.code },
      });
      if (err.kind === 'auth' || err.kind === 'billing' || err.kind === 'no-key') {
        pendingRetry = { convId, messageId };
        applyFailure(err);
      } else if (err.kind === 'network' && typeof navigator !== 'undefined' && navigator.onLine === false) {
        applyFailure(err);
      }
    }
  } finally {
    if (frame) clearTimeout(frame);
    if (streaming?.messageId === messageId) {
      streaming = null;
      store.set((s) => ({ ...s, streamingId: null, retry: null }));
    }
    persistNow(convId);
  }
}

async function loadFollowUps(convId: string, messageId: string, model: string, turns: ChatTurn[]): Promise<void> {
  const list = await client.followUps(model, turns);
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

/** Open the key form (e.g. to switch keys) and bring it into view. */
export function openKeyEditor(): void {
  setUi({ keyEditor: true, settingsOpen: false, sidebarOpen: false });
}
