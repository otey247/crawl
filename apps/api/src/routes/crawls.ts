import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { CREW_ROLES, type InviteDTO, type InvitePreviewDTO, type PreferenceTag } from '@crawl/core';
import { maybeUserId, userId } from '../auth.js';
import { DEFAULT_NEIGHBORHOOD, findNeighborhood } from '../cities/index.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { TOKEN_PARAM, UUID_PARAM, token128 } from '../lib/ids.js';
import { liveStateFor, syncLeader, systemMessage } from '../services/live.js';
import { notify } from '../services/notify.js';
import { approveRoute, createRouteJob, invalidateRoute } from '../services/optimizer.js';
import { enqueueRoute } from '../services/queue.js';
import { emitToCrawl, syncUserRooms } from '../services/realtime.js';
import {
  getCrawlRow,
  getMembership,
  loadCrawlDetail,
  loadMember,
  loadRoute,
  requireRole,
  summarize,
  type CrawlRow,
} from '../services/repo.js';

const uuid = z.string().uuid();
const Params = z.object({ id: uuid });

async function requireAdult(uid: string) {
  const u = await one('select dob_verified_at from users where id = $1', [uid]);
  if (!u?.dob_verified_at) throw forbidden('Confirm you are 21 or older to create or join crawls');
}

function startAtFor(date: string, time: string, tz: string): DateTime {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid) throw badRequest('Invalid date or time');
  return dt;
}

export const detail = (crawlId: string, viewer: string | null) => loadCrawlDetail(crawlId, viewer, liveStateFor);

