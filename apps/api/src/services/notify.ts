import type { NotificationDTO } from '@crawl/core';
import { query } from '../db/pool.js';
import { emitToUser } from './realtime.js';

export interface NotifyInput {
  kind: string;
  title: string;
  body: string;
  crawlId?: string | null;
  data?: Record<string, unknown>;
  /** Also deliver as a push notification to backgrounded devices. */
  push?: boolean;
}

export function notificationDTO(r: any): NotificationDTO {
  return { id: r.id, kind: r.kind, title: r.title, body: r.body, crawlId: r.crawl_id, data: r.data ?? {}, readAt: r.read_at, createdAt: r.created_at };
}

export async function notify(userIds: string[], n: NotifyInput): Promise<void> {
  if (!userIds.length) return;
  const rows = await query(
    `insert into notifications (user_id, crawl_id, kind, title, body, data)
     select u, $2, $3, $4, $5, $6 from unnest($1::uuid[]) u returning *`,
    [userIds, n.crawlId ?? null, n.kind, n.title, n.body, JSON.stringify(n.data ?? {})],
  );
  for (const r of rows) emitToUser(r.user_id, 'notification', notificationDTO(r));
  if (n.push) await sendPush(userIds, n).catch((err) => console.warn('[push]', err.message));
}

/** Expo push (FCM + APNs). Devices register tokens via PUT /v1/me/push-tokens. */
async function sendPush(userIds: string[], n: NotifyInput) {
  const rows = await query<{ push_tokens: string[] }>('select push_tokens from users where id = any($1)', [userIds]);
  const tokens = rows.flatMap((r) => r.push_tokens).filter((t) => t.startsWith('ExponentPushToken'));
  if (!tokens.length) return;
  await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tokens.map((to) => ({ to, title: n.title, body: n.body, data: { crawlId: n.crawlId, kind: n.kind, ...n.data } }))),
    signal: AbortSignal.timeout(5000),
  });
}

export async function crawlMemberIds(crawlId: string, opts: { hostsOnly?: boolean; excludeDeclined?: boolean } = {}): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `select user_id from memberships where crawl_id = $1 ${opts.hostsOnly ? "and role in ('organizer','co_host')" : ''} ${opts.excludeDeclined ? "and rsvp <> 'declined'" : ''}`,
    [crawlId],
  );
  return rows.map((r) => r.user_id);
}
