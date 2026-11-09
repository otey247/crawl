/**
 * Development seed: St. Louis + Soulard venues from OpenStreetMap, sample specials, dev users
 * and a few crawls. Resets all app data — never run against production.
 *
 * Specials here are SAMPLE data for development and demos (source = crowd, confidence 0.6).
 * They are not verified offers from these venues.
 */
import { existsSync, readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { CITIES } from '../cities/index.js';
import { config } from '../config.js';
import { approveRoute, createRouteJob, runRouteJob } from '../services/optimizer.js';
import { migrate } from './migrate.js';
import { pool, query, one } from './pool.js';

if (config.isProd) {
  console.error('Refusing to seed in production.');
  process.exit(1);
}

type Curation = { name?: string; category?: 'pub' | 'bar' | 'biergarten' | 'cocktail'; price?: number; tags?: string[] };

/** App-side overrides layered on top of OSM (never written back to OSM). Keyed by OSM name. */
const CURATION: Record<string, Curation> = {
  "John D. McGurk's Irish Pub and Garden": { name: "McGurk's Irish Pub", category: 'pub', price: 2, tags: ['Irish', 'Live music', 'Beer garden'] },
  "Molly's": { name: "Molly's in Soulard", category: 'bar', price: 2, tags: ['Pub', 'Patio'] },
  "1860's": { name: '1860 Saloon', category: 'bar', price: 1, tags: ['Live music'] },
  Hammerstones: { name: "Hammerstone's", category: 'bar', price: 1, tags: ['Live music', 'Pub grub'] },
  "Llewyln's": { name: "Llywelyn's Pub", category: 'pub', price: 2, tags: ['Celtic', 'Patio'] },
  'Great Grizzly Bear': { category: 'bar', price: 1, tags: ['Live music', 'Dive'] },
  Bastille: { category: 'bar', price: 1, tags: ['Neighborhood bar'] },
  "Big Daddy's": { category: 'bar', price: 1, tags: ['Sports bar'] },
  'Hi Hat': { name: 'The Hi-Hat', category: 'bar', price: 1, tags: ['Neighborhood bar', 'Patio'] },
  'Eat Crow': { category: 'bar', price: 2, tags: ['Kitchen'] },
  "Duke's": { category: 'bar', price: 1, tags: ['Sports bar'] },
  'International Taphouse': { name: 'International Tap House', category: 'bar', price: 2, tags: ['Craft beer'] },
  'The Biergarten': { category: 'biergarten', price: 2, tags: ['Brewery', 'Beer garden'] },
  'Bar 101': { category: 'cocktail', price: 2, tags: ['Cocktails'] },
  "D's Place": { tags: ['Dive'] },
  "Cat's Meow": { tags: ['Dive'] },
  'Hardshell Cafe': { price: 2, tags: ['Seafood'] },
};

/** Sample specials (crowd source). [venue display name, title, details, days, start, end] */
const SAMPLE_SPECIALS: [string, string, string, number[], string, string][] = [
  ["McGurk's Irish Pub", '$3 Pints', 'Domestic pints during happy hour', [2, 3, 4, 5, 6], '16:00', '18:30'],
  ["Molly's in Soulard", '$4 Wells', 'Well drinks', [], '15:00', '19:00'],
  ['1860 Saloon', '$2 off drafts', 'While the band plays', [5, 6], '21:00', '23:00'],
  ["Hammerstone's", '$3 late-night shots', 'House shots', [4, 5, 6], '22:00', '01:00'],
  ['Great Grizzly Bear', '$2.50 PBR', 'Tallboys', [], '19:00', '21:00'],
  ['International Tap House', '$1 off craft drafts', 'All drafts', [], '17:00', '19:00'],
  ['Bastille', '$5 cocktails', 'House cocktails', [5, 6], '18:00', '20:00'],
  ['The Hi-Hat', 'Cocktail hour', '$6 house cocktails', [3, 4, 5, 6], '17:00', '19:30'],
  ['Eat Crow', 'Happy hour', '$1 off beer and wine', [1, 2, 3, 4, 5], '15:00', '18:00'],
];

const DEV_USERS = [
  'Alex Rivera', 'Maya Chen', 'Sam Okafor', 'Priya Shah', 'Marcus Hill', 'Tess Morgan', 'Diego Alvarez', 'Hannah Kim',
  'Luis Romero', 'Grace Park', 'Owen Brooks', 'Nina Patel', 'Ben Carter', 'Zoe Adams', 'Ethan Wright', 'Ava Lopez', 'Liam Turner',
];

async function main() {
  await migrate(() => {});
  console.log('Resetting data…');
  await query(`truncate users, magic_links, cities, neighborhoods, venues, crawls, specials, routing_cache restart identity cascade`);

  for (const c of CITIES) {
    await query('insert into cities (id, name, timezone, center_lat, center_lng) values ($1,$2,$3,$4,$5)', [c.id, c.name, c.timezone, c.center.lat, c.center.lng]);
    for (const n of c.neighborhoods) {
      await query('insert into neighborhoods (id, city_id, name, center_lat, center_lng, zoom, bbox) values ($1,$2,$3,$4,$5,$6,$7)', [n.id, c.id, n.name, n.center.lat, n.center.lng, n.zoom, n.bbox]);
    }
  }

  const osm: any[] = JSON.parse(readFileSync(new URL('../../data/soulard-venues.json', import.meta.url), 'utf8'));
  const creditsFile = new URL('../../data/venue-images/credits.json', import.meta.url);
  const credits: Record<string, { file: string; author: string | null; license: string | null; sourcePage: string | null }> = existsSync(creditsFile)
    ? JSON.parse(readFileSync(creditsFile, 'utf8'))
    : {};
  const venueIds = new Map<string, string>();
  for (const v of osm) {
    const cur = CURATION[v.name] ?? {};
    const category = cur.category ?? (v.amenity === 'pub' ? 'pub' : v.amenity === 'biergarten' ? 'biergarten' : 'bar');
    const row = await one(
      `insert into venues (osm_id, name, name_override, lat, lng, address, neighborhood_id, category, price_level, tags, opening_hours, source, synced_at, image_url, image_credit)
       values ($1,$2,$3,$4,$5,$6,'soulard',$7,$8,$9,$10,'osm', now(), $11, $12) returning id`,
      [
        v.osm_id, v.name, cur.name ?? null, v.lat, v.lng, v.address, category, cur.price ?? 1, cur.tags ?? [], v.opening_hours,
        credits[v.osm_id] ? `/v1/venue-images/${credits[v.osm_id].file}` : null,
        credits[v.osm_id] ? JSON.stringify({ author: credits[v.osm_id].author, license: credits[v.osm_id].license, sourcePage: credits[v.osm_id].sourcePage }) : null,
      ],
    );
    venueIds.set(cur.name ?? v.name, row!.id);
  }
  console.log(`Venues: ${venueIds.size} (Soulard, from OpenStreetMap)`);

  // Closure reports gathered during venue research (Oct 2026). Verify before launch.
  const REPORTED_CLOSED: Record<string, string> = {
    "Llywelyn's Pub": 'Riverfront Times reported the Soulard location appears closed for good; the chain no longer lists it.',
    'Bar 101': 'Website domain is parked and no recent coverage was found; may be closed.',
  };
  for (const [name, note] of Object.entries(REPORTED_CLOSED)) {
    await query(`update venues set status = 'reported_closed', status_note = $2 where id = $1`, [venueIds.get(name), note]);
  }

  for (const [venue, title, details, days, start, end] of SAMPLE_SPECIALS) {
    const venueId = venueIds.get(venue);
    if (!venueId) continue;
    await query(
      `insert into specials (venue_id, title, details, days_of_week, start_time, end_time, source, confidence, confirmations, last_confirmed_at)
       values ($1,$2,$3,$4,$5,$6,'crowd',0.6,2, now())`,
      [venueId, title, details, days, start, end],
    );
  }

  const users: string[] = [];
  for (const name of DEV_USERS) {
    const email = `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`;
    const row = await one(`insert into users (email, display_name, dob_verified_at, is_dev_seed) values ($1,$2, now(), true) returning id`, [email, name]);
    users.push(row!.id);
  }
  const [alex, maya, sam] = users;

  const tz = 'America/Chicago';
  const now = DateTime.now().setZone(tz);
  let tonight = now.set({ hour: 18, minute: 0, second: 0, millisecond: 0 });
  if (tonight < now.minus({ hours: 1 })) tonight = tonight.plus({ days: 1 });

  async function crawl(opts: { organizer: string; title: string; description: string; visibility: 'public' | 'private'; start: DateTime; stops: [string, number][]; members: [string, string][]; status?: string }) {
    const c = await one(
      `insert into crawls (organizer_id, title, description, visibility, date, start_at, timezone, neighborhood_id, status)
       values ($1,$2,$3,$4,$5,$6,$7,'soulard',$8) returning id`,
      [opts.organizer, opts.title, opts.description, opts.visibility, opts.start.toISODate(), opts.start.toISO(), tz, opts.status ?? 'draft'],
    );
    const id = c!.id as string;
    await query(`insert into memberships (crawl_id, user_id, role, rsvp) values ($1,$2,'organizer','going')`, [id, opts.organizer]);
    for (const [uid, rsvp] of opts.members) await query(`insert into memberships (crawl_id, user_id, role, rsvp) values ($1,$2,'participant',$3)`, [id, uid, rsvp]);
    for (const [i, [venue, dwell]] of opts.stops.entries()) {
      await query('insert into crawl_stops (crawl_id, venue_id, position, dwell_min) values ($1,$2,$3,$4)', [id, venueIds.get(venue), i, dwell]);
    }
    return id;
  }

  // 1. Tonight's public crawl, organized by the default dev user, route optimized + approved.
  const saturday = await crawl({
    organizer: alex,
    title: 'Soulard Saturday Crawl',
    description: 'Five classic Soulard bars on foot. Meet at McGurk’s; we keep a relaxed pace and stick together.',
    visibility: 'public',
    start: tonight,
    stops: [
      ["Molly's in Soulard", 45],
      ['The Hi-Hat', 40],
      ["Hammerstone's", 45],
      ['1860 Saloon', 50],
      ["McGurk's Irish Pub", 45],
    ],
    members: users.slice(1, 16).map((u, i) => [u, i % 5 === 4 ? 'maybe' : 'going']),
  });
  await query(`update memberships set crew_role = 'designated_driver' where crawl_id = $1 and user_id = $2`, [saturday, users[3]]);
  await query(`update memberships set crew_role = 'navigator', role = 'co_host' where crawl_id = $1 and user_id = $2`, [saturday, maya]);
  await query(`update memberships set crew_role = 'photographer' where crawl_id = $1 and user_id = $2`, [saturday, sam]);
  // Priya (Designated Driver) is driving the van back toward the Central West End.
  const offer = await one(
    `insert into ride_offers (crawl_id, driver_id, seats, area, leaving_note) values ($1, $2, 4, 'Central West End', 'After the last stop') returning id`,
    [saturday, users[3]],
  );
  await query(`insert into ride_requests (crawl_id, user_id, destination, party_size, offer_id) values ($1, $2, 'Central West End', 2, $3)`, [saturday, users[4], offer!.id]);
  await query(`insert into ride_requests (crawl_id, user_id, destination, party_size) values ($1, $2, 'Tower Grove South', 1)`, [saturday, users[6]]);
  const routeId = await createRouteJob(saturday, alex, { tags: ['specials'], note: null });
  await runRouteJob(routeId);
  await approveRoute(saturday, routeId);
  await query(`insert into messages (crawl_id, user_id, body) values ($1,$2,'Who’s in for McGurk’s at 6? First round of $3 pints is on me 🍀'), ($1,$3,'In! I''ll grab the patio table.'), ($1,$4,'Driving tonight — I''ve got the van for anyone heading back to CWE.')`, [saturday, alex, maya, users[3]]);

  // 2. A private crawl Alex has been invited to (shows in Invites).
  const friday = await crawl({
    organizer: maya,
    title: 'Maya’s Birthday Bar Hop',
    description: 'Low-key birthday crawl. Bring a sweater for the patios.',
    visibility: 'private',
    start: tonight.plus({ days: 6 }).set({ hour: 19, minute: 30 }),
    stops: [
      ['Eat Crow', 50],
      ['International Tap House', 45],
      ['Great Grizzly Bear', 45],
    ],
    members: [[users[4], 'going'], [users[5], 'going'], [users[7], 'maybe']],
    status: 'planned',
  });
  await query('insert into invite_targets (crawl_id, user_id, invited_by) values ($1,$2,$3)', [friday, alex, maya]);
  await query(`insert into invites (crawl_id, token, created_by) values ($1, 'dev-invite-mayas-birthday', $2)`, [friday, maya]);
  await query(
    `insert into notifications (user_id, crawl_id, kind, title, body) values ($1, $2, 'invite', 'Maya Chen invited you', $3)`,
    [alex, friday, `Maya’s Birthday Bar Hop · ${tonight.plus({ days: 6 }).toFormat('ccc, LLL d')} at 7:30 PM`],
  );

  // 3. Another public crawl to discover.
  await crawl({
    organizer: sam,
    title: 'Biergarten to Broadway',
    description: 'Start under the oaks at the brewery and work our way east.',
    visibility: 'public',
    start: tonight.plus({ days: 1 }).set({ hour: 14 }),
    stops: [
      ['The Biergarten', 60],
      ["Big Daddy's", 45],
      ['Bastille', 40],
      ["Duke's", 45],
    ],
    members: users.slice(8, 14).map((u) => [u, 'going']),
    status: 'planned',
  });

  // 4. A finished crawl so Visited History has content.
  const lastWeek = tonight.minus({ days: 7 });
  const past = await crawl({
    organizer: alex,
    title: 'Halloween Warm-up',
    description: 'Costumes optional.',
    visibility: 'private',
    start: lastWeek,
    stops: [
      ["McGurk's Irish Pub", 45],
      ["Hammerstone's", 45],
      ['1860 Saloon', 45],
      ["Molly's in Soulard", 45],
    ],
    members: [[maya, 'going'], [sam, 'going'], [users[3], 'going']],
    status: 'ended',
  });
  const pastStops = await query('select id, venue_id, position from crawl_stops where crawl_id = $1 order by position', [past]);
  for (const s of pastStops) {
    const arrived = lastWeek.plus({ minutes: s.position * 55 });
    await query('update crawl_stops set arrived_at = $2, departed_at = $3 where id = $1', [s.id, arrived.toISO(), arrived.plus({ minutes: 45 }).toISO()]);
    for (const u of [alex, maya, sam].slice(0, s.position === 3 ? 2 : 3)) {
      await query('insert into check_ins (crawl_id, stop_id, venue_id, user_id, checked_in_at) values ($1,$2,$3,$4,$5)', [past, s.id, s.venue_id, u, arrived.plus({ minutes: 3 }).toISO()]);
    }
  }
  await query(`update crawls set started_at = $2, ended_at = $3 where id = $1`, [past, lastWeek.toISO(), lastWeek.plus({ hours: 4 }).toISO()]);

  console.log('Seeded: 4 crawls, %d dev users. Default dev user: Alex Rivera', users.length);
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
