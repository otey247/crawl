import type { FastifyInstance } from 'fastify';
import { DateTime } from 'luxon';
import sharp from 'sharp';
import { z } from 'zod';
import { classifySpecial, estimateWalk, type RecapDTO, type SpecialRule } from '@crawl/core';
import { userId } from '../auth.js';
import { findNeighborhood } from '../cities/index.js';
import { one, query } from '../db/pool.js';
import { conflict } from '../lib/errors.js';
import { PHOTO_SELECT, getCrawlRow, loadStops, photoDTO, requireRole, userDTO } from '../services/repo.js';
import { esc, wrap } from './og.js';

/**
 * Post-crawl recap: where the group went, how far it walked, which specials it caught, the best
 * photos (Photographer's picks first) and who held each crew role.
 */
export async function buildRecap(crawlId: string, viewer: string): Promise<RecapDTO> {
  const crawl = await getCrawlRow(crawlId);
  if (crawl.status !== 'ended') throw conflict('The recap is ready once the crawl ends', 'not_ended');
  const stops = await loadStops(crawlId, crawl.timezone);
  const visited = stops.filter((s) => s.arrivedAt).sort((a, b) => Date.parse(a.arrivedAt!) - Date.parse(b.arrivedAt!));
  const crawlStart = Date.parse(crawl.started_at ?? crawl.start_at);
  const endedAt = Date.parse(crawl.ended_at ?? new Date().toISOString());

  const [checkIns, legs, photoRows, crewRows, counts] = await Promise.all([
    query('select stop_id, count(*)::int as n, bool_or(user_id = $2) as mine from check_ins where crawl_id = $1 group by stop_id', [crawlId, viewer]),
    crawl.approved_route_id ? query('select from_stop_id, to_stop_id, distance_m, geometry from route_legs where route_id = $1', [crawl.approved_route_id]) : Promise.resolve([]),
    query(
      `select * from (${PHOTO_SELECT} where p.crawl_id = $1 and p.status = 'ready') x
       order by (x.featured_at is not null) desc, x.by_photographer desc, x.featured_at desc nulls last, x.created_at desc limit 9`,
      [crawlId],
    ),
    query(
      `select m.crew_role, u.id, u.display_name, u.avatar_url from memberships m join users u on u.id = m.user_id
       where m.crawl_id = $1 and m.crew_role is not null order by m.crew_role, u.display_name`,
      [crawlId],
    ),
    one(
      `select count(*) filter (where rsvp = 'going')::int as going, count(*) filter (where home_safe_at is not null)::int as home_safe,
         (select count(*)::int from photos where crawl_id = $1 and status = 'ready') as photos
       from memberships where crawl_id = $1`,
      [crawlId],
    ),
  ]);

  let distanceM = 0;
  const route: [number, number][] = [];
  visited.forEach((s, i) => {
    if (i === 0) {
      route.push([s.venue.lng, s.venue.lat]);
      return;
    }
    const prev = visited[i - 1];
    const leg = legs.find((l) => l.from_stop_id === prev.id && l.to_stop_id === s.id);
    if (leg) {
      distanceM += leg.distance_m;
      route.push(...(leg.geometry as [number, number][]).slice(1));
    } else {
      distanceM += estimateWalk({ lat: prev.venue.lat, lng: prev.venue.lng }, { lat: s.venue.lat, lng: s.venue.lng }).distanceM;
      route.push([s.venue.lng, s.venue.lat]);
    }
  });

  const recapStops = visited.map((s) => {
    const caught = s.venue.specials.filter((sp) => {
      const rule: SpecialRule = { id: sp.id, title: sp.title, daysOfWeek: sp.daysOfWeek, startTime: sp.startTime, endTime: sp.endTime, validFrom: sp.validFrom, validTo: sp.validTo };
      const departure = s.departedAt ? Date.parse(s.departedAt) : endedAt;
      return (
        classifySpecial({ rule, tz: crawl.timezone, now: endedAt, crawlStartAt: crawlStart, stop: { stopId: s.id, phase: 'visited', eta: Date.parse(s.arrivedAt!), departure } }).state === 'caught'
      );
    });
    const ci = checkIns.find((c) => c.stop_id === s.id);
    return {
      stopId: s.id,
      name: s.venue.name,
      category: s.venue.category,
      imageUrl: s.venue.imageUrl,
      lat: s.venue.lat,
      lng: s.venue.lng,
      arrivedAt: s.arrivedAt!,
      departedAt: s.departedAt,
      checkIns: ci?.n ?? 0,
      specialsCaught: caught.map((c) => c.title),
      iCheckedIn: !!ci?.mine,
    };
  });

  return {
    crawl: {
      id: crawl.id,
      title: crawl.title,
      startAt: crawl.start_at,
      endedAt: crawl.ended_at,
      timezone: crawl.timezone,
      neighborhood: findNeighborhood(crawl.neighborhood_id)?.hood.name ?? null,
    },
    stops: recapStops,
    skipped: stops.filter((s) => !s.arrivedAt).map((s) => s.venue.name),
    totals: {
      stopsVisited: visited.length,
      distanceM,
      durationS: crawl.started_at && crawl.ended_at ? (Date.parse(crawl.ended_at) - Date.parse(crawl.started_at)) / 1000 : 0,
      specialsCaught: recapStops.reduce((n, s) => n + s.specialsCaught.length, 0),
      checkIns: checkIns.reduce((n, c) => n + c.n, 0),
      photos: counts!.photos,
      going: counts!.going,
      homeSafe: counts!.home_safe,
    },
    route,
    photos: photoRows.map(photoDTO),
    crew: crewRows.map((r) => ({ role: r.crew_role, user: userDTO(r) })),
  };
}

