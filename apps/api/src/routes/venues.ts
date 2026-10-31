import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NeighborhoodDTO } from '@crawl/core';
import { userId } from '../auth.js';
import { CITIES } from '../cities/index.js';
import { one, query } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { getVenue, requireRole, searchVenues, specialDTO, tzForNeighborhood } from '../services/repo.js';

const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const SpecialBody = z.object({
  title: z.string().trim().min(2).max(80),
  details: z.string().trim().max(280).nullish(),
  daysOfWeek: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  startTime: hm,
  endTime: hm,
  validFrom: z.string().date().nullish(),
  validTo: z.string().date().nullish(),
  crawlId: z.string().uuid().nullish(),
});

export async function venueRoutes(app: FastifyInstance) {
  app.get('/neighborhoods', async (): Promise<NeighborhoodDTO[]> => {
    const counts = await query<{ neighborhood_id: string; n: number }>('select neighborhood_id, count(*)::int as n from venues group by neighborhood_id');
    return CITIES.flatMap((c) =>
      c.neighborhoods.map((n) => ({
        id: n.id,
        cityId: c.id,
        name: n.name,
        cityName: c.name,
        timezone: c.timezone,
        center: n.center,
        zoom: n.zoom,
        venueCount: counts.find((x) => x.neighborhood_id === n.id)?.n ?? 0,
      })),
    );
  });

  app.get('/venues/search', { preHandler: app.optionalAuth }, async (req) => {
    const q = z
      .object({
        q: z.string().trim().max(80).optional(),
        neighborhood: z.string().optional(),
        bbox: z
          .string()
          .regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+$/)
          .optional(),
        near: z
          .string()
          .regex(/^-?[\d.]+,-?[\d.]+$/)
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
      })
      .parse(req.query);
    const near = q.near?.split(',').map(Number);
    return searchVenues({
      q: q.q,
      neighborhoodId: q.neighborhood,
      bbox: q.bbox?.split(',').map(Number) as [number, number, number, number] | undefined,
      near: near ? { lat: near[0], lng: near[1] } : undefined,
      limit: q.limit,
    });
  });

  app.get('/venues/:id', { preHandler: app.optionalAuth }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getVenue(id);
  });

  /** Organizer specials are scoped to a crawl (confidence 0.9); venue owners' are 1.0; everyone else's are crowd (0.5). */
  app.post('/venues/:id/specials', { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = SpecialBody.parse(req.body);
    const uid = userId(req);
    const venue = await one('select id, claimed_by, neighborhood_id from venues where id = $1', [id]);
    if (!venue) throw notFound('Venue not found');
    let source: 'venue' | 'organizer' | 'crowd' = 'crowd';
    let confidence = 0.5;
    if (venue.claimed_by === uid) [source, confidence] = ['venue', 1];
    else if (body.crawlId) {
      await requireRole(body.crawlId, uid, 'host');
      [source, confidence] = ['organizer', 0.9];
    }
    if (body.validFrom && body.validTo && body.validTo < body.validFrom) throw badRequest('End date is before start date');
    const row = await one(
      `insert into specials (venue_id, crawl_id, title, details, days_of_week, start_time, end_time, valid_from, valid_to, source, confidence, created_by, last_confirmed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now()) returning *`,
      [id, source === 'organizer' ? body.crawlId : null, body.title, body.details ?? null, body.daysOfWeek, body.startTime, body.endTime, body.validFrom ?? null, body.validTo ?? null, source, confidence, uid],
    );
    return specialDTO(row, tzForNeighborhood(venue.neighborhood_id));
  });

  app.patch('/specials/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = SpecialBody.partial().omit({ crawlId: true }).parse(req.body);
    const sp = await one('select s.*, v.claimed_by, v.neighborhood_id from specials s join venues v on v.id = s.venue_id where s.id = $1', [id]);
    if (!sp) throw notFound('Special not found');
    const uid = userId(req);
    if (sp.created_by !== uid && sp.claimed_by !== uid) throw forbidden('Only the creator or venue owner can edit this special');
    const row = await one(
      `update specials set title = coalesce($2, title), details = coalesce($3, details), days_of_week = coalesce($4, days_of_week),
         start_time = coalesce($5, start_time), end_time = coalesce($6, end_time), valid_from = coalesce($7, valid_from), valid_to = coalesce($8, valid_to),
         last_confirmed_at = now()
       where id = $1 returning *`,
      [id, body.title ?? null, body.details ?? null, body.daysOfWeek ?? null, body.startTime ?? null, body.endTime ?? null, body.validFrom ?? null, body.validTo ?? null],
    );
    return specialDTO(row, tzForNeighborhood(sp.neighborhood_id));
  });

  app.delete('/specials/:id', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const sp = await one('select s.created_by, v.claimed_by from specials s join venues v on v.id = s.venue_id where s.id = $1', [id]);
    if (!sp) throw notFound('Special not found');
    const uid = userId(req);
    if (sp.created_by !== uid && sp.claimed_by !== uid) throw forbidden();
    await query('delete from specials where id = $1', [id]);
    return { ok: true };
  });

  /** Crowd confirmation: raises confidence and resets the 30-day decay clock. */
  app.post('/specials/:id/confirm', { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await one(
      `update specials set confirmations = confirmations + 1, last_confirmed_at = now(),
         confidence = case when source = 'crowd' then least(0.95, confidence + 0.1) else confidence end
       where id = $1 returning *, (select neighborhood_id from venues where id = venue_id) as neighborhood_id`,
      [id],
    );
    if (!row) throw notFound('Special not found');
    return specialDTO(row, tzForNeighborhood(row.neighborhood_id));
  });
}
