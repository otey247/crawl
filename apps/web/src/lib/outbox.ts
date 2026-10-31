import { useSyncExternalStore } from 'react';
import { ApiError, api } from './api';

/**
 * Writes made without signal (chat messages, check-ins) wait here and replay in order when the
 * connection returns. Persisted to localStorage so a reload doesn't lose them.
 */
export type OutboxItem =
  | { id: string; kind: 'chat'; crawlId: string; body: string; createdAt: string }
  | { id: string; kind: 'checkin'; crawlId: string; stopId: string; pos?: { lat: number; lng: number }; createdAt: string };

const KEY = 'crawl.outbox';
let items: OutboxItem[] = load();
const subs = new Set<() => void>();
let flushing = false;
const onFlushed = new Set<(item: OutboxItem) => void>();

function load(): OutboxItem[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable: queue stays in memory */
  }
  subs.forEach((s) => s());
}

export const isNetworkError = (err: unknown) => !navigator.onLine || err instanceof TypeError;

type NewItem = OutboxItem extends infer T ? (T extends OutboxItem ? Omit<T, 'id' | 'createdAt'> : never) : never;

export function enqueue(item: NewItem) {
  items = [...items, { ...item, id: crypto.randomUUID(), createdAt: new Date().toISOString() } as OutboxItem];
  save();
}

export async function flush() {
  if (flushing || !navigator.onLine || !items.length) return;
  flushing = true;
  try {
    while (items.length && navigator.onLine) {
      const item = items[0];
      try {
        if (item.kind === 'chat') await api.sendMessage(item.crawlId, item.body);
        else await api.checkIn(item.crawlId, item.stopId, item.pos);
      } catch (err) {
        if (isNetworkError(err)) break;
        // Server rejected it (e.g. already checked in): drop it rather than retry forever.
        if (!(err instanceof ApiError)) break;
      }
      items = items.slice(1);
      save();
      onFlushed.forEach((f) => f(item));
    }
  } finally {
    flushing = false;
  }
}

export function onOutboxFlushed(f: (item: OutboxItem) => void) {
  onFlushed.add(f);
  return () => void onFlushed.delete(f);
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flush());
  setTimeout(() => void flush(), 1000);
}

export function useOutbox(): OutboxItem[] {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => items,
  );
}
