import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MessageDTO, VisitedHistoryDTO } from '@crawl/core';
import { userId } from '../auth.js';
import { one, query } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { notificationDTO } from '../services/notify.js';
import { emitToCrawl } from '../services/realtime.js';
import { messageDTO, requireRole } from '../services/repo.js';

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