/**
 * Shareable 1080×1350 card: title, route sketch, totals and the bars. Deliberately no member
 * photos or names, so it is safe to post publicly.
 */
async function renderRecapCard(r: RecapDTO): Promise<Buffer> {
  const W = 1080;
  const H = 1350;
  const box = { x: 90, y: 360, w: 900, h: 470 };
  const pts: [number, number][] = r.route.length > 1 ? r.route : r.stops.map((s) => [s.lng, s.lat]);
  if (!pts.length) pts.push([0, 0]); // nothing visited: empty map panel
  const lngs = pts.map((p) => p[0]);
  const lats = pts.map((p) => p[1]);
  // At least ~500 m across, so a short crawl isn't blown up to fill the panel.
  const MIN_SPAN = 0.0045;
  const pad = (lo: number, hi: number) => (hi - lo >= MIN_SPAN ? [lo, hi] : [(lo + hi) / 2 - MIN_SPAN / 2, (lo + hi) / 2 + MIN_SPAN / 2]);
  const [minX, maxX] = pad(Math.min(...lngs), Math.max(...lngs));
  const [minY, maxY] = pad(Math.min(...lats), Math.max(...lats));
  const kx = Math.cos(((minY + maxY) / 2) * (Math.PI / 180));
  const spanX = Math.max((maxX - minX) * kx, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min((box.w - 80) / spanX, (box.h - 80) / spanY);
  const ox = box.x + (box.w - spanX * scale) / 2;
  const oy = box.y + (box.h - spanY * scale) / 2;
  const project = ([lng, lat]: [number, number]) => [ox + (lng - minX) * kx * scale, oy + (maxY - lat) * scale] as const;
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${project(p).map((v) => v.toFixed(1)).join(' ')}`).join(' ');
  // Numbered markers at each visited venue, in visit order.
  const markers: { x: number; y: number; n: number }[] = [];
  r.stops.forEach((s, i) => {
    let [x, y] = project([s.lng, s.lat]);
    // Bars a few doors apart would stack; nudge later markers sideways like the map's pin fan-out.
    while (markers.some((m) => Math.hypot(m.x - x, m.y - y) < 50)) x += 52;
    markers.push({ x, y, n: i + 1 });
  });

  const title = wrap(r.crawl.title, 22, 2);
  const date = DateTime.fromISO(r.crawl.startAt, { zone: r.crawl.timezone }).toFormat('cccc, LLLL d, yyyy');
  const miles = (r.totals.distanceM / 1609.34).toFixed(1);
  const hours = (r.totals.durationS / 3600).toFixed(1);
  const stats: [string, string][] = [
    [String(r.totals.stopsVisited), r.totals.stopsVisited === 1 ? 'bar' : 'bars'],
    [miles, 'miles walked'],
    [hours, 'hours out'],
    [String(r.totals.specialsCaught), r.totals.specialsCaught === 1 ? 'special caught' : 'specials caught'],
  ];
  const barLine = wrap(r.stops.map((s) => s.name).join('  →  '), 52, 2);

  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="50%" cy="50%" r="60%"><stop offset="0" stop-color="#f6b73c" stop-opacity=".16"/><stop offset="1" stop-color="#f6b73c" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="#0b0b0c"/>
  <text x="90" y="130" font-family="DejaVu Sans" font-size="26" font-weight="bold" letter-spacing="5" fill="#f6b73c">CRAWL RECAP${r.crawl.neighborhood ? ` · ${esc(r.crawl.neighborhood.toUpperCase())}` : ''}</text>
  ${title.map((l, i) => `<text x="90" y="${205 + i * 70}" font-family="DejaVu Serif" font-size="62" font-weight="bold" fill="#f5f3ee">${esc(l)}</text>`).join('')}
  <text x="90" y="${215 + title.length * 70}" font-family="DejaVu Sans" font-size="28" fill="#a29e95">${esc(date)}</text>
  <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="36" fill="#141416"/>
  <rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="36" fill="url(#glow)"/>
  <path d="${path}" fill="none" stroke="#f6b73c" stroke-opacity=".25" stroke-width="22" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${path}" fill="none" stroke="#f6b73c" stroke-width="7" stroke-dasharray="16 12" stroke-linecap="round" stroke-linejoin="round"/>
  ${markers
    .map(
      (m) => `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="26" fill="#f6b73c" stroke="#0b0b0c" stroke-width="5"/>
  <text x="${m.x.toFixed(1)}" y="${(m.y + 10).toFixed(1)}" text-anchor="middle" font-family="DejaVu Sans" font-size="27" font-weight="bold" fill="#1a1205">${m.n}</text>`,
    )
    .join('')}
  ${stats
    .map(([n, label], i) => {
      const x = 90 + (i % 2) * 460;
      const y = 930 + Math.floor(i / 2) * 150;
      return `<text x="${x}" y="${y}" font-family="DejaVu Serif" font-size="84" font-weight="bold" fill="#f5f3ee">${esc(n)}</text>
  <text x="${x}" y="${y + 44}" font-family="DejaVu Sans" font-size="28" fill="#a29e95">${esc(label)}</text>`;
    })
    .join('')}
  ${barLine.map((l, i) => `<text x="90" y="${1235 + i * 38}" font-family="DejaVu Sans" font-size="26" fill="#c9c5bc">${esc(l)}</text>`).join('')}
  <text x="${W - 90}" y="${H - 40}" text-anchor="end" font-family="DejaVu Serif" font-size="40" font-weight="bold" fill="#f6b73c">Crawl</text>
</svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
}

export async function recapRoutes(app: FastifyInstance) {
  const Params = z.object({ id: z.string().uuid() });

  app.get('/crawls/:id/recap', { preHandler: app.authenticate }, async (req) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    return buildRecap(id, uid);
  });

  app.get('/crawls/:id/recap/card.png', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = Params.parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    const recap = await buildRecap(id, uid);
    reply.type('image/png').header('cache-control', 'private, max-age=300');
    const crawl = await getCrawlRow(id);
    const safe = crawl.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'crawl';
    reply.header('content-disposition', `inline; filename="${safe}-recap.png"`);
    return reply.send(await renderRecapCard(recap));
  });
}
