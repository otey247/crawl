import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { one, pool, query } from '../src/db/pool.js';
import { evaluateLive, handlePosition, liveStateFor, markArrived, startCrawl } from '../src/services/live.js';
import { approveRoute, createRouteJob, runRouteJob } from '../src/services/optimizer.js';
import { closeQueues } from '../src/services/queue.js';

const TZ = 'America/Chicago';
const hm = (dt: DateTime) => dt.toFormat('HH:mm');
let app: Awaited<ReturnType<typeof buildApp>>;
let organizer: string;
let guest: string;
let crawlId: string;
let stops: { id: string; venue_id: string }[];
const token = (sub: string) => app.jwt.sign({ sub, name: 'Test' });

beforeAll(async () => {
  await migrate(() => {});
  await query('truncate users, venues, crawls, specials, routing_cache, notifications restart identity cascade');
  app = await buildApp({ logger: false });
  organizer = (await one(`insert into users (display_name, email, dob_verified_at) values ('Org', 'org@test', now()) returning id`))!.id;
  guest = (await one(`insert into users (display_name, email, dob_verified_at) values ('Guest', 'guest@test', now()) returning id`))!.id;

  // Three bars ~150 m apart on a line.
  const v = [];
  for (let i = 0; i < 3; i++) v.push((await one(`insert into venues (name, lat, lng, neighborhood_id) values ($1, 38.6070, $2, null) returning id`, [`Bar ${i + 1}`, -90.21 + i * 0.0018]))!.id);
  const now = DateTime.now().setZone(TZ);
  // Bar 2: live for the next 3 h (should highlight as the next stop).
  await query(`insert into specials (venue_id, title, start_time, end_time, source, confidence) values ($1, 'Long happy hour', $2, $3, 'crowd', 0.6)`, [v[1], hm(now.minus({ hours: 1 })), hm(now.plus({ hours: 3 }))]);
  // Bar 3: ends in 40 min, but the group won't get there for ~85 min (projected miss).
  await query(`insert into specials (venue_id, title, start_time, end_time, source, confidence) values ($1, 'Short happy hour', $2, $3, 'crowd', 0.6)`, [v[2], hm(now.minus({ hours: 1 })), hm(now.plus({ minutes: 40 }))]);
  // Low-confidence special is hidden everywhere.
  await query(`insert into specials (venue_id, title, start_time, end_time, source, confidence) values ($1, 'Rumor', '00:00', '23:59', 'crowd', 0.2)`, [v[0]]);

  crawlId = (await one(
    `insert into crawls (organizer_id, title, visibility, date, start_at, timezone, status) values ($1, 'Test crawl', 'private', $2, $3, $4, 'draft') returning id`,
    [organizer, now.toISODate(), now.toISO(), TZ],
  ))!.id;
  await query(`insert into memberships (crawl_id, user_id, role) values ($1, $2, 'organizer'), ($1, $3, 'participant')`, [crawlId, organizer, guest]);
  for (let i = 0; i < 3; i++) await query('insert into crawl_stops (crawl_id, venue_id, position, dwell_min) values ($1, $2, $3, 40)', [crawlId, v[i], i]);
  stops = await query('select id, venue_id from crawl_stops where crawl_id = $1 order by position', [crawlId]);
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await pool.end();
});