export async function crawlRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- discovery & CRUD

  /** Public crawls, soonest first. `when` = tonight | week | all. */
  app.get('/crawls', { preHandler: app.optionalAuth }, async (req) => {
    const q = z
      .object({
        neighborhood: z.string().optional(),
        when: z.enum(['tonight', 'week', 'all']).default('all'),
        near: z.string().regex(/^-?[\d.]+,-?[\d.]+$/).optional(),
        date: z.string().date().optional(),
      })
      .parse(req.query);
    const params: unknown[] = [];
    const where = [`c.visibility = 'public'`, `c.status in ('planned','live','draft')`, `c.start_at > now() - interval '8 hours'`];
    if (q.neighborhood) {
      params.push(q.neighborhood);
      where.push(`c.neighborhood_id = $${params.length}`);
    }
    if (q.date) {
      params.push(q.date);
      where.push(`c.date = $${params.length}`);
    }
    // "Tonight" = anything starting within the next 24 hours (or already live).
    if (q.when === 'tonight') where.push(`c.start_at < now() + interval '24 hours'`);
    if (q.when === 'week') where.push(`c.start_at < now() + interval '7 days'`);
    // Drafts are only discoverable once they have stops.
    where.push(`(c.status <> 'draft' or exists (select 1 from crawl_stops s where s.crawl_id = c.id))`);
    const rows = await query<CrawlRow>(`select c.* from crawls c where ${where.join(' and ')} order by (c.status = 'live') desc, c.start_at limit 50`, params);
    return summarize(rows, maybeUserId(req));
  });

  app.get('/me/crawls', { preHandler: app.authenticate }, async (req) => {
    const rows = await query<CrawlRow>(
      `select c.* from crawls c join memberships m on m.crawl_id = c.id and m.user_id = $1
       order by case c.status when 'live' then 0 when 'planned' then 1 when 'draft' then 2 else 3 end, c.start_at`,
      [userId(req)],
    );
    return summarize(rows, userId(req));
  });

  app.post('/crawls', { preHandler: app.authenticate }, async (req) => {
    const uid = userId(req);
    await requireAdult(uid);
    const body = z
      .object({
        title: z.string().trim().min(2).max(80),
        description: z.string().trim().max(500).nullish(),
        visibility: z.enum(['public', 'private']).default('private'),
        date: z.string().date(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        neighborhoodId: z.string().default(DEFAULT_NEIGHBORHOOD),
      })
      .parse(req.body);
    const hood = findNeighborhood(body.neighborhoodId);
    if (!hood) throw badRequest('Unknown neighborhood');
    const startAt = startAtFor(body.date, body.startTime, hood.city.timezone);
    const crawl = await tx(async (db) => {
      const c = (
        await db.query(
          `insert into crawls (organizer_id, title, description, visibility, date, start_at, timezone, neighborhood_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
          [uid, body.title, body.description ?? null, body.visibility, body.date, startAt.toISO(), hood.city.timezone, hood.hood.id],
        )
      ).rows[0];
      await db.query(`insert into memberships (crawl_id, user_id, role, rsvp) values ($1, $2, 'organizer', 'going')`, [c.id, uid]);
      return c;
    });
    return detail(crawl.id, uid);
  });

  app.get('/crawls/:id', { preHandler: app.optionalAuth }, async (req) => {
    const { id } = Params.parse(req.params);
    return detail(id, maybeUserId(req));
  });

  app.patch('/crawls/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const body = z
      .object({
        title: z.string().trim().min(2).max(80).optional(),
        description: z.string().trim().max(500).nullish(),
        visibility: z.enum(['public', 'private']).optional(),
        date: z.string().date().optional(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      })
      .parse(req.body);
    const crawl = await getCrawlRow(id);
    if (crawl.status === 'ended') throw badRequest('This crawl has ended');
    let startAt: string | null = null;
    let date: string | null = null;
    if (body.date || body.startTime) {
      const cur = DateTime.fromISO(crawl.start_at, { zone: crawl.timezone });
      date = body.date ?? cur.toISODate()!;
      startAt = startAtFor(date, body.startTime ?? cur.toFormat('HH:mm'), crawl.timezone).toISO();
    }
    await query(
      `update crawls set title = coalesce($2, title), description = case when $3::boolean then $4 else description end,
         visibility = coalesce($5, visibility), date = coalesce($6, date), start_at = coalesce($7, start_at), updated_at = now() where id = $1`,
      [id, body.title ?? null, body.description !== undefined, body.description ?? null, body.visibility ?? null, date, startAt],
    );
    if (startAt) await invalidateRoute(id);
    emitToCrawl(id, 'crawl.updated', { crawlId: id });
    return detail(id, uid);
  });

  app.delete('/crawls/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    await requireRole(id, userId(req), 'organizer');
    await query('delete from crawls where id = $1', [id]);
    return { ok: true };
  });

  // ---------------------------------------------------------------- stops

  app.post('/crawls/:id/stops', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const body = z.object({ venueId: uuid, dwellMin: z.number().int().min(10).max(180).default(45) }).parse(req.body);
    const count = await one<{ n: number }>('select count(*)::int as n from crawl_stops where crawl_id = $1', [id]);
    if (count!.n >= 15) throw badRequest('A crawl can have at most 15 stops');
    const venue = await one('select status from venues where id = $1', [body.venueId]);
    if (!venue) throw notFound('Venue not found');
    if (venue.status !== 'open') throw badRequest('That bar has been reported closed', 'venue_closed');
    const exists = await one('select 1 from crawl_stops where crawl_id = $1 and venue_id = $2', [id, body.venueId]);
    if (exists) throw conflict('That bar is already on the crawl');
    await query(
      `insert into crawl_stops (crawl_id, venue_id, position, dwell_min) values ($1, $2, (select coalesce(max(position) + 1, 0) from crawl_stops where crawl_id = $1), $3)`,
      [id, body.venueId, body.dwellMin],
    );
    await invalidateRoute(id);
    emitToCrawl(id, 'crawl.updated', { crawlId: id });
    return detail(id, uid);
  });

  app.patch('/crawls/:id/stops/:stopId', { preHandler: app.authenticate }, async (req) => {
    const { id, stopId } = z.object({ id: uuid, stopId: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const body = z.object({ dwellMin: z.number().int().min(10).max(180).optional(), locked: z.boolean().optional() }).parse(req.body);
    const r = await one('update crawl_stops set dwell_min = coalesce($3, dwell_min), locked = coalesce($4, locked) where id = $1 and crawl_id = $2 returning id', [
      stopId,
      id,
      body.dwellMin ?? null,
      body.locked ?? null,
    ]);
    if (!r) throw notFound('Stop not found');
    if (body.dwellMin != null) await invalidateRoute(id);
    emitToCrawl(id, 'crawl.updated', { crawlId: id });
    return detail(id, uid);
  });

  app.delete('/crawls/:id/stops/:stopId', { preHandler: app.authenticate }, async (req) => {
    const { id, stopId } = z.object({ id: uuid, stopId: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    await tx(async (db) => {
      const del = await db.query('delete from crawl_stops where id = $1 and crawl_id = $2 returning position', [stopId, id]);
      if (!del.rowCount) throw notFound('Stop not found');
      await db.query('update crawl_stops set position = position - 1 where crawl_id = $1 and position > $2', [id, del.rows[0].position]);
    });
    await invalidateRoute(id);
    emitToCrawl(id, 'crawl.updated', { crawlId: id });
    return detail(id, uid);
  });

  /** Organizer's own order (before or instead of optimizing). */
  app.post('/crawls/:id/stops::reorder', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const { order } = z.object({ order: z.array(uuid).min(1) }).parse(req.body);
    const existing = await query('select id from crawl_stops where crawl_id = $1', [id]);
    if (order.length !== existing.length || !existing.every((s) => order.includes(s.id))) throw badRequest('Order must include every stop once');
    await tx(async (db) => {
      await db.query('update crawl_stops set position = position + 1000 where crawl_id = $1', [id]);
      for (let i = 0; i < order.length; i++) await db.query('update crawl_stops set position = $2 where id = $1', [order[i], i]);
    });
    await invalidateRoute(id);
    emitToCrawl(id, 'crawl.updated', { crawlId: id });
    return detail(id, uid);
  });

  // ---------------------------------------------------------------- route optimization

  const TAGS = ['fastest', 'quieter', 'scenic', 'specials', 'short_walks'] as const;

  app.post('/crawls/:id/routes::optimize', { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const body = z
      .object({ tags: z.array(z.enum(TAGS)).default(['fastest']), note: z.string().trim().max(500).nullish(), order: z.array(uuid).nullish() })
      .parse(req.body ?? {});
    const routeId = await createRouteJob(id, uid, { tags: body.tags as PreferenceTag[], note: body.note, order: body.order });
    await enqueueRoute(routeId);
    reply.code(202);
    return { routeId, status: 'pending' };
  });

  app.get('/crawls/:id/routes/:routeId', { preHandler: app.authenticate }, async (req) => {
    const { id, routeId } = z.object({ id: uuid, routeId: uuid }).parse(req.params);
    const m = await requireRole(id, userId(req), 'member');
    const route = await loadRoute(routeId);
    if (!route) throw notFound('Route not found');
    if (route.status !== 'approved' && m.role === 'participant') throw forbidden();
    return route;
  });

  app.post(`/crawls/:id${UUID_PARAM}/routes/:routeId${UUID_PARAM}::approve`, { preHandler: app.authenticate }, async (req) => {
    const { id, routeId } = z.object({ id: uuid, routeId: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'organizer');
    await approveRoute(id, routeId);
    return detail(id, uid);
  });

  // ---------------------------------------------------------------- invites & membership

  const inviteDTO = (r: any): InviteDTO => ({
    id: r.id,
    token: r.token,
    url: `${config.appUrl}/i/${r.token}`,
    maxUses: r.max_uses,
    uses: r.uses,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
  });

  app.get('/crawls/:id/invites', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    await requireRole(id, userId(req), 'host');
    return (await query('select * from invites where crawl_id = $1 order by created_at desc', [id])).map(inviteDTO);
  });

  app.post('/crawls/:id/invites', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const body = z.object({ maxUses: z.number().int().min(1).max(500).nullish(), expiresInHours: z.number().min(1).max(24 * 60).nullish() }).parse(req.body ?? {});
    const row = await one(
      `insert into invites (crawl_id, token, created_by, max_uses, expires_at) values ($1, $2, $3, $4, case when $5::float is null then null else now() + ($5::float * interval '1 hour') end) returning *`,
      [id, token128(), uid, body.maxUses ?? null, body.expiresInHours ?? null],
    );
    return inviteDTO(row);
  });

  app.delete('/crawls/:id/invites/:inviteId', { preHandler: app.authenticate }, async (req) => {
    const { id, inviteId } = z.object({ id: uuid, inviteId: uuid }).parse(req.params);
    await requireRole(id, userId(req), 'host');
    const row = await one('update invites set revoked_at = coalesce(revoked_at, now()) where id = $1 and crawl_id = $2 returning *', [inviteId, id]);
    if (!row) throw notFound('Invite not found');
    return inviteDTO(row);
  });

  /** Invite existing users directly; they see it in their Invites tab. */
  app.post('/crawls/:id/invite-users', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const { userIds } = z.object({ userIds: z.array(uuid).min(1).max(50) }).parse(req.body);
    const crawl = await getCrawlRow(id);
    const inserted = await query<{ user_id: string }>(
      `insert into invite_targets (crawl_id, user_id, invited_by)
       select $1, u, $2 from unnest($3::uuid[]) u where not exists (select 1 from memberships m where m.crawl_id = $1 and m.user_id = u)
       on conflict do nothing returning user_id`,
      [id, uid, userIds],
    );
    const inviter = await one('select display_name from users where id = $1', [uid]);
    const when = DateTime.fromISO(crawl.start_at, { zone: crawl.timezone }).toFormat("ccc, LLL d 'at' h:mm a");
    await notify(
      inserted.map((r) => r.user_id),
      { kind: 'invite', title: `${inviter!.display_name} invited you`, body: `${crawl.title} · ${when}`, crawlId: id, push: true },
    );
    return { invited: inserted.length };
  });

  app.get('/users/search', { preHandler: app.authenticate }, async (req) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(60) }).parse(req.query);
    const rows = await query(`select id, display_name, avatar_url from users where id <> $2 and (lower(display_name) like $1 or lower(email) = lower($3)) order by display_name limit 20`, [
      `%${q.toLowerCase()}%`,
      userId(req),
      q,
    ]);
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, avatarUrl: r.avatar_url }));
  });

  /** Public, read-only invite preview used by the web landing page. */
  app.get('/invites/:token', async (req): Promise<InvitePreviewDTO> => {
    const { token } = z.object({ token: z.string().min(10).max(64) }).parse(req.params);
    const inv = await one('select * from invites where token = $1', [token]);
    if (!inv) throw notFound('Invite not found');
    const crawl = await getCrawlRow(inv.crawl_id);
    const [s] = await summarize([crawl], null);
    let reason: string | null = null;
    if (inv.revoked_at) reason = 'This invite link was revoked.';
    else if (inv.expires_at && Date.parse(inv.expires_at) < Date.now()) reason = 'This invite link has expired.';
    else if (inv.max_uses != null && inv.uses >= inv.max_uses) reason = 'This invite link has been used up.';
    else if (crawl.status === 'ended') reason = 'This crawl has already ended.';
    return {
      crawl: { id: s.id, title: s.title, startAt: s.startAt, timezone: s.timezone, organizer: s.organizer, stopCount: s.stopCount, goingCount: s.goingCount, firstStop: s.firstStop, visibility: s.visibility },
      valid: !reason,
      reason,
    };
  });

  async function addMember(crawlId: string, uid: string, rsvp = 'going') {
    const inserted = await one(
      `insert into memberships (crawl_id, user_id, role, rsvp) values ($1, $2, 'participant', $3) on conflict do nothing returning user_id`,
      [crawlId, uid, rsvp],
    );
    await query('delete from invite_targets where crawl_id = $1 and user_id = $2', [crawlId, uid]);
    if (inserted) {
      const u = await one('select display_name from users where id = $1', [uid]);
      emitToCrawl(crawlId, 'member.joined', { userId: uid, displayName: u!.display_name });
      emitToCrawl(crawlId, 'member.updated', await loadMember(crawlId, uid));
      await systemMessage(crawlId, `${u!.display_name} joined the crawl.`);
    }
    return !!inserted;
  }

  app.post(`/invites/:token${TOKEN_PARAM}::accept`, { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const { token } = z.object({ token: z.string().min(10).max(64) }).parse(req.params);
    const uid = userId(req);
    await requireAdult(uid);
    const crawlId = await tx(async (db) => {
      const inv = (await db.query('select * from invites where token = $1 for update', [token])).rows[0];
      if (!inv || inv.revoked_at) throw notFound('This invite link is no longer valid');
      if (inv.expires_at && Date.parse(inv.expires_at) < Date.now()) throw badRequest('This invite link has expired', 'invite_expired');
      const already = await getMembership(inv.crawl_id, uid, db);
      if (already) return inv.crawl_id as string;
      if (inv.max_uses != null && inv.uses >= inv.max_uses) throw badRequest('This invite link has been used up', 'invite_used_up');
      await db.query('update invites set uses = uses + 1 where id = $1', [inv.id]);
      return inv.crawl_id as string;
    });
    const crawl = await getCrawlRow(crawlId);
    if (crawl.status === 'ended') throw badRequest('This crawl has already ended');
    await addMember(crawlId, uid);
    return detail(crawlId, uid);
  });

  app.post('/crawls/:id/join', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireAdult(uid);
    const crawl = await getCrawlRow(id);
    const invited = await one('select 1 from invite_targets where crawl_id = $1 and user_id = $2', [id, uid]);
    if (crawl.visibility !== 'public' && !invited) throw notFound('Crawl not found');
    if (crawl.status === 'ended') throw badRequest('This crawl has already ended');
    await addMember(id, uid);
    return detail(id, uid);
  });

  app.post('/crawls/:id/decline-invite', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    await query('delete from invite_targets where crawl_id = $1 and user_id = $2', [id, userId(req)]);
    return { ok: true };
  });

  app.post('/crawls/:id/leave', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    const m = await requireRole(id, uid, 'member');
    if (m.role === 'organizer') throw badRequest('The organizer cannot leave; delete the crawl instead');
    await query('delete from memberships where crawl_id = $1 and user_id = $2', [id, uid]);
    emitToCrawl(id, 'member.removed', { userId: uid });
    await syncUserRooms(uid, id, null);
    return { ok: true };
  });

  /** RSVP toggle (Going / Maybe / Can't make it) and location sharing. */
  app.patch('/crawls/:id/members/me', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    const body = z.object({ rsvp: z.enum(['going', 'maybe', 'declined']).optional(), locationSharing: z.boolean().optional() }).parse(req.body);
    const crawl = await getCrawlRow(id);
    if (body.locationSharing && crawl.status === 'ended') throw badRequest('This crawl has ended');
    await query('update memberships set rsvp = coalesce($3, rsvp), location_sharing = coalesce($4, location_sharing) where crawl_id = $1 and user_id = $2', [
      id,
      uid,
      body.rsvp ?? null,
      body.locationSharing ?? null,
    ]);
    const member = await loadMember(id, uid);
    emitToCrawl(id, 'member.updated', member);
    return member;
  });

  /** Organizer assigns permission roles and crew roles (Designated Driver, Navigator, Photographer). */
  app.patch('/crawls/:id/members/:userId', { preHandler: app.authenticate }, async (req) => {
    const { id, userId: target } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'organizer');
    const body = z
      .object({
        role: z.enum(['co_host', 'participant']).optional(),
        crewRole: z.enum(CREW_ROLES.map((r) => r.id) as [string, ...string[]]).nullable().optional(),
      })
      .parse(req.body);
    const m = await getMembership(id, target);
    if (!m) throw notFound('Member not found');
    if (m.role === 'organizer' && body.role) throw badRequest("The organizer's role can't be changed");
    // One Navigator (they lead the group's location) and one Photographer per crawl; any number of
    // Designated Drivers, since big groups need more than one car.
    if (body.crewRole && body.crewRole !== 'designated_driver') await query('update memberships set crew_role = null where crawl_id = $1 and crew_role = $2 and user_id <> $3', [id, body.crewRole, target]);
    await query(
      `update memberships set role = coalesce($3, role), crew_role = case when $4::boolean then $5 else crew_role end where crawl_id = $1 and user_id = $2`,
      [id, target, body.role ?? null, body.crewRole !== undefined, body.crewRole ?? null],
    );
    const member = await loadMember(id, target);
    emitToCrawl(id, 'member.updated', member);
    if (body.crewRole !== undefined) {
      // The badge's previous holder (if any) also changed, so clients refetch the roster.
      emitToCrawl(id, 'crawl.updated', { crawlId: id });
      if (body.crewRole) {
        const label = CREW_ROLES.find((r) => r.id === body.crewRole)!.label;
        await systemMessage(id, `${member.user.displayName} is the ${label}.`);
        await notify([target], { kind: 'role', title: `You're the ${label}`, body: (await getCrawlRow(id)).title, crawlId: id });
      }
    }
    if (body.role) await syncUserRooms(target, id, body.role);
    if (body.crewRole !== undefined) await syncLeader(id);
    return member;
  });

  app.delete('/crawls/:id/members/:userId', { preHandler: app.authenticate }, async (req) => {
    const { id, userId: target } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    await requireRole(id, userId(req), 'organizer');
    const m = await getMembership(id, target);
    if (!m) throw notFound('Member not found');
    if (m.role === 'organizer') throw badRequest("The organizer can't be removed");
    await query('delete from memberships where crawl_id = $1 and user_id = $2', [id, target]);
    emitToCrawl(id, 'member.removed', { userId: target });
    await syncUserRooms(target, id, null);
    return { ok: true };
  });

  app.get('/me/invites', { preHandler: app.authenticate }, async (req) => {
    const uid = userId(req);
    const rows = await query<CrawlRow & { invited_by_name: string; invited_at: string }>(
      `select c.*, u.display_name as invited_by_name, t.created_at as invited_at from invite_targets t
       join crawls c on c.id = t.crawl_id join users u on u.id = t.invited_by
       where t.user_id = $1 and c.status <> 'ended' order by t.created_at desc`,
      [uid],
    );
    const summaries = await summarize(rows, uid);
    return summaries.map((s, i) => ({ crawl: s, invitedBy: rows[i].invited_by_name, invitedAt: rows[i].invited_at }));
  });

}
