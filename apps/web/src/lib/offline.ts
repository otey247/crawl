import { useEffect, useState } from 'react';
import type { CrawlDetailDTO } from '@crawl/core';
import { api } from './api';
import { onWorkerMessage, postToWorker } from './sw';

export function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const TILEJSON = import.meta.env.VITE_TILES_URL ?? 'https://tiles.openfreemap.org/planet';
const GLYPHS = import.meta.env.VITE_GLYPHS_URL ?? 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';

const lon2x = (lng: number, z: number) => Math.floor(((lng + 180) / 360) * 2 ** z);
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** Vector tiles (z10…source max) and label glyphs covering the crawl, padded ~500 m. */
export async function crawlTileUrls(crawl: CrawlDetailDTO): Promise<string[]> {
  if (!crawl.stops.length) return [];
  const tj = await fetch(TILEJSON).then((r) => r.json());
  const template: string = tj.tiles[0];
  const maxZ: number = Math.min(tj.maxzoom ?? 14, 15);
  const lats = crawl.stops.map((s) => s.venue.lat);
  const lngs = crawl.stops.map((s) => s.venue.lng);
  const pad = 0.005;
  const [s, n, w, e] = [Math.min(...lats) - pad, Math.max(...lats) + pad, Math.min(...lngs) - pad, Math.max(...lngs) + pad];
  const urls: string[] = [];
  for (let z = 10; z <= maxZ; z++) {
    for (let x = lon2x(w, z); x <= lon2x(e, z); x++)
      for (let y = lat2y(n, z); y <= lat2y(s, z); y++) urls.push(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
  }
  for (const font of ['Noto Sans Regular', 'Noto Sans Bold'])
    for (const range of ['0-255', '8192-8447']) urls.push(GLYPHS.replace('{fontstack}', encodeURIComponent(font)).replace('{range}', range));
  return urls;
}

export type OfflineStatus = 'idle' | 'saving' | 'ready' | 'unsupported';

/**
 * When a member opens a crawl that is live or happening today, cache what they need without
 * signal: itinerary, specials, chat, check-ins (via the service worker's API cache) and the map.
 */
export function useOfflineCrawl(crawl: CrawlDetailDTO | undefined) {
  const [status, setStatus] = useState<OfflineStatus>('serviceWorker' in navigator ? 'idle' : 'unsupported');
  const relevant =
    !!crawl &&
    crawl.permissions.isMember &&
    (crawl.status === 'live' || (crawl.status !== 'ended' && Math.abs(Date.parse(crawl.startAt) - Date.now()) < 24 * 3600_000));
  const key = crawl ? `${crawl.id}:${crawl.stops.map((s) => s.id).join(',')}` : '';

  useEffect(() => {
    if (!relevant || !crawl || status === 'unsupported') return;
    let cancelled = false;
    const off = onWorkerMessage((m) => m?.type === 'tiles-ready' && m.key === key && !cancelled && setStatus('ready'));
    setStatus('saving');
    (async () => {
      // Warm the API cache through the normal client so the worker stores the responses.
      await Promise.allSettled([api.live(crawl.id), api.messages(crawl.id), api.myCheckIns(crawl.id), api.upcomingSpecials(crawl.id), api.myCrawls()]);
      const urls = await crawlTileUrls(crawl).catch(() => []);
      if (!(await postToWorker({ type: 'precache-tiles', key, urls })) && !cancelled) setStatus('ready');
    })();
    return () => {
      cancelled = true;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relevant, key]);

  return relevant ? status : 'idle';
}
