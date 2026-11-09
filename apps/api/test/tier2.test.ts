import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { one, pool, query } from '../src/db/pool.js';
import { endCrawl, handlePosition, markArrived, markDeparted, startCrawl } from '../src/services/live.js';
import { transport } from '../src/services/push.js';
import { closeQueues } from '../src/services/queue.js';

let app: Awaited<ReturnType<typeof buildApp>>;
const pushed: { endpoint: string; title: string }[] = [];
let org: string, dd: string, ann: string, ben: string, pho: string;
let crawlId: string;
let stops: { id: string }[];
const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, name: { [org]: 'Org', [dd]: 'Dee', [ann]: 'Ann', [ben]: 'Ben', [pho]: 'Pho' }[sub] ?? 'X' })}` });
const call = (method: string, url: string, sub: string, payload?: unknown) => app.inject({ method: method as any, url, headers: auth(sub), payload: payload as any });
const lastSystem = async () => (await one(`select body from messages where crawl_id = $1 and kind = 'system' order by created_at desc limit 1`, [crawlId]))!.body as string;

beforeAll(async () => {
  await migrate(() => {});
  await query('truncate users, venues, crawls, specials, routing_cache, notifications, push_subscriptions restart identity cascade');
  app = await buildApp({ logger: false });
  transport.send = async (sub: any, payload: string) => {
    pushed.push({ endpoint: sub.endpoint, title: JSON.parse(payload).title });
    return {} as any;
  };
  [org, dd, ann, ben, pho] = await Promise.all(
    ['Org', 'Dee', 'Ann', 'Ben', 'Pho'].map(async (n) => (await one(`insert into users (display_name, dob_verified_at) values ($1, now()) returning id`, [n]))!.id),
  );
  for (const u of [org, dd, ann, ben, pho]) await query(`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'p', 'a')`, [u, `https://push.example.com/${u}`]);
  const now = DateTime.now().setZone('America/Chicago');
  const v: string[] = [];
  for (let i = 0; i < 3; i++) v.push((await one(`insert into venues (osm_id, name, lat, lng) values ($1, $2, 38.607, $3) returning id`, [`way/${i + 10}`, `Bar ${i + 1}`, -90.21 + i * 0.002]))!.id);
  // A special live right now at Bar 1, so the recap has something caught.
  await query(`insert into specials (venue_id, title, start_time, end_time, source, confidence) values ($1, '$2 drafts', $2, $3, 'crowd', 0.6)`, [v[0], now.minus({ hours: 1 }).toFormat('HH:mm'), now.plus({ hours: 2 }).toFormat('HH:mm')]);
  crawlId = (await one(
    `insert into crawls (organizer_id, title, visibility, date, start_at, timezone, status) values ($1, 'Tier 2 crawl', 'private', current_date, now(), 'America/Chicago', 'planned') returning id`,
    [org],
  ))!.id;
  await query(
    `insert into memberships (crawl_id, user_id, role, rsvp, crew_role) values ($1,$2,'organizer','going',null), ($1,$3,'participant','going','designated_driver'),
       ($1,$4,'participant','going',null), ($1,$5,'participant','going',null), ($1,$6,'participant','going','photographer')`,
    [crawlId, org, dd, ann, ben, pho],
  );
  for (let i = 0; i < 3; i++) await query('insert into crawl_stops (crawl_id, venue_id, position, dwell_min) values ($1,$2,$3,30)', [crawlId, v[i], i]);
  stops = await query('select id from crawl_stops where crawl_id = $1 order by position', [crawlId]);
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await pool.end();
});

describe('ride board', () => {
  it('only Designated Drivers can offer seats', async () => {
    expect((await call('PUT', `/v1/crawls/${crawlId}/rides/offer`, ann, { seats: 3, area: 'Tower Grove' })).statusCode).toBe(403);
    const res = await call('PUT', `/v1/crawls/${crawlId}/rides/offer`, dd, { seats: 3, area: 'Tower Grove', leavingNote: 'After the last stop' });
    expect(res.statusCode).toBe(200);
    expect(res.json().myOffer).toMatchObject({ seats: 3, seatsLeft: 3 });
  });

  it('notifies drivers of requests, seats riders and enforces capacity', async () => {
    pushed.length = 0;
    const r = await call('PUT', `/v1/crawls/${crawlId}/rides/request`, ann, { destination: 'Tower Grove South', partySize: 2 });
    expect(r.json().waiting).toHaveLength(1);
    expect(pushed.find((p) => p.endpoint.endsWith(dd))?.title).toBe('Ann needs a ride');
    const offerId = r.json().offers[0].id;
    pushed.length = 0;
    const seated = await call('POST', `/v1/crawls/${crawlId}/rides/offers/${offerId}/riders`, ann, { userId: ann });
    expect(seated.json().offers[0]).toMatchObject({ seatsLeft: 1 });
    expect(seated.json().mine.offerId).toBe(offerId);
    expect(pushed.find((p) => p.endpoint.endsWith(dd))?.title).toBe('Ann is riding with you');

    await call('PUT', `/v1/crawls/${crawlId}/rides/request`, ben, { destination: 'Lafayette Sq', partySize: 2 });
    const full = await call('POST', `/v1/crawls/${crawlId}/rides/offers/${offerId}/riders`, dd, { userId: ben });
    expect(full.statusCode).toBe(409);
    expect(full.json().code).toBe('no_seats');
    // A stranger can't seat someone else.
    expect((await call('POST', `/v1/crawls/${crawlId}/rides/offers/${offerId}/riders`, pho, { userId: ben })).statusCode).toBe(403);
    // The driver can't shrink the car below what's already taken.
    expect((await call('PUT', `/v1/crawls/${crawlId}/rides/offer`, dd, { seats: 1, area: 'Tower Grove' })).statusCode).toBe(409);
  });

  it('puts riders back on the board when a driver cancels', async () => {
    pushed.length = 0;
    const res = await call('DELETE', `/v1/crawls/${crawlId}/rides/offer`, dd);
    expect(res.json().offers).toHaveLength(0);
    expect(res.json().waiting.map((w: any) => w.user.displayName).sort()).toEqual(['Ann', 'Ben']);
    expect(pushed.find((p) => p.endpoint.endsWith(ann))?.title).toBe('Your ride fell through');
  });
});

