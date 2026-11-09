import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RideBoardDTO, RideOfferDTO, RideRequestDTO } from '@crawl/core';
import { userId } from '../auth.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { notify } from '../services/notify.js';
import { emitToCrawl } from '../services/realtime.js';
import { getCrawlRow, requireRole, userDTO } from '../services/repo.js';

/**
 * Ride board. Designated Drivers offer seats toward an area; anyone on the crawl asks for a ride
 * home (neighborhood, not an address) and gets matched to a driver with room. Only DDs can offer,
 * so nobody who's been drinking ends up "offering a lift".
 */

const uuid = z.string().uuid();
const area = z.string().trim().min(2).max(60);

async function board(crawlId: string, viewer: string): Promise<RideBoardDTO> {
  const [offers, requests, me] = await Promise.all([
    query(
      `select o.*, u.display_name, u.avatar_url from ride_offers o join users u on u.id = o.driver_id
       where o.crawl_id = $1 order by o.created_at`,
      [crawlId],
    ),
    query(
      `select r.*, u.display_name, u.avatar_url from ride_requests r join users u on u.id = r.user_id
       where r.crawl_id = $1 order by r.created_at`,
      [crawlId],
    ),
    one<{ crew_role: string | null }>('select crew_role from memberships where crawl_id = $1 and user_id = $2', [crawlId, viewer]),
  ]);
  const reqDTO = (r: any): RideRequestDTO => ({
    user: userDTO({ id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url }),
    destination: r.destination,
    partySize: r.party_size,
    offerId: r.offer_id,
    createdAt: r.created_at,
  });
  const offerDTOs: RideOfferDTO[] = offers.map((o) => {
    const riders = requests.filter((r) => r.offer_id === o.id);
    return {
      id: o.id,
      driver: userDTO({ id: o.driver_id, display_name: o.display_name, avatar_url: o.avatar_url }),
      seats: o.seats,
      seatsLeft: o.seats - riders.reduce((n, r) => n + r.party_size, 0),
      area: o.area,
      leavingNote: o.leaving_note,
      riders: riders.map((r) => ({ user: userDTO({ id: r.user_id, display_name: r.display_name, avatar_url: r.avatar_url }), destination: r.destination, partySize: r.party_size })),
    };
  });
  const mine = requests.find((r) => r.user_id === viewer);
  return {
    offers: offerDTOs,
    waiting: requests.filter((r) => !r.offer_id).map(reqDTO),
    mine: mine ? reqDTO(mine) : null,
    myOffer: offerDTOs.find((o) => o.driver.id === viewer) ?? null,
    canOffer: me?.crew_role === 'designated_driver',
  };
}

async function assertOpen(crawlId: string) {
  const crawl = await getCrawlRow(crawlId);
  if (crawl.status === 'ended' && crawl.ended_at && Date.now() - Date.parse(crawl.ended_at) > 12 * 3600_000) throw badRequest('The ride board has closed for this crawl');
  return crawl;
}

const changed = (crawlId: string) => emitToCrawl(crawlId, 'rides.updated', { crawlId });

