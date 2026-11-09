import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TemplateDTO } from '@crawl/core';
import { maybeUserId, userId } from '../auth.js';
import { DEFAULT_NEIGHBORHOOD, findNeighborhood } from '../cities/index.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { UUID_PARAM } from '../lib/ids.js';
import { getCrawlRow, requireRole, specialsForVenues, tzForNeighborhood, userDTO, venueDTO } from '../services/repo.js';
import { eventsOverlapping } from '../services/events.js';
import { detail } from './crawls.js';
import { DateTime } from 'luxon';

/**
 * Crawl templates: curated routes ("Classic Soulard") and ones organizers save from their own
 * crawls. Forking one creates a new draft crawl with the same stops and stay lengths; closed
 * venues are dropped.
 */

const VENUE_COLS = `v.id, v.osm_id, coalesce(v.name_override, v.name) as name, v.lat, v.lng, v.address, v.category, v.price_level,
  v.tags, v.opening_hours, v.image_url, v.image_credit, v.status, v.status_note, v.neighborhood_id, (v.claimed_by is not null) as verified`;

async function toDTOs(rows: any[]): Promise<TemplateDTO[]> {
  const venueIds = [...new Set(rows.flatMap((r) => (r.stops as { venueId: string }[]).map((s) => s.venueId)))];
  const [venues, specials, users] = await Promise.all([
    venueIds.length ? query(`select ${VENUE_COLS} from venues v where v.id = any($1)`, [venueIds]) : Promise.resolve([]),
    specialsForVenues(venueIds, null),
    query('select id, display_name, avatar_url from users where id = any($1)', [rows.map((r) => r.created_by).filter(Boolean)]),
  ]);
  return rows.map((r) => {
    const tz = tzForNeighborhood(r.neighborhood_id);
    const stops = (r.stops as { venueId: string; dwellMin: number }[])
      .map((s) => ({ v: venues.find((x) => x.id === s.venueId), dwellMin: s.dwellMin }))
      .filter((s) => s.v && s.v.status === 'open')
      .map((s) => ({ venue: venueDTO(s.v, specials, tz), dwellMin: s.dwellMin }));
    const creator = users.find((u) => u.id === r.created_by);
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      description: r.description,
      neighborhoodId: r.neighborhood_id,
      curated: r.curated,
      visibility: r.visibility,
      createdBy: creator ? userDTO(creator) : null,
      tags: r.tags,
      uses: r.uses,
      stops,
      totalMin: stops.reduce((t, s) => t + s.dwellMin + 10, -10),
    };
  });
}

async function loadTemplate(id: string, viewer: string | null) {
  const r = await one('select * from templates where id::text = $1 or slug = $1', [id]);
  if (!r || (r.visibility === 'private' && r.created_by !== viewer)) throw notFound('Template not found');
  return r;
}