describe('catch up to the group', () => {
  it('announces, redirects when the group moves on, and confirms on arrival', async () => {
    await startCrawl(crawlId, org);
    await markArrived(crawlId, stops[0].id);
    const res = await call('POST', `/v1/crawls/${crawlId}/catch-up`, ben, { lat: 38.6, lng: -90.2 });
    expect(res.json()).toMatchObject({ stopId: stops[0].id, stopName: 'Bar 1' });
    expect(await lastSystem()).toMatch(/^Ben is on the way to Bar 1 \(about \d+ min\)\.$/);

    pushed.length = 0;
    await markDeparted(crawlId);
    expect((await one('select catching_up_stop_id from memberships where crawl_id = $1 and user_id = $2', [crawlId, ben]))!.catching_up_stop_id).toBe(stops[1].id);
    expect(pushed.find((p) => p.endpoint.endsWith(ben))?.title).toBe('The group moved on to Bar 2');

    // Ben shares his location and walks up to Bar 2.
    await query('update memberships set location_sharing = true where crawl_id = $1 and user_id = $2', [crawlId, ben]);
    const bar2 = (await one('select v.lat, v.lng from crawl_stops s join venues v on v.id = s.venue_id where s.id = $1', [stops[1].id]))!;
    await handlePosition(crawlId, ben, { lat: bar2.lat, lng: bar2.lng });
    expect(await lastSystem()).toBe('Ben caught up with the group at Bar 2.');
    expect((await one('select catching_up_since from memberships where crawl_id = $1 and user_id = $2', [crawlId, ben]))!.catching_up_since).toBeNull();
  });

  it('also clears on check-in', async () => {
    await call('POST', `/v1/crawls/${crawlId}/catch-up`, ann);
    await markArrived(crawlId, stops[1].id);
    expect((await call('POST', `/v1/crawls/${crawlId}/stops/${stops[1].id}/check-in`, ann, {})).statusCode).toBe(200);
    expect(await lastSystem()).toBe('Ann caught up with the group at Bar 2.');
  });
});

describe('photographer picks and recap', () => {
  let photos: string[];
  beforeAll(async () => {
    photos = [];
    for (const [uploader, stop] of [[ann, 0], [pho, 0], [ben, 1]] as const) {
      photos.push((await one(`insert into photos (crawl_id, uploader_id, stop_id, storage_key, status) values ($1,$2,$3,'k','ready') returning id`, [crawlId, uploader, stops[stop].id]))!.id);
    }
  });

  it('lets the Photographer (not participants) feature photos', async () => {
    expect((await call('POST', `/v1/crawls/${crawlId}/photos/${photos[2]}/feature`, ann, { featured: true })).statusCode).toBe(403);
    const res = await call('POST', `/v1/crawls/${crawlId}/photos/${photos[2]}/feature`, pho, { featured: true });
    expect(res.json()).toMatchObject({ featured: true, byPhotographer: false });
    const picks = (await call('GET', `/v1/crawls/${crawlId}/photos/picks`, ann)).json();
    expect(picks.map((p: any) => p.id)).toEqual([photos[2], photos[1]]);
  });

  it('builds a recap once the crawl ends, with a shareable card', async () => {
    expect((await call('GET', `/v1/crawls/${crawlId}/recap`, ann)).statusCode).toBe(409);
    await endCrawl(crawlId);
    const r = (await call('GET', `/v1/crawls/${crawlId}/recap`, ann)).json();
    expect(r.totals).toMatchObject({ stopsVisited: 2, specialsCaught: 1, checkIns: 1, photos: 3, going: 5 });
    expect(r.totals.distanceM).toBeGreaterThan(100);
    expect(r.stops.map((s: any) => s.name)).toEqual(['Bar 1', 'Bar 2']);
    expect(r.stops[0].specialsCaught).toEqual(['$2 drafts']);
    expect(r.stops[1].iCheckedIn).toBe(true);
    expect(r.skipped).toEqual(['Bar 3']);
    expect(r.photos.map((p: any) => p.id).slice(0, 2)).toEqual([photos[2], photos[1]]);
    expect(r.crew.map((c: any) => c.role).sort()).toEqual(['designated_driver', 'photographer']);
    const card = await call('GET', `/v1/crawls/${crawlId}/recap/card.png`, ann);
    expect(card.headers['content-type']).toBe('image/png');
    expect(card.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    const note = await one(`select data from notifications where user_id = $1 and kind = 'crawl.ended'`, [ann]);
    expect(note).toBeTruthy();
  });
});
