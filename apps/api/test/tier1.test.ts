import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { one, pool, query } from '../src/db/pool.js';
import { markArrived, markDeparted, startCrawl } from '../src/services/live.js';
import { transport } from '../src/services/push.js';
import { closeQueues } from '../src/services/queue.js';
import { runReminders } from '../src/services/reminders.js';

let app: Awaited<ReturnType<typeof buildApp>>;
const sent: { endpoint: string; payload: any }[] = [];
let org: string;
let maybe: string;
let going: string;
const auth = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub, name: 'T' })}` });

async function crawl(startInMin: number, status = 'planned', visibility = 'public') {
  const c = (await one(
    `insert into crawls (organizer_id, title, visibility, date, start_at, timezone, status) values ($1, 'Tier 1 crawl', $3, current_date, now() + ($2 || ' minutes')::interval, 'America/Chicago', $4) returning id`,
    [org, String(startInMin), visibility, status],
  ))!.id as string;
  await query(`insert into memberships (crawl_id, user_id, role, rsvp) values ($1,$2,'organizer','going'), ($1,$3,'participant','maybe'), ($1,$4,'participant','going')`, [c, org, maybe, going]);
  const v = (await one(`select id from venues limit 1`))!.id;
  const v2 = (await one(`select id from venues offset 1 limit 1`))!.id;
  await query(`insert into crawl_stops (crawl_id, venue_id, position) values ($1,$2,0), ($1,$3,1)`, [c, v, v2]);
  return c;
}

beforeAll(async () => {
  await migrate(() => {});
  await query('truncate users, venues, crawls, specials, routing_cache, notifications, push_subscriptions restart identity cascade');
  app = await buildApp({ logger: false });
  transport.send = async (sub: any, payload: string) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return {} as any;
  };
  [org, maybe, going] = await Promise.all(
    ['Org', 'Maybe', 'Going'].map(async (n) => (await one(`insert into users (display_name, dob_verified_at) values ($1, now()) returning id`, [n]))!.id),
  );
  await query(`insert into venues (osm_id, name, lat, lng) values ('way/1', 'Bar One', 38.607, -90.21), ('way/2', 'Bar Two', 38.608, -90.205)`);
  for (const u of [org, maybe, going]) {
    const res = await app.inject({ method: 'POST', url: '/v1/me/push-subscriptions', headers: auth(u), payload: { endpoint: `https://push.example.com/${u}`, keys: { p256dh: 'p', auth: 'a' } } });
    expect(res.statusCode).toBe(200);
  }
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await pool.end();
});

describe('web push + reminders', () => {
  it('exposes a VAPID key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/push/vapid-public-key' });
    expect(res.json().publicKey).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });

  it('nudges Maybes once, the day before', async () => {
    await crawl(300);
    sent.length = 0;
    await runReminders();
    expect(sent.map((s) => s.endpoint)).toEqual([`https://push.example.com/${maybe}`]);
    expect(sent[0].payload.title).toMatch(/Still a maybe/);
    sent.length = 0;
    await runReminders();
    expect(sent).toHaveLength(0);
  });

  it('sends the one-hour heads-up to everyone Going or Maybe', async () => {
    const c = await crawl(45);
    sent.length = 0;
    await runReminders();
    const soon = sent.filter((s) => s.payload.title.includes('starts at'));
    expect(soon).toHaveLength(3); // organizer + going + maybe
    expect(soon[0].payload.url).toBe(`/crawls/${c}`);
  });

  it('pushes "group is leaving" when the group departs', async () => {
    const c = await crawl(0, 'planned', 'private');
    await startCrawl(c, org);
    const first = (await one('select id from crawl_stops where crawl_id = $1 and position = 0', [c]))!.id;
    await markArrived(c, first);
    sent.length = 0;
    await markDeparted(c);
    const leaving = sent.filter((s) => s.payload.title.startsWith('Group’s heading to'));
    expect(leaving).toHaveLength(3);
    expect(leaving[0].payload.title).toContain('Bar Two');
  });

  it('asks Going members if they got home, and records the answer', async () => {
    const c = await crawl(-300, 'ended');
    await query(`update crawls set ended_at = now() - interval '90 minutes' where id = $1`, [c]);
    const res = await app.inject({ method: 'POST', url: `/v1/crawls/${c}/home-safe`, headers: auth(going) });
    expect(res.statusCode).toBe(200);
    sent.length = 0;
    await runReminders();
    // Org is Going and not home yet; Going already confirmed; Maybe isn't asked.
    expect(sent.filter((s) => s.payload.title === 'Home safe?').map((s) => s.endpoint)).toEqual([`https://push.example.com/${org}`]);
    const detail = (await app.inject({ method: 'GET', url: `/v1/crawls/${c}`, headers: auth(org) })).json();
    expect(detail.members.find((m: any) => m.user.id === going).homeSafeAt).toBeTruthy();
    expect(detail.safety.cabs.length).toBeGreaterThan(0);
  });

  it('drops subscriptions the push service reports as gone', async () => {
    transport.send = async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 });
    };
    const { sendWebPush } = await import('../src/services/push.js');
    await sendWebPush([maybe], { title: 't', body: 'b', url: '/' });
    expect((await one('select count(*)::int as n from push_subscriptions where user_id = $1', [maybe]))!.n).toBe(0);
  });
});

describe('link previews', () => {
  it('renders Open Graph tags for invites and a PNG card', async () => {
    const c = await crawl(600, 'planned', 'private');
    await query(`insert into invites (crawl_id, token, created_by) values ($1, 'tok-preview-123', $2)`, [c, org]);
    const html = await app.inject({ method: 'GET', url: '/v1/og/i/tok-preview-123' });
    expect(html.headers['content-type']).toContain('text/html');
    expect(html.body).toContain('og:title" content="Org invited you: Tier 1 crawl"');
    expect(html.body).toContain('Bar One');
    const png = await app.inject({ method: 'GET', url: '/v1/og/image/invite/tok-preview-123.png' });
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.rawPayload.subarray(1, 4).toString()).toBe('PNG');
  });

  it('keeps private crawls generic without an invite token', async () => {
    const c = await crawl(600, 'planned', 'private');
    const html = await app.inject({ method: 'GET', url: `/v1/og/crawls/${c}` });
    expect(html.body).not.toContain('Tier 1 crawl');
  });
});

describe('venue photos and closures', () => {
  it('serves curated venue photos and rejects anything else', async () => {
    const ok = await app.inject({ method: 'GET', url: '/v1/venue-images/relation-8869242-480.jpg' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    const bad = await app.inject({ method: 'GET', url: '/v1/venue-images/..%2F..%2Fpackage.json' });
    expect(bad.statusCode).toBe(400);
  });

  it('hides reported-closed venues from search and new crawls', async () => {
    await query(`update venues set status = 'reported_closed' where osm_id = 'way/2'`);
    const res = await app.inject({ method: 'GET', url: '/v1/venues/search?q=bar' });
    expect(res.json().map((v: any) => v.name)).toEqual(['Bar One']);
    const c = await crawl(600);
    const closed = (await one(`select id from venues where osm_id = 'way/2'`))!.id;
    await query('delete from crawl_stops where crawl_id = $1 and venue_id = $2', [c, closed]);
    const add = await app.inject({ method: 'POST', url: `/v1/crawls/${c}/stops`, headers: auth(org), payload: { venueId: closed } });
    expect(add.statusCode).toBe(400);
    expect(add.json().code).toBe('venue_closed');
  });
});
