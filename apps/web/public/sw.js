/* Crawl service worker: offline crawl data + map tiles, and Web Push. */
const VERSION = 'v2';
const SHELL = `shell-${VERSION}`;
const ASSETS = `assets-${VERSION}`;
const TILES = 'tiles-v1';
const API = 'api-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL);
      await shell.addAll(['/', '/manifest.webmanifest', '/icon.svg']);
      // Precache the hashed bundles the shell references so the very first visit works offline.
      const html = await (await shell.match('/')).text();
      const assets = [...new Set(html.match(/\/assets\/[^"'\s>]+/g) || [])];
      if (assets.length) await (await caches.open(ASSETS)).addAll(assets);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  const keep = new Set([SHELL, ASSETS, TILES, API]);
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.has(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Crawl data a member needs mid-crawl with no signal. Cached per URL; cleared on sign-out. */
const API_CACHEABLE = [
  /^\/v1\/crawls\/[0-9a-f-]{36}$/,
  /^\/v1\/crawls\/[0-9a-f-]{36}\/(live|messages|check-ins\/me|specials\/upcoming)$/,
  /^\/v1\/me\/crawls$/,
  /^\/v1\/me$/,
  /^\/v1\/neighborhoods$/,
  /^\/v1\/venues\/search$/,
  /^\/v1\/venue-images\//,
];

const isFont = (url) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
const isTile = (url) => /tiles\.openfreemap\.org$/.test(url.hostname) || url.pathname.endsWith('.pbf') || url.pathname.includes('/fonts/');

async function networkFirst(cacheName, request, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([fetch(request), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set('x-crawl-offline', '1');
      return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
    }
    throw err;
  }
}

async function cacheFirst(cacheName, request) {
  const cache = await caches.open(cacheName);
  // ignoreVary: script/style requests carry an Origin header the precached entries don't.
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(SHELL, new Request('/'), 4000).catch(() => caches.match('/')));
    return;
  }
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(ASSETS, req));
    return;
  }
  if (isTile(url)) {
    event.respondWith(cacheFirst(TILES, req));
    return;
  }
  if (isFont(url)) {
    event.respondWith(cacheFirst(ASSETS, req));
    return;
  }
  if (url.origin === self.location.origin && API_CACHEABLE.some((re) => re.test(url.pathname))) {
    event.respondWith(networkFirst(API, req, 6000));
  }
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'precache-tiles' && Array.isArray(msg.urls)) {
    event.waitUntil(
      (async () => {
        const cache = await caches.open(TILES);
        let done = 0;
        // Small batches: polite to the tile host and to a phone on bar Wi-Fi.
        for (let i = 0; i < msg.urls.length; i += 6) {
          await Promise.all(
            msg.urls.slice(i, i + 6).map(async (u) => {
              if (await cache.match(u)) return done++;
              try {
                const res = await fetch(u, { mode: 'cors' });
                if (res.ok) await cache.put(u, res);
                done++;
              } catch (_) {
                /* skip; fetched lazily later */
              }
            }),
          );
        }
        const clients = await self.clients.matchAll();
        clients.forEach((c) => c.postMessage({ type: 'tiles-ready', key: msg.key, done, total: msg.urls.length }));
      })(),
    );
  }
  if (msg.type === 'clear-user-data') event.waitUntil(caches.delete(API));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: 'Crawl', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Crawl', {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag,
      renotify: !!data.tag,
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = all.find((c) => c.url.startsWith(self.location.origin));
      if (existing) {
        await existing.focus();
        existing.postMessage({ type: 'navigate', url: target });
        return;
      }
      await self.clients.openWindow(target);
    })(),
  );
});
