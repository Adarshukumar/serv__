import type { ConversationMeta } from './types';

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 10_000) return `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

export function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function formatAgo(ts: number | null, now = Date.now()): string {
  if (ts === null) return '—';
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** 1234 → "1,234". */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Tokens per second, rounded sensibly: "86 tok/s", "1,240 tok/s". */
export function formatRate(tokens: number, ms: number): string {
  if (!(tokens > 0) || !(ms > 0)) return '';
  const rate = (tokens * 1000) / ms;
  return `${formatCount(rate >= 100 ? Math.round(rate / 10) * 10 : Math.round(rate))} tok/s`;
}

/** 16384 → "16K", 65536 → "64K", 4096 → "4K". */
export function formatTokenLimit(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n);
}

/** Context windows are quoted in thousands: 128000 → "128K", 260000 → "260K". */
export function formatContext(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);
}

/** 0.00000015 $/token → "$0.15 / M". */
export function formatPerMillion(perToken: number): string {
  const perMillion = perToken * 1_000_000;
  return `$${perMillion < 1 ? perMillion.toFixed(2) : perMillion.toFixed(perMillion < 10 ? 2 : 0)} / M`;
}

export interface ConversationGroup {
  label: string;
  items: ConversationMeta[];
}

/** Sidebar grouping: Today · Yesterday · Previous 7 days · by month. */
export function groupConversations(list: readonly ConversationMeta[], now = new Date()): ConversationGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 86_400_000;
  const groups = new Map<string, ConversationMeta[]>();
  for (const item of list) {
    let label: string;
    if (item.updatedAt >= startOfToday) label = 'Today';
    else if (item.updatedAt >= startOfToday - day) label = 'Yesterday';
    else if (item.updatedAt >= startOfToday - 7 * day) label = 'Previous 7 days';
    else label = new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const bucket = groups.get(label);
    if (bucket) bucket.push(item);
    else groups.set(label, [item]);
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }));
}
