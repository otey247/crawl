import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, CrawlDetailDTO, ServerToClientEvents } from '@crawl/core';
import { tokenStore } from './api';

type CrawlSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
let socket: CrawlSocket | null = null;

export function getSocket(): CrawlSocket | null {
  const token = tokenStore.get();
  if (!token) return null;
  if (!socket) {
    socket = io(import.meta.env.VITE_API_URL ?? '', { path: '/socket.io', auth: { token }, transports: ['websocket', 'polling'] });
  }
  return socket;
}

export function resetSocket() {
  socket?.disconnect();
  socket = null;
}

/** Account-wide notifications (invites, alerts) → refresh the inbox badge. */
export function useNotificationStream(onNotify?: (title: string, body: string) => void) {
  const qc = useQueryClient();
  const cb = useRef(onNotify);
  cb.current = onNotify;
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const handler: ServerToClientEvents['notification'] = (n) => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      if (n.kind === 'invite') qc.invalidateQueries({ queryKey: ['my-invites'] });
      cb.current?.(n.title, n.body);
    };
    s.on('notification', handler);
    return () => {
      s.off('notification', handler);
    };
  }, [qc]);
}

/**
 * Joins `crawl:{id}` and keeps React Query caches in sync with server events.
 * Returns connection status.
 */
export function useCrawlChannel(crawlId: string | undefined, enabled: boolean) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const s = getSocket();
    if (!s || !crawlId || !enabled) return;
    const join = () => s.emit('crawl.join', crawlId, (res) => setConnected(res.ok));
    if (s.connected) join();
    s.on('connect', join);
    s.on('disconnect', () => setConnected(false));

    const crawlKey = ['crawl', crawlId];
    const refetchCrawl = () => qc.invalidateQueries({ queryKey: crawlKey });
    const patchLive = (live: CrawlDetailDTO['live']) => qc.setQueryData<CrawlDetailDTO>(crawlKey, (old) => (old ? { ...old, live } : old));

    const handlers: Partial<{ [K in keyof ServerToClientEvents]: ServerToClientEvents[K] }> = {
      'live.state': (p) => p.crawlId === crawlId && patchLive(p.live),
      'group.position': (p) =>
        qc.setQueryData<CrawlDetailDTO>(crawlKey, (old) =>
          old?.live ? { ...old, live: { ...old.live, position: { lat: p.lat, lng: p.lng, at: p.at } } } : old,
        ),
      'stop.arrived': refetchCrawl,
      'stop.departed': refetchCrawl,
      'route.approved': refetchCrawl,
      'route.proposed': refetchCrawl,
      'member.joined': refetchCrawl,
      'member.updated': refetchCrawl,
      'member.removed': refetchCrawl,
      'crawl.updated': refetchCrawl,
      'crawl.ended': refetchCrawl,
      'chat.message': (m) => {
        qc.setQueryData<{ items: any[]; hasMore: boolean }>(['messages', crawlId], (old) =>
          old ? (old.items.some((x) => x.id === m.id) ? old : { ...old, items: [...old.items, m] }) : old,
        );
      },
      'photo.added': (p) => {
        qc.setQueryData<{ pages: { items: any[]; nextCursor: string | null }[]; pageParams: unknown[] }>(['photos', crawlId], (old) => {
          if (!old) return old;
          if (old.pages.some((pg) => pg.items.some((x) => x.id === p.id))) return old;
          const [first, ...rest] = old.pages;
          return { ...old, pages: [{ ...first, items: [p, ...first.items] }, ...rest] };
        });
        refetchCrawl();
      },
      'photo.updated': (p) => {
        qc.setQueryData<{ pages: { items: any[]; nextCursor: string | null }[]; pageParams: unknown[] }>(['photos', crawlId], (old) =>
          old ? { ...old, pages: old.pages.map((pg) => ({ ...pg, items: pg.items.map((x) => (x.id === p.id ? p : x)) })) } : old,
        );
        qc.invalidateQueries({ queryKey: ['photo-picks', crawlId] });
      },
      'rides.updated': () => qc.invalidateQueries({ queryKey: ['rides', crawlId] }),
      'photo.removed': ({ photoId }) => {
        qc.setQueryData<{ pages: { items: any[]; nextCursor: string | null }[]; pageParams: unknown[] }>(['photos', crawlId], (old) =>
          old ? { ...old, pages: old.pages.map((pg) => ({ ...pg, items: pg.items.filter((x) => x.id !== photoId) })) } : old,
        );
      },
    };
    for (const [ev, h] of Object.entries(handlers)) s.on(ev as any, h as any);
    return () => {
      s.emit('crawl.leave', crawlId);
      s.off('connect', join);
      for (const [ev, h] of Object.entries(handlers)) s.off(ev as any, h as any);
    };
  }, [crawlId, enabled, qc]);
  return connected;
}
