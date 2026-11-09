import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config.js';
import { one } from '../db/pool.js';
import { TOKEN_PARAM, UUID_PARAM } from '../lib/ids.js';
import { getCrawlRow } from '../services/repo.js';
import { venueImagePath } from './venueImages.js';

/**
 * Link previews. Chat apps and social sites fetch shared links without running JavaScript, so the
 * SPA alone previews as a blank page. The web tier routes crawler user agents for /i/:token and
 * /crawls/:id here (see apps/web/nginx.conf and the Vite dev middleware); people get the app.
 *
 * Only what the invite landing page already shows is exposed: title, date, organizer, first stop.
 */

interface Preview {
  title: string;
  description: string;
  path: string;
  image: string;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(p: Preview): string {
  const url = `${config.appUrl}${p.path}`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${esc(p.title)}</title>
<meta name="description" content="${esc(p.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Crawl">
<meta property="og:title" content="${esc(p.title)}">
<meta property="og:description" content="${esc(p.description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(p.image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(p.title)}">
<meta name="twitter:description" content="${esc(p.description)}">
<meta name="twitter:image" content="${esc(p.image)}">
<meta http-equiv="refresh" content="0;url=${esc(url)}">
</head><body><a href="${esc(url)}">${esc(p.title)}</a></body></html>`;
}

const GENERIC: Preview = {
  title: 'Crawl — plan the night, bring the crew',
  description: 'Build a pub crawl, get the best walking route, and catch every happy hour.',
  path: '/',
  image: `${config.apiUrl}/v1/og/image/default.png`,
};

async function crawlFacts(crawlId: string) {
  const crawl = await getCrawlRow(crawlId);
  const facts = await one(
    `select u.display_name as organizer,
       (select count(*)::int from crawl_stops where crawl_id = $1) as stops,
       (select count(*)::int from memberships where crawl_id = $1 and rsvp = 'going') as going,
       (select coalesce(v.name_override, v.name) from crawl_stops s join venues v on v.id = s.venue_id where s.crawl_id = $1 order by s.position limit 1) as first_stop,
       (select v.osm_id from crawl_stops s join venues v on v.id = s.venue_id where s.crawl_id = $1 order by s.position limit 1) as first_osm
     from crawls c join users u on u.id = c.organizer_id where c.id = $1`,
    [crawlId],
  );
  const when = DateTime.fromISO(crawl.start_at, { zone: crawl.timezone }).toFormat("cccc, LLL d 'at' h:mm a");
  return { crawl, when, ...facts! };
}

export function wrap(text: string, max: number, lines: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if ((line + ' ' + word).trim().length > max) {
      out.push(line.trim());
      line = word;
    } else line += ' ' + word;
  }
  if (line.trim()) out.push(line.trim());
  if (out.length > lines) {
    out.length = lines;
    out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return out;
}

async function renderCard(opts: { kicker: string; title: string; lines: string[]; photo: string | null }): Promise<Buffer> {
  const W = 1200;
  const H = 630;
  const photoW = 470;
  const titleLines = wrap(opts.title, 16, 3);
  const titleY = 230 - (titleLines.length - 1) * 30;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="20%" cy="100%" r="80%"><stop offset="0" stop-color="#f6b73c" stop-opacity=".35"/><stop offset="1" stop-color="#0b0b0c" stop-opacity="0"/></radialGradient>
    <linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#0b0b0c" stop-opacity="0"/><stop offset="1" stop-color="#0b0b0c" stop-opacity="1"/></linearGradient>
  </defs>
  <rect x="${opts.photo ? photoW : 0}" width="${opts.photo ? W - photoW : W}" height="${H}" fill="#0b0b0c"/>
  ${opts.photo ? `<rect x="${photoW - 120}" y="0" width="120" height="${H}" fill="url(#fade)"/>` : `<rect width="${photoW}" height="${H}" fill="url(#glow)"/>`}
  <text x="${photoW + 60}" y="${titleY - 70}" font-family="DejaVu Sans" font-size="24" font-weight="bold" letter-spacing="4" fill="#f6b73c">${esc(opts.kicker.toUpperCase())}</text>
  ${titleLines.map((l, i) => `<text x="${photoW + 60}" y="${titleY + i * 66}" font-family="DejaVu Serif" font-size="56" font-weight="bold" fill="#f5f3ee">${esc(l)}</text>`).join('')}
  ${opts.lines.map((l, i) => `<text x="${photoW + 60}" y="${titleY + titleLines.length * 66 + 30 + i * 44}" font-family="DejaVu Sans" font-size="30" fill="#c9c5bc">${esc(l)}</text>`).join('')}
  <text x="${photoW + 60}" y="${H - 56}" font-family="DejaVu Serif" font-size="44" font-weight="bold" fill="#f6b73c">Crawl</text>
</svg>`;
  const layers: sharp.OverlayOptions[] = [];
  if (opts.photo) {
    const photo = await sharp(readFileSync(opts.photo)).resize(photoW, H, { fit: 'cover' }).toBuffer();
    layers.push({ input: photo, left: 0, top: 0 });
  }
  layers.push({ input: Buffer.from(svg), left: 0, top: 0 });
  return sharp({ create: { width: W, height: H, channels: 3, background: '#0b0b0c' } })
    .composite(layers)
    .png({ compressionLevel: 9 })
    .toBuffer();
}

export async function ogRoutes(app: FastifyInstance) {
  app.get(`/og/i/:token${TOKEN_PARAM}`, async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const inv = await one('select crawl_id, revoked_at from invites where token = $1', [token]);
    reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300');
    if (!inv || inv.revoked_at) return page(GENERIC);
    const f = await crawlFacts(inv.crawl_id);
    return page({
      title: `${f.organizer} invited you: ${f.crawl.title}`,
      description: `${f.when} · ${f.stops} stops${f.first_stop ? `, starting at ${f.first_stop}` : ''} · ${f.going} going`,
      path: `/i/${token}`,
      image: `${config.apiUrl}/v1/og/image/invite/${token}.png`,
    });
  });

