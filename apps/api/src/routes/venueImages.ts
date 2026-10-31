import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { notFound } from '../lib/errors.js';

/**
 * Curated venue cover photos, committed under data/venue-images and credited per venue
 * (venues.image_credit). Venue-claimed uploads would go to object storage instead.
 */
const DIR = fileURLToPath(new URL('../../data/venue-images/', import.meta.url));

export const venueImageFile = (osmId: string, size: 'full' | 'thumb' = 'full') => `${osmId.replace('/', '-')}${size === 'thumb' ? '-480' : ''}.jpg`;
export const venueImagePath = (osmId: string) => `${DIR}${venueImageFile(osmId)}`;

export async function venueImageRoutes(app: FastifyInstance) {
  app.get('/venue-images/:file', async (req, reply) => {
    const { file } = z.object({ file: z.string().regex(/^[a-z]+-\d+(-480)?\.jpg$/) }).parse(req.params);
    const path = `${DIR}${file}`;
    if (!existsSync(path)) throw notFound();
    reply.type('image/jpeg').header('cache-control', 'public, max-age=604800, immutable');
    return reply.send(readFileSync(path));
  });
}