export async function templateRoutes(app: FastifyInstance) {
  /** Upcoming St. Louis events for a neighborhood (Explore banner). */
  app.get('/events', async (req) => {
    const q = z.object({ neighborhood: z.string().optional(), days: z.coerce.number().int().min(1).max(60).default(7) }).parse(req.query);
    return eventsOverlapping(q.neighborhood ?? null, Date.now(), Date.now() + q.days * 86_400_000);
  });

  /** Curated first, then the most-used public ones, plus the viewer's own private templates. */
  app.get('/templates', { preHandler: app.optionalAuth }, async (req) => {
    const { neighborhood } = z.object({ neighborhood: z.string().optional() }).parse(req.query);
    const viewer = maybeUserId(req);
    const rows = await query(
      `select * from templates where ($1::text is null or neighborhood_id = $1) and (visibility = 'public' or created_by = $2)
       order by curated desc, uses desc, created_at desc limit 30`,
      [neighborhood ?? null, viewer],
    );
    return toDTOs(rows);
  });

  app.get('/templates/:id', { preHandler: app.optionalAuth }, async (req) => {
    const { id } = z.object({ id: z.string().min(2).max(80) }).parse(req.params);
    const [dto] = await toDTOs([await loadTemplate(id, maybeUserId(req))]);
    return dto;
  });

  app.post(`/templates/:id${UUID_PARAM}::fork`, { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const uid = userId(req);
    const u = await one('select dob_verified_at from users where id = $1', [uid]);
    if (!u?.dob_verified_at) throw forbidden('Confirm you are 21 or older to create crawls');
    const t = await loadTemplate(id, uid);
    const body = z
      .object({
        title: z.string().trim().min(2).max(80).optional(),
        date: z.string().date(),
        startTime: z.string().regex(/^\d{2}:\d{2}$/),
        visibility: z.enum(['public', 'private']).default('private'),
      })
      .parse(req.body);
    const hood = findNeighborhood(t.neighborhood_id ?? DEFAULT_NEIGHBORHOOD)!;
    const startAt = DateTime.fromISO(`${body.date}T${body.startTime}`, { zone: hood.city.timezone });
    if (!startAt.isValid) throw badRequest('Invalid date or time');
    const open = await query<{ id: string }>(`select id from venues where id = any($1) and status = 'open'`, [t.stops.map((s: any) => s.venueId)]);
    const openIds = new Set(open.map((o) => o.id));
    const stops = (t.stops as { venueId: string; dwellMin: number }[]).filter((s) => openIds.has(s.venueId));
    if (stops.length < 2) throw badRequest('Too many of this template’s bars have closed to use it');
    const crawlId = await tx(async (db) => {
      const c = (
        await db.query(
          `insert into crawls (organizer_id, title, description, visibility, date, start_at, timezone, neighborhood_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
          [uid, body.title ?? t.title, t.description, body.visibility, body.date, startAt.toISO(), hood.city.timezone, hood.hood.id],
        )
      ).rows[0];
      await db.query(`insert into memberships (crawl_id, user_id, role, rsvp) values ($1, $2, 'organizer', 'going')`, [c.id, uid]);
      for (const [i, s] of stops.entries()) {
        await db.query('insert into crawl_stops (crawl_id, venue_id, position, dwell_min) values ($1,$2,$3,$4)', [c.id, s.venueId, i, s.dwellMin]);
      }
      await db.query('update templates set uses = uses + 1 where id = $1', [t.id]);
      return c.id as string;
    });
    return detail(crawlId, uid);
  });

  /** Save one of your crawls as a reusable template (public templates show up in Explore). */
  app.post('/crawls/:id/template', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'organizer');
    const body = z
      .object({ title: z.string().trim().min(2).max(80), description: z.string().trim().max(400).nullish(), visibility: z.enum(['public', 'private']).default('public'), tags: z.array(z.string().trim().min(2).max(24)).max(5).default([]) })
      .parse(req.body);
    const crawl = await getCrawlRow(id);
    const stops = await query<{ venue_id: string; dwell_min: number }>('select venue_id, dwell_min from crawl_stops where crawl_id = $1 and not skipped order by position', [id]);
    if (stops.length < 2) throw badRequest('Add at least two stops first');
    const row = await one(
      `insert into templates (title, description, neighborhood_id, created_by, source_crawl_id, visibility, stops, tags) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [body.title, body.description ?? null, crawl.neighborhood_id, uid, id, body.visibility, JSON.stringify(stops.map((s) => ({ venueId: s.venue_id, dwellMin: s.dwell_min }))), body.tags],
    );
    const [dto] = await toDTOs([row]);
    return dto;
  });

  app.delete(`/templates/:id${UUID_PARAM}`, { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const t = await one('select created_by, curated from templates where id = $1', [id]);
    if (!t) throw notFound('Template not found');
    if (t.curated || t.created_by !== userId(req)) throw forbidden();
    await query('delete from templates where id = $1', [id]);
    return { ok: true };
  });
}