  app.get(`/og/crawls/:id${UUID_PARAM}`, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    reply.type('text/html; charset=utf-8').header('cache-control', 'public, max-age=300');
    const row = await one('select visibility from crawls where id = $1', [id]);
    if (!row || row.visibility !== 'public') return page(GENERIC);
    const f = await crawlFacts(id);
    return page({
      title: f.crawl.title,
      description: `Public pub crawl · ${f.when} · ${f.stops} stops${f.first_stop ? ` from ${f.first_stop}` : ''} · ${f.going} going`,
      path: `/crawls/${id}`,
      image: `${config.apiUrl}/v1/og/image/crawl/${id}.png`,
    });
  });

  const sendPng = (reply: any, png: Buffer) => reply.type('image/png').header('cache-control', 'public, max-age=600').send(png);

  app.get('/og/image/default.png', async (_req, reply) =>
    sendPng(reply, await renderCard({ kicker: 'Pub crawls, planned right', title: 'Plan the night. Bring the crew.', lines: ['Best walking route · live happy-hour alerts', 'Shared photo album'], photo: null })),
  );

  const card = async (crawlId: string, kicker: string) => {
    const f = await crawlFacts(crawlId);
    const photo = f.first_osm ? venueImagePath(f.first_osm) : null;
    return renderCard({
      kicker,
      title: f.crawl.title,
      lines: [f.when, `${f.stops} stops${f.first_stop ? ` · starts at ${f.first_stop}` : ''}`, `${f.going} going · organized by ${f.organizer}`],
      photo: photo && existsSync(photo) ? photo : null,
    });
  };

  app.get(`/og/image/invite/:token${TOKEN_PARAM}.png`, async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const inv = await one('select crawl_id, revoked_at from invites where token = $1', [token]);
    if (!inv || inv.revoked_at) return reply.redirect('/v1/og/image/default.png');
    return sendPng(reply, await card(inv.crawl_id, 'You’re invited'));
  });

  app.get(`/og/image/crawl/:id${UUID_PARAM}.png`, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await one('select visibility from crawls where id = $1', [id]);
    if (!row || row.visibility !== 'public') return reply.redirect('/v1/og/image/default.png');
    return sendPng(reply, await card(id, 'Public pub crawl'));
  });
}
