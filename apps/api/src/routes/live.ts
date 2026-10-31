import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { haversineM } from '@crawl/core';
import { userId } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { UUID_PARAM } from '../lib/ids.js';
import {
  applyFix,
  endCrawl,
  handlePosition,
  liveStateFor,
  markArrived,
  markDeparted,
  setSimulation,
  setSkipped,
  startCrawl,
} from '../services/live.js';
import { emitToCrawl } from '../services/realtime.js';
import { getCrawlRow, loadMember, requireRole } from '../services/repo.js';
import { detail } from './crawls.js';

const uuid = z.string().uuid();
const Params = z.object({ id: uuid });
const StopParams = z.object({ id: uuid, stopId: uuid });

export async function liveRoutes(app: FastifyInstance) {
  app.post(`/crawls/:id${UUID_PARAM}::start`, { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    await startCrawl(id, uid);
    return detail(id, uid);
  });

  app.post(`/crawls/:id${UUID_PARAM}::end`, { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    await endCrawl(id);
    return detail(id, uid);
  });

  app.get('/crawls/:id/live', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const m = await requireRole(id, userId(req), 'member');
    return liveStateFor(id, m.role);
  });

  /** Evaluated specials per remaining stop. */
  app.get('/crawls/:id/specials/upcoming', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const m = await requireRole(id, userId(req), 'member');
    const live = await liveStateFor(id, m.role);
    const remaining = new Set(live.schedule.filter((s) => s.phase !== 'visited' && s.phase !== 'skipped').map((s) => s.stopId));
    return live.specials.filter((s) => remaining.has(s.stopId));
  });

  /** Leader position (HTTP fallback when the socket is down). */
  app.post('/crawls/:id/position', { preHandler: app.authenticate, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    const m = await requireRole(id, uid, 'member');
    const body = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().min(0).max(5000).optional() }).parse(req.body);
    const live = await one('select leader_user_id from live_state where crawl_id = $1', [id]);
    if (live?.leader_user_id !== uid && !m.location_sharing) throw forbidden('Turn on location sharing first');
    await handlePosition(id, uid, body);
    return { ok: true };
  });

  app.put('/crawls/:id/leader', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    await requireRole(id, userId(req), 'host');
    const { userId: leader } = z.object({ userId: uuid }).parse(req.body);
    await requireRole(id, leader, 'member');
    await query('update live_state set leader_user_id = $2 where crawl_id = $1', [id, leader]);
    emitToCrawl(id, 'crawl.updated', { crawlId: id });
    return { ok: true };
  });

  /** "We're here" — overrides the geofence. */
  app.post('/crawls/:id/stops/:stopId/arrive', { preHandler: app.authenticate }, async (req) => {
    const { id, stopId } = StopParams.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    await markArrived(id, stopId);
    return detail(id, uid);
  });

  app.post('/crawls/:id/depart', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    await markDeparted(id);
    return detail(id, uid);
  });

  app.post('/crawls/:id/stops/:stopId/skip', { preHandler: app.authenticate }, async (req) => {
    const { id, stopId } = StopParams.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const { skipped } = z.object({ skipped: z.boolean() }).parse(req.body);
    await setSkipped(id, stopId, skipped);
    return detail(id, uid);
  });

  app.post('/crawls/:id/fixes::apply', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const patch = z
      .discriminatedUnion('kind', [
        z.object({ kind: z.literal('cut_dwell'), stopId: uuid, dwellS: z.number().min(300).max(4 * 3600) }),
        z.object({ kind: z.literal('swap_forward'), order: z.array(uuid).min(1) }),
        z.object({ kind: z.literal('skip_stop'), stopId: uuid }),
      ])
      .parse((req.body as any)?.patch);
    await applyFix(id, patch, req.user.name);
    return detail(id, uid);
  });

  /** Dev/demo walk simulator for the leader. */
  app.post('/crawls/:id/simulate', { preHandler: app.authenticate }, async (req) => {
    if (config.isProd) throw forbidden('Simulation is disabled in production');
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'host');
    const { on, speed } = z.object({ on: z.boolean(), speed: z.number().min(1).max(60).default(6) }).parse(req.body);
    const crawl = await getCrawlRow(id);
    if (crawl.status !== 'live') throw badRequest('Start the crawl first');
    await setSimulation(id, on, speed);
    return { ok: true };
  });

  /** Individual check-in. Counts when the group has arrived there, or you are within 150 m. */
  app.post('/crawls/:id/stops/:stopId/check-in', { preHandler: app.authenticate }, async (req) => {
    const { id, stopId } = StopParams.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    const body = z.object({ lat: z.number().optional(), lng: z.number().optional() }).parse(req.body ?? {});
    const crawl = await getCrawlRow(id);
    if (crawl.status !== 'live') throw badRequest('Check-ins open when the crawl is live');
    const stop = await one('select s.*, v.lat, v.lng from crawl_stops s join venues v on v.id = s.venue_id where s.id = $1 and s.crawl_id = $2', [stopId, id]);
    if (!stop) throw notFound('Stop not found');
    const near = body.lat != null && body.lng != null && haversineM({ lat: body.lat, lng: body.lng }, stop) <= 150;
    if (!stop.arrived_at && !near) throw badRequest("You can check in once the group arrives or you're at the bar", 'not_here');
    const row = await one(
      `insert into check_ins (crawl_id, stop_id, venue_id, user_id) values ($1, $2, $3, $4) on conflict do nothing returning *`,
      [id, stopId, stop.venue_id, uid],
    );
    if (!row) throw conflict('Already checked in here');
    const member = await loadMember(id, uid);
    emitToCrawl(id, 'member.updated', member);
    return { ok: true, checkedInAt: row.checked_in_at };
  });

  app.get('/crawls/:id/check-ins/me', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    const rows = await query('select stop_id, checked_in_at from check_ins where crawl_id = $1 and user_id = $2', [id, uid]);
    return rows.map((r) => ({ stopId: r.stop_id, checkedInAt: r.checked_in_at }));
  });
}
