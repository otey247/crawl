import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { runRouteJob } from './optimizer.js';
import { emitToCrawl } from './realtime.js';
import { loadPhoto } from './repo.js';
import { storage } from './storage.js';

/**
 * Slow work runs on BullMQ: route optimization (matrix + solve + LLM) and photo processing.
 * Workers run in-process by default; set INLINE_WORKERS=false and run `node dist/worker.js`
 * to scale them separately.
 */

export const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
const connection = redis;

const routeQueue = new Queue('route-optimize', { connection });
const photoQueue = new Queue('photo-process', { connection });

const jobOpts = { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 1000 } as const;

export const enqueueRoute = (routeId: string) => routeQueue.add('optimize', { routeId }, { ...jobOpts, jobId: routeId });
export const enqueuePhoto = (photoId: string) => photoQueue.add('process', { photoId }, { ...jobOpts, jobId: photoId });

/** Best-effort distributed lock for periodic ticks across API replicas. */
export async function acquireLock(key: string, ttlMs: number): Promise<boolean> {
  return (await redis.set(`lock:${key}`, '1', 'PX', Math.max(100, ttlMs), 'NX')) === 'OK';
}

/**
 * Automated moderation hook. Validates the file is a real, sane image; wire a content-safety
 * service (Azure AI Content Safety, AWS Rekognition) here to screen for unsafe content.
 */
async function moderate(meta: sharp.Metadata): Promise<{ ok: boolean; reason?: string }> {
  if (!meta.format || !['jpeg', 'png', 'webp', 'heif'].includes(meta.format)) return { ok: false, reason: 'unsupported_format' };
  if (!meta.width || !meta.height || meta.width < 50 || meta.height < 50) return { ok: false, reason: 'too_small' };
  return { ok: true };
}

export async function processPhoto(photoId: string): Promise<void> {
  const p = await one('select * from photos where id = $1', [photoId]);
  if (!p || p.status !== 'pending') return;
  const original = await storage.get(p.storage_key);
  const img = sharp(original, { failOn: 'error' });
  const meta = await img.metadata();
  const verdict = await moderate(meta);
  if (!verdict.ok) {
    await query(`update photos set status = 'hidden', hidden_reason = $2 where id = $1`, [photoId, `moderation:${verdict.reason}`]);
    return;
  }
  // .rotate() applies EXIF orientation; sharp drops all other metadata (GPS included) by default.
  const base = `crawls/${p.crawl_id}/photos/${p.id}`;
  const [thumb, medium] = await Promise.all([
    sharp(original).rotate().resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78, mozjpeg: true }).toBuffer(),
    sharp(original).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer({ resolveWithObject: true }),
  ]);
  await storage.put(`${base}/400.jpg`, thumb);
  await storage.put(`${base}/1200.jpg`, medium.data);
  await query(`update photos set status = 'ready', thumb_key = $2, medium_key = $3, width = $4, height = $5 where id = $1`, [
    photoId,
    `${base}/400.jpg`,
    `${base}/1200.jpg`,
    medium.info.width,
    medium.info.height,
  ]);
  const dto = await loadPhoto(photoId);
  if (dto) emitToCrawl(p.crawl_id, 'photo.added', dto);
}

export function startWorkers() {
  const routeWorker = new Worker('route-optimize', async (job) => runRouteJob(job.data.routeId), { connection, concurrency: 4 });
  const photoWorker = new Worker('photo-process', async (job) => processPhoto(job.data.photoId), { connection, concurrency: 4 });
  for (const w of [routeWorker, photoWorker]) w.on('failed', (job, err) => console.error(`[worker:${w.name}] job ${job?.id} failed:`, err.message));
  return [routeWorker, photoWorker];
}

export async function closeQueues() {
  await Promise.all([routeQueue.close(), photoQueue.close()]);
  redis.disconnect();
}
