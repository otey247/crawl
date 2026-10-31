import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';
import { config } from '../config.js';
import { query } from '../db/pool.js';

/**
 * Web Push (VAPID). Production sets VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY; development generates a
 * key pair once and keeps it in the storage directory so browser subscriptions survive restarts.
 */
function loadKeys(): { publicKey: string; privateKey: string } {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (config.isProd) throw new Error('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required in production');
  const file = join(config.storage.localDir, 'vapid.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const keys = webpush.generateVAPIDKeys();
  mkdirSync(config.storage.localDir, { recursive: true });
  writeFileSync(file, JSON.stringify(keys));
  return keys;
}

let keys: { publicKey: string; privateKey: string } | null = null;
function ensure() {
  if (!keys) {
    keys = loadKeys();
    webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? `mailto:support@${new URL(config.appUrl).hostname}`, keys.publicKey, keys.privateKey);
  }
  return keys;
}

export const vapidPublicKey = () => ensure().publicKey;

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/** Test seam: replaced in tests to capture deliveries without a push service. */
export const transport = {
  send: (sub: webpush.PushSubscription, payload: string) => webpush.sendNotification(sub, payload, { TTL: 3600, urgency: 'high' }),
};

export async function sendWebPush(userIds: string[], payload: PushPayload): Promise<number> {
  if (!userIds.length) return 0;
  ensure();
  const subs = await query('select * from push_subscriptions where user_id = any($1)', [userIds]);
  let delivered = 0;
  await Promise.all(
    subs.map(async (s) => {
      try {
        await transport.send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
        delivered++;
        await query('update push_subscriptions set last_success_at = now() where id = $1', [s.id]);
      } catch (err: any) {
        // 404/410: the browser dropped the subscription.
        if (err?.statusCode === 404 || err?.statusCode === 410) await query('delete from push_subscriptions where id = $1', [s.id]);
        else console.warn('[push]', err?.statusCode ?? '', err?.message);
      }
    }),
  );
  return delivered;
}
