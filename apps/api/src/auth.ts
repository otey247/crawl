import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fjwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { config } from './config.js';
import { unauthorized } from './lib/errors.js';

export interface JwtUser {
  sub: string;
  name: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: JwtUser;
    user: JwtUser;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export const authPlugin = fp(async (app: FastifyInstance) => {
  await app.register(fjwt, { secret: config.jwtSecret, sign: { expiresIn: '30d' } });
  app.decorate('authenticate', async (req: FastifyRequest) => {
    try {
      await req.jwtVerify();
    } catch {
      throw unauthorized();
    }
  });
  app.decorate('optionalAuth', async (req: FastifyRequest) => {
    if (!req.headers.authorization) return;
    try {
      await req.jwtVerify();
    } catch {
      /* treat as anonymous */
    }
  });
});

export const userId = (req: FastifyRequest): string => {
  if (!req.user?.sub) throw unauthorized();
  return req.user.sub;
};
export const maybeUserId = (req: FastifyRequest): string | null => (req.user as JwtUser | undefined)?.sub ?? null;
