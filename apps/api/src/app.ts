import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { authPlugin } from './auth.js';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { HttpError } from './lib/errors.js';
import { authRoutes } from './routes/auth.js';
import { crawlRoutes } from './routes/crawls.js';
import { liveRoutes } from './routes/live.js';
import { photoRoutes } from './routes/photos.js';
import { socialRoutes } from './routes/social.js';
import { venueRoutes } from './routes/venues.js';
import { redis } from './services/queue.js';

export async function buildApp(opts: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: opts.logger ?? { level: config.isProd ? 'info' : 'warn' },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
  });
  await app.register(cors, { origin: config.corsOrigins, credentials: true, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] });
  await app.register(rateLimit, { global: false, redis, keyGenerator: (req) => (req.headers.authorization ?? req.ip).slice(-40) });
  await app.register(authPlugin);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'validation' });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    req.log.error(err);
    return reply.code(500).send({ error: 'Something went wrong', code: 'internal' });
  });

  app.get('/healthz', async () => {
    await pool.query('select 1');
    return { ok: true };
  });

  await app.register(
    async (v1) => {
      await v1.register(authRoutes);
      await v1.register(venueRoutes);
      await v1.register(crawlRoutes);
      await v1.register(liveRoutes);
      await v1.register(photoRoutes);
      await v1.register(socialRoutes);
    },
    { prefix: '/v1' },
  );
  return app;
}
