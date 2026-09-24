import {
  InceptionClient,
  SESSION_REFRESH_MS,
  SessionManager,
  SourceCollector,
  createId,
  toInceptionError,
  type ChatTurn,
  type InceptionError,
} from '../core';
import type { ProbeResult } from '../platform/bridgeProtocol';
import { BASE_HOST, BASE_URL, isExtensionPage } from '../platform/env';
import { runSecurityCheck } from '../platform/siteTab';
import {
  createBridgeTransport,
  createDirectTransport,
  createWebTransport,
  type Transport,
  type TransportMode,
} from '../platform/transport';
import * as storage from './storage';
import { createStore } from './store';
import type { AppState, AssistantMeta, ConnectionState, Conversation, Message, Settings } from './types';

/**
 * The app's brain: owns the transport, the session and the client, and runs the flow
 *
 *   start → create session → live ─┬─ every 10 min (while visible): refresh token
 *                                  ├─ send → stream real tokens → follow-ups
 *                                  ├─ checkpoint → let the browser pass it → retry
 *                                  └─ direct refused (auto) → site-tab bridge → retry
 *
 * React components only read the store and call these functions.
 */

const runtime: AppState['runtime'] = isExtensionPage() ? 'extension' : 'web';
const STREAM_FRAME_MS = 40;
const REFRESH_CHECK_MS = 60_000;

const initialSettings = storage.loadSettings();

export const store = createStore<AppState>({
  ready: false,
  runtime,
  settings: initialSettings,
  connection: {
    status: 'connecting',
    mode: initialMode(initialSettings),
    fetchedAt: null,
    issuedAt: null,
    refreshCount: 0,
  },
  list: [],
  active: null,
  streamingId: null,
  ui: { sidebarOpen: false, settingsOpen: false },
});

let transport: Transport = makeTransport(initialMode(initialSettings));

const session = new SessionManager({
  baseUrl: BASE_URL,
  fetch: (url, init) => transport.fetch(url, init),
});

const client = new InceptionClient({
  baseUrl: BASE_URL,
  session,
  getFetch: () => transport.fetch,
});

/** Conversations touched this session (active one, and any that is still streaming). */
const cache = new Map<string, Conversation>();
const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();

let streaming: { convId: string; messageId: string; controller: AbortController } | null = null;
let pendingRetry: { convId: string; messageId: string } | null = null;
let verifyController: AbortController | null = null;
let connectRun = 0;
let fellBack = false;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let initialised = false;

/* ────────────────────────────── setup ────────────────────────────── */

function initialMode(settings: Settings): TransportMode {
  if (runtime === 'web') return 'web';
  return settings.transport === 'bridge' ? 'bridge' : 'direct';
}

function makeTransport(mode: TransportMode): Transport {
  if (mode === 'direct') return createDirectTransport(BASE_URL);
  if (mode === 'bridge') return createBridgeTransport(BASE_URL);
  return createWebTransport();
}

export async function init(): Promise<void> {
  if (initialised) return;
  initialised = true;

  session.subscribe((s) =>
    setConnection({ fetchedAt: s.fetchedAt, issuedAt: s.issuedAt, refreshCount: s.refreshCount }),
  );

  const list = await storage.listConversations().catch(() => []);
  store.set((s) => ({ ...s, list, ready: true }));

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshIfStale();
  });
  window.addEventListener('online', () => {
    const { status } = store.get().connection;
    if (status === 'offline' || status === 'error') void connect();
  });

  // "On the start, create the session."
  await connect();
  scheduleRefreshCheck();
}

/* ─────────────────────────── connection ─────────────────────────── */

function setConnection(patch: Partial<ConnectionState>): void {
  store.set((s) => ({ ...s, connection: { ...s.connection, ...patch } }));
}

export async function connect(): Promise<boolean> {
  const run = ++connectRun;
  setConnection({
    status: 'connecting',
    mode: transport.mode,
    message: transport.mode === 'bridge' ? `Opening ${BASE_HOST} in a background tab…` : undefined,
    detail: undefined,
    progress: undefined,
  });
  try {
    await transport.prepare();
    await session.refresh();
    if (run !== connectRun) return false;
    setConnection({ status: 'live', message: undefined, detail: undefined, progress: undefined });
    return true;
  } catch (error) {
    if (run !== connectRun) return false;
    return handleFailure(toInceptionError(error), 'connect');
  }
}

/**
 * Decide what a failure means for the connection. Returns true when it recovered
 * (switched to the site-tab bridge and reconnected), so the caller may retry.
 */
async function handleFailure(err: InceptionError, context: 'connect' | 'chat'): Promise<boolean> {
  if (err.kind === 'aborted') return false;

  if (err.kind === 'challenge') {
    setConnection({ status: 'challenge', message: err.message, detail: undefined });
    return false;
  }

  if (transport.mode === 'web' && err.kind === 'network') {
    setConnection({
      status: 'blocked',
      message: `Ordinary web pages are not allowed to call ${BASE_HOST} (the browser’s CORS rules block it).`,
      detail: err.detail,
    });
    return false;
  }

  // While chatting, these belong to the message, not to the connection.
  if (context === 'chat' && (err.kind === 'rate-limit' || err.kind === 'http' || err.kind === 'stream' || err.kind === 'protocol')) {
    return false;
  }

  const online = typeof navigator === 'undefined' || navigator.onLine !== false;
  const refused = err.kind === 'auth' || (err.kind === 'http' && err.status === 403) || (err.kind === 'network' && online);
  if (transport.mode === 'direct' && store.get().settings.transport === 'auto' && refused && !fellBack) {
    fellBack = true;
    switchTransport('bridge');
    return connect();
  }

  if (err.kind === 'network') setConnection({ status: 'offline', message: err.message, detail: err.detail });
  else setConnection({ status: 'error', message: err.message, detail: err.detail });
  return false;
}

