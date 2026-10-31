/** Service worker registration and messaging. */
type Listener = (msg: any) => void;
const listeners = new Set<Listener>();

export function registerServiceWorker(onNavigate: (url: string) => void) {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('[sw] registration failed', err));
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'navigate') {
      const url = new URL(e.data.url);
      onNavigate(url.pathname + url.search);
    }
    listeners.forEach((l) => l(e.data));
  });
}

export function onWorkerMessage(l: Listener) {
  listeners.add(l);
  return () => void listeners.delete(l);
}

export async function postToWorker(msg: unknown) {
  if (!('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;
  reg.active?.postMessage(msg);
  return !!reg.active;
}