export async function rideRoutes(app: FastifyInstance) {
  app.get('/crawls/:id/rides', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    return board(id, uid);
  });

  /** A Designated Driver offers (or updates) seats. */
  app.put('/crawls/:id/rides/offer', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    const m = await requireRole(id, uid, 'member');
    if (m.crew_role !== 'designated_driver') throw forbidden('Only Designated Drivers can offer rides');
    await assertOpen(id);
    const body = z.object({ seats: z.number().int().min(1).max(8), area, leavingNote: z.string().trim().max(80).nullish() }).parse(req.body);
    const taken = await one<{ n: number }>(
      `select coalesce(sum(r.party_size), 0)::int as n from ride_requests r join ride_offers o on o.id = r.offer_id where o.crawl_id = $1 and o.driver_id = $2`,
      [id, uid],
    );
    if (body.seats < taken!.n) throw conflict(`${taken!.n} seats are already taken`, 'seats_taken');
    const existing = await one('select id from ride_offers where crawl_id = $1 and driver_id = $2', [id, uid]);
    await query(
      `insert into ride_offers (crawl_id, driver_id, seats, area, leaving_note) values ($1,$2,$3,$4,$5)
       on conflict (crawl_id, driver_id) do update set seats = excluded.seats, area = excluded.area, leaving_note = excluded.leaving_note`,
      [id, uid, body.seats, body.area, body.leavingNote ?? null],
    );
    changed(id);
    if (!existing) {
      const waiting = await query<{ user_id: string }>('select user_id from ride_requests where crawl_id = $1 and offer_id is null', [id]);
      await notify(
        waiting.map((w) => w.user_id),
        { kind: 'rides.offer', title: `${req.user.name} is driving toward ${body.area}`, body: `${body.seats} seat${body.seats > 1 ? 's' : ''}. Grab one on the ride board.`, crawlId: id, url: `/crawls/${id}?tab=people`, push: true },
      );
    }
    return board(id, uid);
  });

  app.delete('/crawls/:id/rides/offer', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    const riders = await query<{ user_id: string }>(
      `select r.user_id from ride_requests r join ride_offers o on o.id = r.offer_id where o.crawl_id = $1 and o.driver_id = $2`,
      [id, uid],
    );
    await query('delete from ride_offers where crawl_id = $1 and driver_id = $2', [id, uid]);
    changed(id);
    await notify(riders.map((r) => r.user_id), {
      kind: 'rides.cancelled',
      title: 'Your ride fell through',
      body: `${req.user.name} can’t drive after all. You’re back on the ride board, or open Safety for cabs.`,
      crawlId: id,
      url: `/crawls/${id}?tab=people`,
      push: true,
    });
    return board(id, uid);
  });

  /** Ask for a ride home. Destination is a neighborhood or cross streets, never an address. */
  app.put('/crawls/:id/rides/request', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    await assertOpen(id);
    const body = z.object({ destination: area, partySize: z.number().int().min(1).max(4).default(1) }).parse(req.body);
    const before = await one('select offer_id, party_size from ride_requests where crawl_id = $1 and user_id = $2', [id, uid]);
    await query(
      `insert into ride_requests (crawl_id, user_id, destination, party_size) values ($1,$2,$3,$4)
       on conflict (crawl_id, user_id) do update set destination = excluded.destination, party_size = excluded.party_size,
         offer_id = case when excluded.party_size > ride_requests.party_size then null else ride_requests.offer_id end`,
      [id, uid, body.destination, body.partySize],
    );
    changed(id);
    if (!before) {
      const drivers = await query<{ user_id: string }>(`select user_id from memberships where crawl_id = $1 and crew_role = 'designated_driver' and user_id <> $2`, [id, uid]);
      await notify(
        drivers.map((d) => d.user_id),
        { kind: 'rides.request', title: `${req.user.name} needs a ride`, body: `To ${body.destination}${body.partySize > 1 ? ` · ${body.partySize} people` : ''}.`, crawlId: id, url: `/crawls/${id}?tab=people`, push: true },
      );
    }
    return board(id, uid);
  });

  app.delete('/crawls/:id/rides/request', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    await query('delete from ride_requests where crawl_id = $1 and user_id = $2', [id, uid]);
    changed(id);
    return board(id, uid);
  });

  /** Seat a rider in an offer: the rider themselves, the offer's driver, or a host. */
  app.post('/crawls/:id/rides/offers/:offerId/riders', { preHandler: app.authenticate }, async (req) => {
    const { id, offerId } = z.object({ id: uuid, offerId: uuid }).parse(req.params);
    const uid = userId(req);
    const m = await requireRole(id, uid, 'member');
    await assertOpen(id);
    const { userId: rider } = z.object({ userId: uuid }).parse(req.body);
    const result = await tx(async (db) => {
      const offer = (await db.query('select * from ride_offers where id = $1 and crawl_id = $2 for update', [offerId, id])).rows[0];
      if (!offer) throw notFound('Ride not found');
      if (rider !== uid && offer.driver_id !== uid && m.role === 'participant') throw forbidden();
      const request = (await db.query('select * from ride_requests where crawl_id = $1 and user_id = $2', [id, rider])).rows[0];
      if (!request) throw badRequest('Ask for a ride first so the driver knows where you’re headed');
      const used = (await db.query('select coalesce(sum(party_size), 0)::int as n from ride_requests where offer_id = $1 and user_id <> $2', [offerId, rider])).rows[0].n;
      if (used + request.party_size > offer.seats) throw conflict('Not enough seats left in that car', 'no_seats');
      await db.query('update ride_requests set offer_id = $3 where crawl_id = $1 and user_id = $2', [id, rider, offerId]);
      return { offer, request };
    });
    changed(id);
    const [driver, riderUser] = await Promise.all([
      one('select display_name from users where id = $1', [result.offer.driver_id]),
      one('select display_name from users where id = $1', [rider]),
    ]);
    await notify([rider].filter((u) => u !== uid), {
      kind: 'rides.matched',
      title: `${driver!.display_name} is driving you home`,
      body: `Toward ${result.offer.area}${result.offer.leaving_note ? ` · ${result.offer.leaving_note}` : ''}.`,
      crawlId: id,
      url: `/crawls/${id}?tab=people`,
      push: true,
    });
    await notify([result.offer.driver_id].filter((u) => u !== uid), {
      kind: 'rides.matched',
      title: `${riderUser!.display_name} is riding with you`,
      body: `To ${result.request.destination}${result.request.party_size > 1 ? ` · ${result.request.party_size} people` : ''}.`,
      crawlId: id,
      url: `/crawls/${id}?tab=people`,
      push: true,
    });
    return board(id, uid);
  });

  app.delete('/crawls/:id/rides/offers/:offerId/riders/:userId', { preHandler: app.authenticate }, async (req) => {
    const { id, offerId, userId: rider } = z.object({ id: uuid, offerId: uuid, userId: uuid }).parse(req.params);
    const uid = userId(req);
    const m = await requireRole(id, uid, 'member');
    const offer = await one('select driver_id from ride_offers where id = $1 and crawl_id = $2', [offerId, id]);
    if (!offer) throw notFound('Ride not found');
    if (rider !== uid && offer.driver_id !== uid && m.role === 'participant') throw forbidden();
    await query('update ride_requests set offer_id = null where crawl_id = $1 and user_id = $2 and offer_id = $3', [id, rider, offerId]);
    changed(id);
    return board(id, uid);
  });
}
