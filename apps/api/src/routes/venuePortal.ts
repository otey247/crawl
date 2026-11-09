import type { FastifyInstance } from 'fastify';
import { randomInt } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { VenueClaimDTO, VenueInsightsDTO } from '@crawl/core';
import { userId } from '../auth.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { UUID_PARAM, sha256 } from '../lib/ids.js';
import { notify } from '../services/notify.js';
import { getVenue, userDTO } from '../services/repo.js';
import { storage } from '../services/storage.js';

/**
 * Venue portal. A bar's owner or manager claims its listing:
 *   - contact email on the venue's own website domain → 6-digit code by email → approved
 *   - anything else → reviewed by a Crawl admin
 * Claimed venues post verified specials (confidence 1.0), upload their own photo (replacing the
 * researched, permission-pending one), and see aggregate demand: how many crawls and people are
 * planning to stop by. No member names or personal data are exposed to venues.
 */

const uuid = z.string().uuid();
const domainOf = (s: string | null | undefined) => {
  if (!s) return null;
  try {
    return (s.includes('://') ? new URL(s).hostname : s.split('@').pop()!).toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
};

function claimDTO(r: any): VenueClaimDTO {
  return {
    id: r.id,
    venue: { id: r.venue_id, name: r.venue_name, address: r.venue_address },
    user: userDTO({ id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url }),
    contactEmail: r.contact_email,
    contactPhone: r.contact_phone,
    role: r.role,
    message: r.message,
    status: r.status,
    verification: r.verification,
    reviewNote: r.review_note,
    createdAt: r.created_at,
  };
}

const CLAIM_SELECT = `select c.*, coalesce(v.name_override, v.name) as venue_name, v.address as venue_address, u.display_name, u.avatar_url
  from venue_claims c join venues v on v.id = c.venue_id join users u on u.id = c.user_id`;

async function requireAdmin(uid: string) {
  const u = await one('select is_admin from users where id = $1', [uid]);
  if (!u?.is_admin) throw forbidden('Admins only');
}

async function requireOwner(venueId: string, uid: string) {
  const v = await one('select claimed_by from venues where id = $1', [venueId]);
  if (!v) throw notFound('Venue not found');
  if (v.claimed_by !== uid) {
    const admin = await one('select is_admin from users where id = $1', [uid]);
    if (!admin?.is_admin) throw forbidden('Only the venue’s verified manager can do that');
  }
}

async function approve(claimId: string, reviewer: string | null, note: string | null) {
  const claim = await tx(async (db) => {
    const c = (await db.query('select * from venue_claims where id = $1 for update', [claimId])).rows[0];
    if (!c) throw notFound('Claim not found');
    const v = (await db.query('select claimed_by from venues where id = $1 for update', [c.venue_id])).rows[0];
    if (v.claimed_by && v.claimed_by !== c.user_id) throw conflict('This venue is already managed by someone else');
    await db.query(`update venue_claims set status = 'approved', reviewed_by = $2, reviewed_at = now(), review_note = $3, code_hash = null where id = $1`, [claimId, reviewer, note]);
    await db.query('update venues set claimed_by = $2 where id = $1', [c.venue_id, c.user_id]);
    await db.query(`update venue_claims set status = 'rejected', review_note = 'Another manager was verified' where venue_id = $1 and id <> $2 and status = 'pending'`, [c.venue_id, claimId]);
    return c;
  });
  const v = await one('select coalesce(name_override, name) as name from venues where id = $1', [claim.venue_id]);
  await notify([claim.user_id], {
    kind: 'venue.claim',
    title: `You now manage ${v!.name}`,
    body: 'Post verified specials, update your photo and see who’s planning to stop by.',
    url: `/venues/${claim.venue_id}/manage`,
    push: true,
  });
}

export async function venuePortalRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- claims

  app.post('/venues/:id/claims', { preHandler: app.authenticate, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    const body = z
      .object({
        contactEmail: z.string().email().max(200),
        contactPhone: z.string().trim().max(30).nullish(),
        role: z.enum(['owner', 'general_manager', 'bar_manager', 'marketing']),
        message: z.string().trim().max(500).nullish(),
      })
      .parse(req.body);
    const venue = await one('select id, claimed_by, website, coalesce(name_override, name) as name from venues where id = $1', [id]);
    if (!venue) throw notFound('Venue not found');
    if (venue.claimed_by === uid) throw conflict('You already manage this venue');
    if (venue.claimed_by) throw conflict('This venue is already managed. Contact support if that’s wrong.');
    const site = domainOf(venue.website);
    const emailDomain = domainOf(body.contactEmail);
    const byEmail = !!site && site === emailDomain;
    const code = byEmail ? String(randomInt(0, 1_000_000)).padStart(6, '0') : null;
    const row = await one(
      `insert into venue_claims (venue_id, user_id, contact_email, contact_phone, role, message, verification, code_hash, code_expires_at, status, attempts)
       values ($1,$2,lower($3),$4,$5,$6,$7,$8, case when $8::text is null then null else now() + interval '30 minutes' end, 'pending', 0)
       on conflict (venue_id, user_id) do update set contact_email = excluded.contact_email, contact_phone = excluded.contact_phone, role = excluded.role,
         message = excluded.message, verification = excluded.verification, code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at,
         status = 'pending', attempts = 0, review_note = null
       returning id`,
      [id, uid, body.contactEmail, body.contactPhone ?? null, body.role, body.message ?? null, byEmail ? 'email_domain' : 'manual', code ? sha256(code) : null],
    );
    if (!byEmail) {
      const admins = await query<{ id: string }>('select id from users where is_admin');
      await notify(
        admins.map((a) => a.id),
        { kind: 'admin.claim', title: `Claim request: ${venue.name}`, body: `${req.user.name} (${body.role.replace('_', ' ')}) wants to manage this venue.`, url: '/admin/claims' },
      );
    } else {
      // Production: send `code` to contactEmail through the transactional mailer.
      req.log.info({ claim: row!.id }, 'venue claim code issued');
    }
    return {
      claimId: row!.id,
      verification: byEmail ? 'email_domain' : 'manual',
      ...(byEmail && !config.isProd ? { devCode: code } : {}),
      message: byEmail ? `We emailed a 6-digit code to ${body.contactEmail}.` : `${site ? `${emailDomain} doesn’t match ${site}, so a` : 'A'} Crawl admin will review your claim, usually within a day.`,
    };
  });

  app.post(`/venue-claims/:id${UUID_PARAM}::verify`, { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { code } = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const c = await one('select * from venue_claims where id = $1 and user_id = $2', [id, userId(req)]);
    if (!c || c.verification !== 'email_domain' || c.status !== 'pending') throw notFound('No code to verify');
    if (c.attempts >= 5 || !c.code_expires_at || Date.parse(c.code_expires_at) < Date.now()) throw badRequest('This code has expired. Start the claim again for a new one.', 'code_expired');
    await query('update venue_claims set attempts = attempts + 1 where id = $1', [id]);
    if (sha256(code) !== c.code_hash) throw badRequest('That code doesn’t match', 'code_mismatch');
    await approve(id, null, 'Verified by email on the venue’s domain');
    return { ok: true, venueId: c.venue_id };
  });

  app.get('/me/venue-claims', { preHandler: app.authenticate }, async (req) => {
    const rows = await query(`${CLAIM_SELECT} where c.user_id = $1 order by c.created_at desc`, [userId(req)]);
    return rows.map(claimDTO);
  });

  // ---------------------------------------------------------------- admin review

  app.get('/admin/venue-claims', { preHandler: app.authenticate }, async (req) => {
    await requireAdmin(userId(req));
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }).parse(req.query);
    const rows = await query(`${CLAIM_SELECT} where c.status = $1 and c.verification = 'manual' order by c.created_at`, [status]);
    return rows.map(claimDTO);
  });

  app.post(`/admin/venue-claims/:id${UUID_PARAM}::approve`, { preHandler: app.authenticate }, async (req) => {
    const uid = userId(req);
    await requireAdmin(uid);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { note } = z.object({ note: z.string().trim().max(300).nullish() }).parse(req.body ?? {});
    await approve(id, uid, note ?? null);
    return { ok: true };
  });

  app.post(`/admin/venue-claims/:id${UUID_PARAM}::reject`, { preHandler: app.authenticate }, async (req) => {
    const uid = userId(req);
    await requireAdmin(uid);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { note } = z.object({ note: z.string().trim().min(2).max(300) }).parse(req.body);
    const c = await one(`update venue_claims set status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 where id = $1 and status = 'pending' returning *`, [id, uid, note]);
    if (!c) throw notFound('Pending claim not found');
    await notify([c.user_id], { kind: 'venue.claim', title: 'Venue claim not approved', body: note, url: '/venues/manage' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- owner tools

  app.get('/me/venues', { preHandler: app.authenticate }, async (req) => {
    const rows = await query<{ id: string }>('select id from venues where claimed_by = $1 order by name', [userId(req)]);
    return Promise.all(rows.map((r) => getVenue(r.id)));
  });

  /** Aggregate demand only: crawl counts, group sizes and times. Never names or contact details. */
  app.get('/venues/:id/insights', { preHandler: app.authenticate }, async (req): Promise<VenueInsightsDTO> => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireOwner(id, userId(req));
    const upcoming = await query(
      `select c.id, c.start_at, c.timezone, c.visibility, s.planned_arrival_at,
         (select count(*)::int from memberships m where m.crawl_id = c.id and m.rsvp = 'going') as going
       from crawl_stops s join crawls c on c.id = s.crawl_id
       where s.venue_id = $1 and not s.skipped and c.status in ('planned', 'live') and c.start_at < now() + interval '14 days' and c.start_at > now() - interval '12 hours'
       order by coalesce(s.planned_arrival_at, c.start_at)`,
      [id],
    );
    const [ci, conf] = await Promise.all([
      one<{ n: number }>(`select count(*)::int as n from check_ins where venue_id = $1 and checked_in_at > now() - interval '30 days'`, [id]),
      one<{ n: number }>(`select coalesce(sum(confirmations), 0)::int as n from specials where venue_id = $1`, [id]),
    ]);
    return {
      upcoming: upcoming.map((u) => ({ crawlId: u.id, startAt: u.start_at, timezone: u.timezone, going: u.going, visibility: u.visibility, plannedArrival: u.planned_arrival_at })),
      next14Days: { crawls: upcoming.length, people: upcoming.reduce((n, u) => n + u.going, 0) },
      checkInsLast30Days: ci!.n,
      specialsConfirmations: conf!.n,
    };
  });

  app.post('/venues/:id/photo::upload-url', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireOwner(id, userId(req));
    const { contentType } = z.object({ contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']) }).parse(req.body);
    const key = `venues/${id}/upload-${Date.now()}`;
    return { key, uploadUrl: storage.presignPut(key, contentType) };
  });

  app.post('/venues/:id/photo::complete', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireOwner(id, userId(req));
    const { key } = z.object({ key: z.string().regex(/^venues\/[0-9a-f-]{36}\/upload-\d+$/) }).parse(req.body);
    if (!key.startsWith(`venues/${id}/`)) throw forbidden();
    const original = await storage.get(key).catch(() => null);
    if (!original) throw badRequest('Upload the photo first');
    const meta = await sharp(original).metadata();
    if (!meta.width || meta.width < 600) throw badRequest('Use a photo at least 600 px wide');
    const stamp = key.split('upload-')[1];
    // EXIF and GPS are dropped by re-encoding.
    await storage.put(`venues/${id}/${stamp}.jpg`, await sharp(original).rotate().resize({ width: 1600, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80, mozjpeg: true }).toBuffer());
    await storage.put(`venues/${id}/${stamp}-480.jpg`, await sharp(original).rotate().resize({ width: 640, height: 480, fit: 'cover', position: 'attention' }).jpeg({ quality: 78, mozjpeg: true }).toBuffer());
    await storage.remove(key);
    const v = await one('select coalesce(name_override, name) as name from venues where id = $1', [id]);
    await query('update venues set image_url = $2, image_credit = $3 where id = $1', [
      id,
      `/v1/venue-uploads/${id}/${stamp}.jpg`,
      JSON.stringify({ author: v!.name, license: 'Provided by the venue', sourcePage: null }),
    ]);
    return getVenue(id);
  });

  /** Venue-provided photos are public marketing images. */
  app.get('/venue-uploads/:venueId/:file', async (req, reply) => {
    const { venueId, file } = z.object({ venueId: uuid, file: z.string().regex(/^\d+(-480)?\.jpg$/) }).parse(req.params);
    const buf = await storage.get(`venues/${venueId}/${file}`).catch(() => null);
    if (!buf) throw notFound();
    reply.type('image/jpeg').header('cache-control', 'public, max-age=604800, immutable');
    return reply.send(buf);
  });
}
