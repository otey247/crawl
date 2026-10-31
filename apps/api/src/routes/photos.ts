import type { FastifyInstance } from 'fastify';
import { crc32 } from 'node:zlib';
import { z } from 'zod';
import { userId } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { UUID_PARAM } from '../lib/ids.js';
import { enqueuePhoto } from '../services/queue.js';
import { emitToCrawl } from '../services/realtime.js';
import { getCrawlRow, loadPhoto, photoDTO, requireRole } from '../services/repo.js';
import { storage } from '../services/storage.js';

const uuid = z.string().uuid();
const AUTO_HIDE_REPORTS = 3;

export async function photoRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- object storage (presigned)

  app.addContentTypeParser(/^image\/.*/, { parseAs: 'buffer', bodyLimit: config.storage.maxUploadBytes }, (_req, body, done) => done(null, body));

  app.put('/storage/*', async (req, reply) => {
    const key = decodeURIComponent((req.params as any)['*']);
    const q = z.object({ expires: z.coerce.number(), sig: z.string(), ct: z.string() }).parse(req.query);
    const contentType = req.headers['content-type'] ?? '';
    if (!q.ct.startsWith('image/') || contentType !== q.ct) throw forbidden('Content type mismatch');
    if (!storage.verify('put', key, q.expires, q.sig, q.ct)) throw forbidden('Upload URL expired or invalid');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('Empty upload');
    await storage.put(key, body);
    reply.code(200);
    return { ok: true };
  });

  app.get('/storage/*', async (req, reply) => {
    const key = decodeURIComponent((req.params as any)['*']);
    const q = z.object({ expires: z.coerce.number(), sig: z.string() }).parse(req.query);
    if (!storage.verify('get', key, q.expires, q.sig)) throw forbidden('Link expired');
    const buf = await storage.get(key).catch(() => null);
    if (!buf) throw notFound();
    reply.header('content-type', key.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
    reply.header('cache-control', 'private, max-age=3000');
    return reply.send(buf);
  });

  // ---------------------------------------------------------------- gallery

  app.post('/crawls/:id/photos::upload-url', { preHandler: app.authenticate, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    await requireRole(id, uid, 'member');
    const crawl = await getCrawlRow(id);
    if (crawl.status === 'draft') throw badRequest('The album opens once the crawl is planned');
    const body = z
      .object({
        contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
        width: z.number().int().positive().max(10000).optional(),
        height: z.number().int().positive().max(10000).optional(),
        takenAt: z.string().datetime({ offset: true }).optional(),
        stopId: uuid.nullish(),
      })
      .parse(req.body);
    // Tag the photo with the stop the group is at, unless the client says otherwise.
    const live = await one('select current_stop_id from live_state where crawl_id = $1', [id]);
    const stopId = body.stopId ?? live?.current_stop_id ?? null;
    const photo = await one(
      `insert into photos (crawl_id, uploader_id, stop_id, storage_key, width, height, taken_at)
       values ($1, $2, $3, 'pending', $4, $5, $6) returning id`,
      [id, uid, stopId, body.width ?? null, body.height ?? null, body.takenAt ?? null],
    );
    const key = `crawls/${id}/photos/${photo!.id}/original`;
    await query('update photos set storage_key = $2 where id = $1', [photo!.id, key]);
    return {
      photoId: photo!.id,
      uploadUrl: storage.presignPut(key, body.contentType),
      method: 'PUT',
      headers: { 'content-type': body.contentType },
      maxBytes: config.storage.maxUploadBytes,
      expiresInS: config.storage.uploadUrlTtlS,
    };
  });

  app.post(`/crawls/:id/photos/:photoId${UUID_PARAM}::complete`, { preHandler: app.authenticate }, async (req) => {
    const { id, photoId } = z.object({ id: uuid, photoId: uuid }).parse(req.params);
    const uid = userId(req);
    const p = await one('select * from photos where id = $1 and crawl_id = $2', [photoId, id]);
    if (!p) throw notFound('Photo not found');
    if (p.uploader_id !== uid) throw forbidden();
    if (!(await storage.size(p.storage_key))) throw badRequest('Upload not found; PUT the file first');
    await enqueuePhoto(photoId);
    return { ok: true, status: 'processing' };
  });

  app.get('/crawls/:id/photos', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    const m = await requireRole(id, uid, 'member');
    const q = z.object({ cursor: z.string().datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(60) }).parse(req.query);
    const host = m.role !== 'participant';
    const rows = await query(
      `select p.*, u.display_name, u.avatar_url, (select count(*) from photo_reports pr where pr.photo_id = p.id) as report_count
       from photos p join users u on u.id = p.uploader_id
       where p.crawl_id = $1 and (p.status = 'ready' or (p.status = 'hidden' and ($2 or p.uploader_id = $3)))
         and ($4::timestamptz is null or p.created_at < $4)
       order by p.created_at desc limit $5`,
      [id, host, uid, q.cursor ?? null, q.limit],
    );
    const items = rows.map(photoDTO);
    return { items, nextCursor: rows.length === q.limit ? rows[rows.length - 1].created_at : null };
  });

  app.delete('/crawls/:id/photos/:photoId', { preHandler: app.authenticate }, async (req) => {
    const { id, photoId } = z.object({ id: uuid, photoId: uuid }).parse(req.params);
    const uid = userId(req);
    const m = await requireRole(id, uid, 'member');
    const p = await one('select * from photos where id = $1 and crawl_id = $2', [photoId, id]);
    if (!p) throw notFound('Photo not found');
    if (p.uploader_id !== uid && m.role !== 'organizer') throw forbidden('Only the uploader or organizer can delete');
    await query('delete from photos where id = $1', [photoId]);
    await Promise.all([p.storage_key, p.thumb_key, p.medium_key].filter(Boolean).map((k: string) => storage.remove(k)));
    emitToCrawl(id, 'photo.removed', { photoId });
    return { ok: true };
  });

  /** Organizer / co-host hides (or restores) any photo. */
  app.post('/crawls/:id/photos/:photoId/visibility', { preHandler: app.authenticate }, async (req) => {
    const { id, photoId } = z.object({ id: uuid, photoId: uuid }).parse(req.params);
    await requireRole(id, userId(req), 'host');
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
    const r = await one(
      `update photos set status = $3, hidden_reason = case when $3 = 'hidden' then 'host' else null end where id = $1 and crawl_id = $2 and status <> 'pending' returning id`,
      [photoId, id, hidden ? 'hidden' : 'ready'],
    );
    if (!r) throw notFound('Photo not found');
    if (hidden) emitToCrawl(id, 'photo.removed', { photoId });
    else emitToCrawl(id, 'photo.added', (await loadPhoto(photoId))!);
    return { ok: true };
  });

  app.post('/photos/:photoId/reports', { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
    const { photoId } = z.object({ photoId: uuid }).parse(req.params);
    const uid = userId(req);
    const { reason } = z.object({ reason: z.string().trim().min(2).max(200) }).parse(req.body);
    const p = await one('select crawl_id from photos where id = $1', [photoId]);
    if (!p) throw notFound('Photo not found');
    await requireRole(p.crawl_id, uid, 'member');
    await query('insert into photo_reports (photo_id, reporter_id, reason) values ($1, $2, $3) on conflict do nothing', [photoId, uid, reason]);
    const hidden = await one(
      `update photos set status = 'hidden', hidden_reason = 'reports' where id = $1 and status = 'ready'
         and (select count(*) from photo_reports where photo_id = $1) >= $2 returning id`,
      [photoId, AUTO_HIDE_REPORTS],
    );
    if (hidden) emitToCrawl(p.crawl_id, 'photo.removed', { photoId });
    return { ok: true, hidden: !!hidden };
  });

  /** Whole album as a .zip, available after the crawl ends. */
  app.get('/crawls/:id/photos/archive', { preHandler: app.authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await requireRole(id, userId(req), 'member');
    const crawl = await getCrawlRow(id);
    if (crawl.status !== 'ended') throw badRequest('The album download opens when the crawl ends');
    const rows = await query(`select id, medium_key, storage_key, created_at from photos where crawl_id = $1 and status = 'ready' order by created_at`, [id]);
    const files: { name: string; data: Buffer }[] = [];
    for (const [i, r] of rows.entries()) {
      const data = await storage.get(r.medium_key ?? r.storage_key).catch(() => null);
      if (data) files.push({ name: `${String(i + 1).padStart(3, '0')}-${r.id.slice(0, 8)}.jpg`, data });
    }
    const safe = crawl.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'crawl';
    reply.header('content-type', 'application/zip');
    reply.header('content-disposition', `attachment; filename="${safe}-photos.zip"`);
    return reply.send(zipStore(files));
  });
}

/** Minimal ZIP writer (stored, no compression — JPEGs don't compress further). */
function zipStore(files: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const crc = crc32(f.data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(f.data.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, f.data);
    centrals.push(central, name);
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
