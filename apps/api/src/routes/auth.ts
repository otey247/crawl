import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MeDTO } from '@crawl/core';
import { userId } from '../auth.js';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { badRequest, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { sha256, token128 } from '../lib/ids.js';

function meDTO(r: any): MeDTO {
  return { id: r.id, displayName: r.display_name, avatarUrl: r.avatar_url, email: r.email, ageVerified: !!r.dob_verified_at };
}

export async function authRoutes(app: FastifyInstance) {
  const issue = (u: any) => ({ token: app.jwt.sign({ sub: u.id, name: u.display_name }), user: meDTO(u) });

  /** Step 1 of magic-link sign-in. In development the link is returned so no mailer is needed. */
  app.post('/auth/magic-link', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ email: z.string().email().max(200), displayName: z.string().trim().min(1).max(60).optional() }).parse(req.body);
    const token = token128();
    await query(`insert into magic_links (token_hash, email, display_name, expires_at) values ($1, lower($2), $3, now() + interval '15 minutes')`, [
      sha256(token),
      body.email,
      body.displayName ?? null,
    ]);
    const link = `${config.appUrl}/auth/verify?token=${token}`;
    if (config.isProd) {
      // Hook a transactional mailer here (SES, Postmark, ACS Email).
      req.log.info({ email: body.email }, 'magic link issued');
      return { sent: true };
    }
    req.log.info({ link }, 'magic link (dev)');
    return { sent: true, devLink: link };
  });

  /** POST /auth/session — exchanges a magic-link token (or, in dev, a seeded user id) for a JWT. */
  app.post('/auth/session', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = z
      .discriminatedUnion('provider', [
        z.object({ provider: z.literal('magic_link'), token: z.string().min(10) }),
        z.object({ provider: z.literal('dev'), userId: z.string().uuid() }),
        z.object({ provider: z.enum(['apple', 'google']), idToken: z.string() }),
      ])
      .parse(req.body);
    if (body.provider === 'magic_link') {
      const link = await one(
        `update magic_links set used_at = now() where token_hash = $1 and used_at is null and expires_at > now() returning email, display_name`,
        [sha256(body.token)],
      );
      if (!link) throw unauthorized('This sign-in link is invalid or has expired');
      const fallbackName = link.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
      const user = await one(
        `insert into users (email, display_name) values ($1, $2)
         on conflict (email) do update set display_name = coalesce(users.display_name, excluded.display_name) returning *`,
        [link.email, link.display_name ?? fallbackName],
      );
      return issue(user);
    }
    if (body.provider === 'dev') {
      if (!config.devLogin) throw forbidden('Dev sign-in is disabled');
      const user = await one('select * from users where id = $1 and is_dev_seed', [body.userId]);
      if (!user) throw notFound('Unknown dev user');
      return issue(user);
    }
    // Apple / Google: verify the ID token against the provider's JWKS, then upsert by email.
    throw badRequest(`${body.provider} sign-in is not configured on this server`, 'provider_not_configured');
  });

  app.get('/auth/dev-users', async () => {
    if (!config.devLogin) return [];
    const rows = await query('select id, display_name, avatar_url from users where is_dev_seed order by created_at');
    return rows.map((r) => ({ id: r.id, displayName: r.display_name, avatarUrl: r.avatar_url }));
  });

  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const u = await one('select * from users where id = $1', [userId(req)]);
    if (!u) throw unauthorized();
    return meDTO(u);
  });

  app.patch('/me', { preHandler: app.authenticate }, async (req) => {
    const body = z.object({ displayName: z.string().trim().min(1).max(60) }).parse(req.body);
    return meDTO(await one('update users set display_name = $2 where id = $1 returning *', [userId(req), body.displayName]));
  });

  /** Records the 21+ confirmation (US launch). */
  app.post('/me/age-verification', { preHandler: app.authenticate }, async (req) => {
    const body = z.object({ confirmedOfAge: z.literal(true), minimumAge: z.literal(21) }).parse(req.body);
    void body;
    return meDTO(await one('update users set dob_verified_at = coalesce(dob_verified_at, now()) where id = $1 returning *', [userId(req)]));
  });

  app.put('/me/push-tokens', { preHandler: app.authenticate }, async (req) => {
    const body = z.object({ token: z.string().min(10).max(300) }).parse(req.body);
    await query('update users set push_tokens = array(select distinct unnest(push_tokens || $2::text)) where id = $1', [userId(req), body.token]);
    return { ok: true };
  });
}