function switchTransport(mode: TransportMode): void {
  if (transport.mode === mode) return;
  transport.dispose();
  transport = makeTransport(mode);
  session.reset();
  setConnection({ mode });
}

function scheduleRefreshCheck(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    void refreshIfStale().finally(scheduleRefreshCheck);
  }, REFRESH_CHECK_MS);
}

/** Keep the token young while the page is in use (the web app refreshes every 13 min). */
async function refreshIfStale(): Promise<void> {
  if (store.get().connection.status !== 'live' || document.visibilityState !== 'visible') return;
  const age = session.tokenAge();
  if (age !== null && age < SESSION_REFRESH_MS) return;
  try {
    await session.refresh();
  } catch (error) {
    await handleFailure(toInceptionError(error), 'connect');
  }
}

/** Let the browser pass the site's security checkpoint, then reconnect (and retry). */
export async function verify(): Promise<void> {
  if (runtime !== 'extension') return;
  verifyController?.abort();
  const controller = new AbortController();
  verifyController = controller;
  setConnection({ status: 'verifying', progress: `Opening ${BASE_HOST}…`, message: undefined });
  try {
    await runSecurityCheck(BASE_URL, {
      signal: controller.signal,
      onProbe: (result, elapsed) => setConnection({ progress: describeProbe(result, elapsed) }),
    });
    const ok = await connect();
    if (ok && pendingRetry) {
      const { convId, messageId } = pendingRetry;
      pendingRetry = null;
      void retry(messageId, convId);
    }
  } catch (error) {
    const err = toInceptionError(error);
    setConnection({
      status: 'challenge',
      progress: undefined,
      message: err.kind === 'aborted' ? 'Security check cancelled — run it again whenever you are ready.' : err.message,
    });
  } finally {
    if (verifyController === controller) verifyController = null;
  }
}

export function cancelVerify(): void {
  verifyController?.abort();
}

function describeProbe(result: ProbeResult | null, elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  if (!result) return `Waiting for ${BASE_HOST} to load… ${seconds}s`;
  if (result.reason === 'checkpoint') return `Your browser is passing the security check… ${seconds}s`;
  if (result.reason.startsWith('session')) return `Nearly there — the site is still verifying this browser… ${seconds}s`;
  return `Checking the site (${result.reason})… ${seconds}s`;
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
    mode: transport.mode,
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
  for (const m of messages) {
    if (m.role === 'user') turns.push({ id: m.id, role: 'user', text: m.content });
    else if ((m.status === 'done' || m.status === 'stopped') && m.content.trim()) {
      turns.push({ id: m.id, role: 'assistant', text: m.content });
    }
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
  const assistant: Message = { id: createId(), role: 'assistant', createdAt: now, ...freshAssistantFields(now) } as Message;
  updateConversation(conversation.id, (c) => ({ ...c, updatedAt: now, messages: [...c.messages, user, assistant] }));
  persistNow(conversation.id);

  await streamAnswer(conversation.id, assistant.id);
}

/** Run (or re-run) an assistant message. */
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

async function streamAnswer(convId: string, messageId: string, allowRecovery = true): Promise<void> {
  const conversation = cache.get(convId);
  if (!conversation) return;
  const index = conversation.messages.findIndex((m) => m.id === messageId);
  if (index < 0) return;

  const turns = historyFor(conversation.messages.slice(0, index));
  const { settings } = store.get();
  const controller = new AbortController();
  streaming = { convId, messageId, controller };
  store.set((s) => ({ ...s, streamingId: messageId }));

  const meta: AssistantMeta = { ...(conversation.messages[index]!.meta as AssistantMeta), mode: transport.mode };
  const sources = new SourceCollector();
  let text = '';
  let reasoning = '';
  let pendingText = '';
  let pendingReasoning = '';
  let streamError: string | null = null;
  let frame: ReturnType<typeof setTimeout> | null = null;
  let recover = false;

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
    if (store.get().connection.status !== 'live') setConnection({ status: 'live', message: undefined, detail: undefined });
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
      recover = (await handleFailure(err, 'chat')) && allowRecovery;
    }
  } finally {
    if (streaming?.messageId === messageId) {
      streaming = null;
      store.set((s) => ({ ...s, streamingId: null }));
    }
    persistNow(convId);
  }

  if (recover) {
    updateMessage(convId, messageId, freshAssistantFields(Date.now()));
    await streamAnswer(convId, messageId, false);
  }
}

async function loadFollowUps(convId: string, messageId: string, turns: ChatTurn[]): Promise<void> {
  const list = await client.followUps(turns);
  if (list.length) updateMessage(convId, messageId, { followUps: list });
}

/* ─────────────────────────── settings & ui ─────────────────────────── */

export function updateSettings(patch: Partial<Settings>): void {
  const before = store.get().settings;
  const next = storage.sanitiseSettings({ ...before, ...patch });
  storage.saveSettings(next);
  store.set((s) => ({ ...s, settings: next }));

  if (runtime === 'extension' && next.transport !== before.transport) {
    fellBack = false;
    switchTransport(next.transport === 'bridge' ? 'bridge' : 'direct');
    void connect();
  }
}

export function setUi(patch: Partial<AppState['ui']>): void {
  store.set((s) => ({ ...s, ui: { ...s.ui, ...patch } }));
}

export function currentMode(): TransportMode {
  return transport.mode;
}
