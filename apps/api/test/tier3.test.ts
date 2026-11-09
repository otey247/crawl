import { DateTime } from 'luxon';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { one, pool, query } from '../src/db/pool.js';
import { syncCuratedEvents } from '../src/services/events.js';
import { createRouteJob, runRouteJob } from '../src/services/optimizer.js';
import { closeQueues } from '../src/services/queue.js';
import { weatherProvider } from '../src/services/weather.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let alex: string, maya: string, owner: string, rando: string;
const v: Record<string, string> = {};
const names: Record<string, string> = {};
const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, name: names[sub] ?? 'X' })}` });
const call = (method: string, url: string, sub: string, payload?: unknown) => app.inject({ method: method as any, url, headers: auth(sub), payload: payload as any });
const TZ = 'America/Chicago';

async function crawl(organizer: string, startLocal: string, venues: string[], visibility = 'private') {
  const start = DateTime.fromISO(startLocal, { zone: TZ });
  const id = (await one(
    `insert into crawls (organizer_id, title, visibility, date, start_at, timezone, neighborhood_id, status) values ($1, 'T3', $2, $3, $4, $5, 'soulard', 'planned') returning id`,
    [organizer, visibility, start.toISODate(), start.toISO(), TZ],
  ))!.id as string;
  await query(`insert into memberships (crawl_id, user_id, role, rsvp) values ($1, $2, 'organizer', 'going')`, [id, organizer]);
  for (const [i, name] of venues.entries()) await query('insert into crawl_stops (crawl_id, venue_id, position, dwell_min) values ($1,$2,$3,30)', [id, v[name], i]);
  return id;
}

beforeAll(async () => {
  await migrate(() => {});
  await query('truncate users, venues, crawls, specials, routing_cache, notifications, templates, events, weather_cache, cities restart identity cascade');
  await query(`insert into cities (id, name, timezone, center_lat, center_lng) values ('stl', 'St. Louis', $1, 38.6, -90.2)`, [TZ]);
  await query(`insert into neighborhoods (id, city_id, name, center_lat, center_lng, bbox) values ('soulard', 'stl', 'Soulard', 38.6, -90.2, '{38.59,-90.22,38.62,-90.19}')`);
  app = await buildApp({ logger: false });
  for (const n of ['Alex', 'Maya', 'Owen', 'Rando']) {
    const id = (await one(`insert into users (display_name, email, dob_verified_at) values ($1, $2, now()) returning id`, [n, `${n.toLowerCase()}@example.com`]))!.id;
    names[id] = n;
  }
  [alex, maya, owner, rando] = Object.keys(names);
  await query('update users set is_admin = true where id = $1', [alex]);
  const rows: [string, number, string[], string, string | null][] = [
    ['Pub', -90.21, [], 'pub', 'https://mcgurks.com'],
    ['Patio', -90.208, ['Patio'], 'bar', null],
    ['Corner', -90.206, [], 'bar', null],
    ['Closed', -90.204, [], 'bar', null],
  ];
  for (const [name, lng, tags, cat, site] of rows) {
    v[name] = (await one(`insert into venues (osm_id, name, lat, lng, tags, category, website, neighborhood_id) values ($1,$2,38.607,$3,$4,$5,$6,'soulard') returning id`, [`way/${name}`, name, lng, tags, cat, site]))!.id;
  }
  await query(`update venues set status = 'reported_closed' where id = $1`, [v.Closed]);
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await pool.end();
});

describe('templates', () => {
  it('forks a template into a new crawl, dropping closed bars', async () => {
    const t = (await one(
      `insert into templates (slug, title, neighborhood_id, curated, stops) values ('test-classic', 'Test Classic', 'soulard', true, $1) returning id`,
      [JSON.stringify(['Pub', 'Closed', 'Patio', 'Corner'].map((n) => ({ venueId: v[n], dwellMin: 40 })))],
    ))!.id;
    const list = (await app.inject({ method: 'GET', url: '/v1/templates?neighborhood=soulard' })).json();
    expect(list[0]).toMatchObject({ title: 'Test Classic', curated: true });
    expect(list[0].stops.map((s: any) => s.venue.name)).toEqual(['Pub', 'Patio', 'Corner']);
    const forked = await call('POST', `/v1/templates/${t}:fork`, maya, { date: '2027-05-01', startTime: '19:00' });
    expect(forked.statusCode).toBe(200);
    expect(forked.json().stops.map((s: any) => s.venue.name)).toEqual(['Pub', 'Patio', 'Corner']);
    expect(forked.json().stops[0].dwellMin).toBe(40);
    expect((await one('select uses from templates where id = $1', [t]))!.uses).toBe(1);
  });

  it('saves a crawl as a private template only its creator can see', async () => {
    const c = await crawl(maya, '2027-05-02T19:00', ['Pub', 'Corner']);
    const res = await call('POST', `/v1/crawls/${c}/template`, maya, { title: 'Maya’s usual', visibility: 'private' });
    expect(res.json()).toMatchObject({ title: 'Maya’s usual', visibility: 'private' });
    expect((await call('GET', `/v1/templates/${res.json().id}`, rando)).statusCode).toBe(404);
    expect((await call('GET', `/v1/templates/${res.json().id}`, maya)).statusCode).toBe(200);
    expect((await call('POST', `/v1/crawls/${c}/template`, rando, { title: 'Nope' })).statusCode).toBe(403);
  });
});

describe('St. Louis events', () => {
  it('flags Mardi Gras on a crawl and pads walking times in the optimizer', async () => {
    await syncCuratedEvents();
    const mardi = await crawl(alex, '2027-02-06T17:00', ['Pub', 'Corner', 'Patio']);
    const normal = await crawl(alex, '2027-02-13T17:00', ['Pub', 'Corner', 'Patio']);
    const d = (await call('GET', `/v1/crawls/${mardi}`, alex)).json();
    expect(d.events.map((e: any) => e.title)).toContain('Soulard Mardi Gras: Bud Light Grand Parade');
    expect(d.events[0]).toMatchObject({ crowdFactor: 1.6, verified: true });
    expect((await call('GET', `/v1/crawls/${normal}`, alex)).json().events).toEqual([]);

    const r1 = await createRouteJob(mardi, alex, { tags: ['fastest'] });
    const r2 = await createRouteJob(normal, alex, { tags: ['fastest'] });
    await runRouteJob(r1);
    await runRouteJob(r2);
    const [a, b] = await Promise.all([one('select total_walk_s, explanation from routes where id = $1', [r1]), one('select total_walk_s from routes where id = $1', [r2])]);
    expect(a!.total_walk_s / b!.total_walk_s).toBeCloseTo(1.6, 1);
    expect(a!.explanation).toMatch(/Mardi Gras.*crowds: walking times are padded 60%/);
  });

  it('includes Cardinals home games from the MLB schedule', async () => {
    const n = await one<{ n: number }>(`select count(*)::int as n from events where kind = 'sports'`);
    expect(n!.n).toBe(81);
  });
});

describe('weather', () => {
  it('flags patio stops in rainy hours and schedules them in dry ones', async () => {
    const start = DateTime.now().setZone(TZ).plus({ hours: 2 }).startOf('hour');
    // Dry for the first hour, then 80% rain.
    weatherProvider.fetchHourly = async () =>
      Array.from({ length: 12 }, (_, i) => ({ start: start.plus({ hours: i }).toUTC().toISO()!, temperatureF: 61 - i, precipChance: i === 0 ? 5 : 80, summary: i === 0 ? 'Cloudy' : 'Showers' }));
    const c = await crawl(alex, start.toISO()!, ['Pub', 'Corner', 'Patio']);
    const route = await createRouteJob(c, alex, { tags: ['fastest'] });
    await runRouteJob(route);
    const r = await one('select stop_order, explanation, metrics from routes where id = $1', [route]);
    const patioStop = (await one('select id from crawl_stops where crawl_id = $1 and venue_id = $2', [c, v.Patio]))!.id;
    // In list order Patio would be last and wet; the solver gets it there within the dry first hour.
    const patioArrival = Date.parse(r!.metrics.stops.find((m: any) => m.stopId === patioStop).arrival);
    expect(patioArrival).toBeLessThan(start.plus({ hours: 1 }).toMillis());
    expect(r!.stop_order[r!.stop_order.length - 1]).not.toBe(patioStop);
    expect(r!.explanation).toMatch(/Rain chances reach 80%.*patio stops \(Patio\)/);
    // Before the route is approved, arrival is estimated in list order: Patio is last and wet.
    const d = (await call('GET', `/v1/crawls/${c}`, alex)).json();
    expect(d.weather).toMatchObject({ maxPrecipChance: 80, source: 'National Weather Service' });
    expect(d.weather.outdoorAtRisk.map((x: any) => x.venueName)).toEqual(['Patio']);
  });
});

describe('venue claims and portal', () => {
  it('auto-verifies a manager with an email on the venue’s own domain', async () => {
    const res = await call('POST', `/v1/venues/${v.Pub}/claims`, owner, { contactEmail: 'gm@mcgurks.com', role: 'general_manager' });
    expect(res.json()).toMatchObject({ verification: 'email_domain' });
    const wrong = await call('POST', `/v1/venue-claims/${res.json().claimId}:verify`, owner, { code: res.json().devCode === '000000' ? '111111' : '000000' });
    expect(wrong.json().code).toBe('code_mismatch');
    const ok = await call('POST', `/v1/venue-claims/${res.json().claimId}:verify`, owner, { code: res.json().devCode });
    expect(ok.statusCode).toBe(200);
    expect((await one('select claimed_by from venues where id = $1', [v.Pub]))!.claimed_by).toBe(owner);
    expect((await call('GET', '/v1/me', owner)).json().managedVenueIds).toEqual([v.Pub]);
    const special = await call('POST', `/v1/venues/${v.Pub}/specials`, owner, { title: '$3 pints', daysOfWeek: [], startTime: '16:00', endTime: '18:00' });
    expect(special.json()).toMatchObject({ source: 'venue', confidence: 1 });
    // A second claim on a managed venue is refused.
    expect((await call('POST', `/v1/venues/${v.Pub}/claims`, rando, { contactEmail: 'x@mcgurks.com', role: 'owner' })).statusCode).toBe(409);
  });

  it('routes other claims to admin review', async () => {
    const res = await call('POST', `/v1/venues/${v.Corner}/claims`, rando, { contactEmail: 'me@gmail.com', role: 'owner', message: 'I own Corner' });
    expect(res.json().verification).toBe('manual');
    expect((await call('GET', '/v1/admin/venue-claims', rando)).statusCode).toBe(403);
    const queue = (await call('GET', '/v1/admin/venue-claims', alex)).json();
    expect(queue.map((c: any) => c.venue.name)).toEqual(['Corner']);
    expect((await one(`select count(*)::int as n from notifications where user_id = $1 and kind = 'admin.claim'`, [alex]))!.n).toBe(1);
    await call('POST', `/v1/admin/venue-claims/${queue[0].id}:approve`, alex, { note: 'Called the bar' });
    expect((await one('select claimed_by from venues where id = $1', [v.Corner]))!.claimed_by).toBe(rando);
  });

  it('shows owners aggregate demand without names, and takes a venue photo', async () => {
    await crawl(maya, DateTime.now().setZone(TZ).plus({ days: 2 }).toISO()!, ['Pub', 'Corner'], 'private');
    const ins = (await call('GET', `/v1/venues/${v.Pub}/insights`, owner)).json();
    expect(ins.next14Days.crawls).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(ins)).not.toContain('Maya');
    expect((await call('GET', `/v1/venues/${v.Pub}/insights`, maya)).statusCode).toBe(403);

    const up = (await call('POST', `/v1/venues/${v.Pub}/photo:upload-url`, owner, { contentType: 'image/jpeg' })).json();
    const jpg = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#335' } }).jpeg().toBuffer();
    const put = await app.inject({ method: 'PUT', url: new URL(up.uploadUrl).pathname + new URL(up.uploadUrl).search, headers: { 'content-type': 'image/jpeg' }, payload: jpg });
    expect(put.statusCode).toBe(200);
    const venue = (await call('POST', `/v1/venues/${v.Pub}/photo:complete`, owner, { key: up.key })).json();
    expect(venue.imageUrl).toMatch(/^\/v1\/venue-uploads\//);
    expect(venue.imageCredit).toMatchObject({ license: 'Provided by the venue' });
    const img = await app.inject({ method: 'GET', url: venue.imageUrl.replace('.jpg', '-480.jpg') });
    expect(img.headers['content-type']).toBe('image/jpeg');
  });
});

describe('friends and following', () => {
  it('surfaces public crawls people you follow are going to, respecting their settings', async () => {
    await call('POST', `/v1/users/${maya}/follow`, alex);
    expect((await one(`select title from notifications where user_id = $1 and kind = 'friend.follow'`, [maya]))!.title).toBe('Alex started following you');
    const pub = await crawl(maya, DateTime.now().setZone(TZ).plus({ days: 3 }).toISO()!, ['Pub', 'Corner'], 'public');
    await crawl(maya, DateTime.now().setZone(TZ).plus({ days: 4 }).toISO()!, ['Pub', 'Corner'], 'private');
    const feed = (await call('GET', '/v1/friends/crawls', alex)).json();
    expect(feed.map((f: any) => f.crawl.id)).toEqual([pub]);
    expect(feed[0].friends.map((u: any) => u.displayName)).toEqual(['Maya']);
    // Once you've joined, it's no longer a suggestion.
    await query(`insert into memberships (crawl_id, user_id, role, rsvp) values ($1, $2, 'participant', 'going')`, [pub, alex]);
    expect((await call('GET', '/v1/friends/crawls', alex)).json()).toEqual([]);
    await query('delete from memberships where crawl_id = $1 and user_id = $2', [pub, alex]);

    const profile = (await call('GET', `/v1/users/${maya}`, alex)).json();
    expect(profile).toMatchObject({ isFollowing: true, followers: 1, activityHidden: false });
    expect(profile.upcoming.map((c: any) => c.id)).toEqual([pub]);

    await call('PATCH', '/v1/me', maya, { activityVisibility: 'nobody' });
    expect((await call('GET', '/v1/friends/crawls', alex)).json()).toEqual([]);
    expect((await call('GET', `/v1/users/${maya}`, alex)).json()).toMatchObject({ activityHidden: true, upcoming: [] });
  });

  it('suggests people you have crawled with', async () => {
    const c = await crawl(rando, '2027-06-01T19:00', ['Pub', 'Corner']);
    await query(`insert into memberships (crawl_id, user_id, role, rsvp) values ($1, $2, 'participant', 'going')`, [c, owner]);
    const s = (await call('GET', '/v1/me/follow-suggestions', owner)).json();
    expect(s.map((u: any) => u.displayName)).toContain('Rando');
  });
});
