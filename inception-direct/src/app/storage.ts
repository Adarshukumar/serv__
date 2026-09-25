import { DEFAULT_THINKING, isThinkingMode } from '../site/config';
import type { Conversation, ConversationMeta, Settings } from './types';

/* ───────────────────────── settings (localStorage) ───────────────────────── */

const SETTINGS_KEY = 'inception-direct.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  thinking: DEFAULT_THINKING,
  webSearch: true,
  system: '',
  theme: 'system',
  readingSize: 19,
  readingFace: 'serif',
  dropCaps: true,
  followUps: true,
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitiseSettings(JSON.parse(raw) as Partial<Settings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // storage full / disabled — settings just won't persist
  }
}

export function sanitiseSettings(input: Partial<Settings>): Settings {
  const s = { ...DEFAULT_SETTINGS };
  if (isThinkingMode(input.thinking)) s.thinking = input.thinking;
  if (typeof input.webSearch === 'boolean') s.webSearch = input.webSearch;
  if (typeof input.system === 'string') s.system = input.system.slice(0, 4000);
  if (input.theme === 'paper' || input.theme === 'night' || input.theme === 'system') s.theme = input.theme;
  if (typeof input.readingSize === 'number' && Number.isFinite(input.readingSize)) {
    s.readingSize = Math.min(24, Math.max(15, Math.round(input.readingSize)));
  }
  if (input.readingFace === 'serif' || input.readingFace === 'sans') s.readingFace = input.readingFace;
  if (typeof input.dropCaps === 'boolean') s.dropCaps = input.dropCaps;
  if (typeof input.followUps === 'boolean') s.followUps = input.followUps;
  return s;
}

/* ───────────────────────── conversations (IndexedDB) ───────────────────────── */

const DB_NAME = 'inception-direct';
const DB_VERSION = 1;
const CONVERSATIONS = 'conversations';
const META = 'meta';

let dbPromise: Promise<IDBDatabase | null> | null = null;
/** In-memory fallback when IndexedDB is unavailable (some private modes). */
const memory = new Map<string, Conversation>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CONVERSATIONS)) db.createObjectStore(CONVERSATIONS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function toMeta(conversation: Conversation): ConversationMeta {
  const { id, title, createdAt, updatedAt } = conversation;
  return { id, title, createdAt, updatedAt };
}

export async function listConversations(): Promise<ConversationMeta[]> {
  const db = await openDb();
  const all = db
    ? await result(db.transaction(META, 'readonly').objectStore(META).getAll() as IDBRequest<ConversationMeta[]>)
    : [...memory.values()].map(toMeta);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadConversation(id: string): Promise<Conversation | null> {
  const db = await openDb();
  if (!db) return memory.get(id) ?? null;
  const found = await result(db.transaction(CONVERSATIONS, 'readonly').objectStore(CONVERSATIONS).get(id) as IDBRequest<Conversation | undefined>);
  return found ?? null;
}

export async function saveConversation(conversation: Conversation): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.set(conversation.id, structuredClone(conversation));
    return;
  }
  const tx = db.transaction([CONVERSATIONS, META], 'readwrite');
  tx.objectStore(CONVERSATIONS).put(conversation);
  tx.objectStore(META).put(toMeta(conversation));
  await done(tx);
}

export async function deleteConversation(id: string): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.delete(id);
    return;
  }
  const tx = db.transaction([CONVERSATIONS, META], 'readwrite');
  tx.objectStore(CONVERSATIONS).delete(id);
  tx.objectStore(META).delete(id);
  await done(tx);
}

export async function clearConversations(): Promise<void> {
  const db = await openDb();
  if (!db) {
    memory.clear();
    return;
  }
  const tx = db.transaction([CONVERSATIONS, META], 'readwrite');
  tx.objectStore(CONVERSATIONS).clear();
  tx.objectStore(META).clear();
  await done(tx);
}