describe('route optimization', () => {
  it('proposes, explains and approves a route', async () => {
    const routeId = await createRouteJob(crawlId, organizer, { tags: ['specials'] });
    await runRouteJob(routeId);
    const r = await one('select * from routes where id = $1', [routeId]);
    expect(r.status).toBe('proposed');
    expect(r.stop_order).toHaveLength(3);
    expect(r.explanation).toMatch(/stops/);
    expect(r.metrics.baseline.order).toHaveLength(3);
    await approveRoute(crawlId, routeId);
    const crawl = await one('select status, approved_route_id from crawls where id = $1', [crawlId]);
    expect(crawl).toMatchObject({ status: 'planned', approved_route_id: routeId });
  });

  it('rejects approval from a participant', async () => {
    const res = await app.inject({ method: 'POST', url: `/v1/crawls/${crawlId}/routes:optimize`, headers: { authorization: `Bearer ${token(guest)}` }, payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe('live specials engine', () => {
  it('classifies, alerts once after two stable evaluations, and suggests fixes', async () => {
    // Force the organizer's order so the short special is last.
    await query('update crawl_stops set position = position + 10 where crawl_id = $1', [crawlId]);
    for (const [i, s] of stops.entries()) await query('update crawl_stops set position = $2 where id = $1', [s.id, i]);
    await startCrawl(crawlId, organizer);
    await markArrived(crawlId, stops[0].id);

    const live = await liveStateFor(crawlId, 'organizer');
    const byTitle = (t: string) => live.specials.find((s) => s.title === t)!;
    expect(byTitle('Long happy hour').state).toBe('highlight');
    expect(byTitle('Short happy hour').state).toBe('projected_miss');
    expect(live.specials.find((s) => s.title === 'Rumor')).toBeUndefined();
    expect(live.atRisk[0].fixes.length).toBeGreaterThan(0);

    // markArrived + startCrawl each evaluated once; one more evaluation crosses the threshold.
    await evaluateLive(crawlId);
    await evaluateLive(crawlId);
    const alerts = await query('select kind from special_alerts where crawl_id = $1 order by kind', [crawlId]);
    expect(alerts.map((a) => a.kind)).toEqual(['highlight', 'missed']);
    const notes = await query(`select kind from notifications where user_id = $1 and kind like 'special.%'`, [guest]);
    expect(notes.map((n) => n.kind).sort()).toEqual(['special.highlight', 'special.missed']);

    // Participants never see the organizer's fix options.
    const guestView = await liveStateFor(crawlId, 'participant');
    expect(guestView.atRisk).toEqual([]);
  });

  it('applies a one-tap fix', async () => {
    const live = await liveStateFor(crawlId, 'organizer');
    const fix = live.atRisk[0].fixes[0];
    const res = await app.inject({ method: 'POST', url: `/v1/crawls/${crawlId}/fixes:apply`, headers: { authorization: `Bearer ${token(organizer)}` }, payload: { patch: fix.patch } });
    expect(res.statusCode).toBe(200);
    const etaOf = (l: typeof live) => Date.parse(l.specials.find((s) => s.title === 'Short happy hour')!.eta!);
    const after = await liveStateFor(crawlId, 'organizer');
    // The fix moves the at-risk stop earlier by (about) what it promised.
    expect((etaOf(live) - etaOf(after)) / 60_000).toBeCloseTo(fix.minutesSaved, 0);
    const short = after.specials.find((s) => s.title === 'Short happy hour')!;
    if (fix.catchesSpecial) expect(['highlight', 'on_track']).toContain(short.state);
  });

  it('detects arrival from the leader position after the 2-minute hold', async () => {
    await query(`update crawl_stops set departed_at = now() where id = $1`, [stops[0].id]);
    await query(`update live_state set current_stop_id = null where crawl_id = $1`, [crawlId]);
    const next = await one(`select s.id, v.lat, v.lng from crawl_stops s join venues v on v.id = s.venue_id where s.crawl_id = $1 and s.arrived_at is null and not s.skipped order by s.position limit 1`, [crawlId]);
    const t0 = new Date();
    await handlePosition(crawlId, organizer, { lat: next.lat, lng: next.lng }, t0);
    expect((await one('select arrived_at from crawl_stops where id = $1', [next.id])).arrived_at).toBeNull();
    await handlePosition(crawlId, organizer, { lat: next.lat + 0.0001, lng: next.lng }, new Date(t0.getTime() + 125_000));
    expect((await one('select arrived_at from crawl_stops where id = $1', [next.id])).arrived_at).not.toBeNull();
  });
});

describe('members, check-ins and history', () => {
  it('toggles RSVP and assigns crew roles (organizer only)', async () => {
    const auth = { authorization: `Bearer ${token(guest)}` };
    const rsvp = await app.inject({ method: 'PATCH', url: `/v1/crawls/${crawlId}/members/me`, headers: auth, payload: { rsvp: 'maybe' } });
    expect(rsvp.json().rsvp).toBe('maybe');
    const denied = await app.inject({ method: 'PATCH', url: `/v1/crawls/${crawlId}/members/${organizer}`, headers: auth, payload: { crewRole: 'navigator' } });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({ method: 'PATCH', url: `/v1/crawls/${crawlId}/members/${guest}`, headers: { authorization: `Bearer ${token(organizer)}` }, payload: { crewRole: 'designated_driver' } });
    expect(ok.json().crewRole).toBe('designated_driver');
  });

  it('saves check-ins to Visited History only after the crawl ends', async () => {
    const auth = { authorization: `Bearer ${token(guest)}` };
    const ci = await app.inject({ method: 'POST', url: `/v1/crawls/${crawlId}/stops/${stops[0].id}/check-in`, headers: auth, payload: {} });
    expect(ci.statusCode).toBe(200);
    const dup = await app.inject({ method: 'POST', url: `/v1/crawls/${crawlId}/stops/${stops[0].id}/check-in`, headers: auth, payload: {} });
    expect(dup.statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/v1/me/history', headers: auth })).json().totalVenues).toBe(0);
    await app.inject({ method: 'POST', url: `/v1/crawls/${crawlId}:end`, headers: { authorization: `Bearer ${token(organizer)}` } });
    const h = (await app.inject({ method: 'GET', url: '/v1/me/history', headers: auth })).json();
    expect(h.totalVenues).toBe(1);
    expect(h.crawls[0].venues[0].name).toBe('Bar 1');
  });

  it('keeps private crawls invisible to outsiders', async () => {
    const outsider = (await one(`insert into users (display_name, dob_verified_at) values ('Out', now()) returning id`))!.id;
    const res = await app.inject({ method: 'GET', url: `/v1/crawls/${crawlId}`, headers: { authorization: `Bearer ${token(outsider)}` } });
    expect(res.statusCode).toBe(404);
  });
});
