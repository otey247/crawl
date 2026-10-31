import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MessageDTO, VisitedHistoryDTO } from '@crawl/core';
import { userId } from '../auth.js';
import { one, query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { notificationDTO } from '../services/notify.js';
import { emitToCrawl } from '../services/realtime.js';
import { vapidPublicKey } from '../services/push.js';
import { markHomeSafe } from '../services/reminders.js';
import { getCrawlRow, loadMember, messageDTO, requireRole } from '../services/repo.js';

const uuid = z.string().uuid();

export async function postMessage(crawlId: string, uid: string, body: string): Promise<MessageDTO> {
  await requireRole(crawlId, uid, 'member');
  const text = body.trim();
  if (!text) throw badRequest('Message is empty');
  if (text.length > 1000) throw badRequest('Message is too long');
  const row = await one(
    `with m as (insert into messages (crawl_id, user_id, body) values ($1, $2, $3) returning *)
     select m.*, u.display_name, u.avatar_url from m join users u on u.id = m.user_id`,
    [crawlId, uid, text],
  );
  const msg = messageDTO(row);
  emitToCrawl(crawlId, 'chat.message', msg);
  return msg;
}

export async function socialRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- group chat

  app.get('/crawls/:id/messages', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireRole(id, userId(req), 'member');
    const q = z.object({ before: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const rows = await query(
      `select m.*, u.display_name, u.avatar_url from messages m left join users u on u.id = m.user_id
       where m.crawl_id = $1 and ($2::timestamptz is null or m.created_at < $2) order by m.created_at desc limit $3`,
      [id, q.before ?? null, q.limit],
    );
    return { items: rows.reverse().map(messageDTO), hasMore: rows.length === q.limit };
  });

  app.post('/crawls/:id/messages', { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { body } = z.object({ body: z.string() }).parse(req.body);
    return postMessage(id, userId(req), body);
  });

  // ---------------------------------------------------------------- web push

  app.get('/push/vapid-public-key', async () => ({ publicKey: vapidPublicKey() }));

  app.post('/me/push-subscriptions', { preHandler: app.authenticate }, async (req) => {
    const body = z
      .object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) })
      .parse(req.body);
    await query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) values ($1,$2,$3,$4,$5)
       on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      [userId(req), body.endpoint, body.keys.p256dh, body.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 300)],
    );
    return { ok: true };
  });

  app.delete('/me/push-subscriptions', { preHandler: app.authenticate }, async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
    await query('delete from push_subscriptions where user_id = $1 and endpoint = $2', [userId(req), endpoint]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- home safe

  app.post('/crawls/:id/home-safe', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    const crawl = await getCrawlRow(id);
    if (crawl.status !== 'ended' && crawl.status !== 'live') throw badRequest('The crawl hasn’t started yet');
    const at = await markHomeSafe(id, uid);
    const member = await loadMember(id, uid);
    emitToCrawl(id, 'member.updated', member);
    const msg = await one(`insert into messages (crawl_id, body, kind) values ($1, $2, 'system') returning *`, [id, `${member.user.displayName} got home safe.`]);
    emitToCrawl(id, 'chat.message', messageDTO(msg));
    return { ok: true, homeSafeAt: at };
  });

  // ---------------------------------------------------------------- notifications

  app.get('/me/notifications', { preHandler: app.authenticate }, async (req) => {
    const rows = await query('select * from notifications where user_id = $1 order by created_at desc limit 100', [userId(req)]);
    const unread = await one<{ n: number }>('select count(*)::int as n from notifications where user_id = $1 and read_at is null', [userId(req)]);
    return { items: rows.map(notificationDTO), unread: unread!.n };
  });

  app.post('/me/notifications/read', { preHandler: app.authenticate }, async (req) => {
    const { ids } = z.object({ ids: z.array(uuid).optional() }).parse(req.body ?? {});
    await query('update notifications set read_at = now() where user_id = $1 and read_at is null and ($2::uuid[] is null or id = any($2))', [userId(req), ids ?? null]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- visited history

  /** Venues the user checked into, grouped by crawl, shown once each crawl has ended. */
  app.get('/me/history', { preHandler: app.authenticate }, async (req): Promise<VisitedHistoryDTO> => {
    const rows = await query(
      `select c.id as crawl_id, c.title, c.start_at, c.ended_at, c.timezone, ci.stop_id, ci.venue_id, ci.checked_in_at,
         coalesce(v.name_override, v.name) as name, v.address, v.category
       from check_ins ci join crawls c on c.id = ci.crawl_id join venues v on v.id = ci.venue_id
       where ci.user_id = $1 and c.status = 'ended'
       order by c.ended_at desc nulls last, ci.checked_in_at`,
      [userId(req)],
    );
    const crawls = new Map<string, VisitedHistoryDTO['crawls'][number]>();
    for (const r of rows) {
      if (!crawls.has(r.crawl_id)) crawls.set(r.crawl_id, { crawl: { id: r.crawl_id, title: r.title, startAt: r.start_at, endedAt: r.ended_at, timezone: r.timezone }, venues: [] });
      crawls.get(r.crawl_id)!.venues.push({ stopId: r.stop_id, venueId: r.venue_id, name: r.name, address: r.address, category: r.category, checkedInAt: r.checked_in_at });
    }
    return { totalVenues: rows.length, uniqueVenues: new Set(rows.map((r) => r.venue_id)).size, crawls: [...crawls.values()] };
  });

}
