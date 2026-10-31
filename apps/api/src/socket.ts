import { createAdapter } from '@socket.io/redis-adapter';
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { ClientToServerEvents, ServerToClientEvents } from '@crawl/core';
import type { JwtUser } from './auth.js';
import { config } from './config.js';
import { one } from './db/pool.js';
import { postMessage } from './routes/social.js';
import { handlePosition } from './services/live.js';
import { redis } from './services/queue.js';
import { rooms, setIO } from './services/realtime.js';
import { getMembership } from './services/repo.js';

/** One channel per crawl (`crawl:{id}`), members only. Clients send intents; the server broadcasts state. */
export function attachSocket(app: FastifyInstance) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents, {}, { user: JwtUser }>(app.server, {
    path: '/socket.io',
    cors: { origin: config.corsOrigins, credentials: true },
  });
  io.adapter(createAdapter(redis.duplicate(), redis.duplicate()));
  setIO(io as any);

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('unauthorized'));
      socket.data.user = app.jwt.verify<JwtUser>(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const uid = socket.data.user.sub;
    socket.join(rooms.user(uid));

    socket.on('crawl.join', async (crawlId, ack) => {
      try {
        z.string().uuid().parse(crawlId);
        const m = await getMembership(crawlId, uid);
        if (!m) return ack?.({ ok: false, error: 'Members only' });
        socket.join(rooms.crawl(crawlId));
        if (m.role !== 'participant') socket.join(rooms.hosts(crawlId));
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on('crawl.leave', (crawlId) => {
      socket.leave(rooms.crawl(crawlId));
      socket.leave(rooms.hosts(crawlId));
    });

    socket.on('position.update', async (p) => {
      try {
        const body = z.object({ crawlId: z.string().uuid(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().optional() }).parse(p);
        const m = await getMembership(body.crawlId, uid);
        if (!m) return;
        const live = await one('select leader_user_id from live_state where crawl_id = $1', [body.crawlId]);
        if (live?.leader_user_id !== uid && !m.location_sharing) return;
        await handlePosition(body.crawlId, uid, body);
      } catch (err) {
        app.log.warn({ err }, 'position.update failed');
      }
    });

    socket.on('chat.send', async (p, ack) => {
      try {
        const body = z.object({ crawlId: z.string().uuid(), body: z.string() }).parse(p);
        const message = await postMessage(body.crawlId, uid, body.body);
        ack?.({ ok: true, message });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });
  });
  return io;
}
