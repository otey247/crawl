import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FriendActivityDTO, ProfileDTO, UserDTO } from '@crawl/core';
import { userId } from '../auth.js';
import { one, query } from '../db/pool.js';
import { badRequest, notFound } from '../lib/errors.js';
import { notify } from '../services/notify.js';
import { summarize, userDTO, type CrawlRow } from '../services/repo.js';

/**
 * One-way follows (Strava-style). Following someone shows you the PUBLIC crawls they organize or
 * RSVP Going to, unless they set their activity to "nobody". Private crawls never surface.
 */

const uuid = z.string().uuid();

/** In-app nudge to followers when someone shares activity on a public crawl. No push: low urgency. */
export async function notifyFollowers(actorId: string, crawlId: string, kind: 'created' | 'going') {
  const crawl = await one('select title, visibility from crawls where id = $1', [crawlId]);
  const actor = await one('select display_name, activity_visibility from users where id = $1', [actorId]);
  if (!crawl || crawl.visibility !== 'public' || actor?.activity_visibility !== 'followers') return;
  const followers = await query<{ follower_id: string }>(
    `select f.follower_id from follows f where f.followee_id = $1
       and not exists (select 1 from memberships m where m.crawl_id = $2 and m.user_id = f.follower_id)`,
    [actorId, crawlId],
  );
  await notify(
    followers.map((f) => f.follower_id),
    { kind: `friend.${kind}`, title: kind === 'created' ? `${actor.display_name} is hosting ${crawl.title}` : `${actor.display_name} is going to ${crawl.title}`, body: 'It’s a public crawl. Tap to see the plan.', crawlId },
  );
}

const upcomingPublic = (whereMember: string) => `
  select c.* from crawls c where c.visibility = 'public' and c.status in ('planned', 'live') and c.start_at > now() - interval '8 hours'
    and exists (select 1 from memberships m where m.crawl_id = c.id and ${whereMember})
  order by c.start_at limit 20`;

export async function friendRoutes(app: FastifyInstance) {
  app.post('/users/:id/follow', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    if (id === uid) throw badRequest('You can’t follow yourself');
    const target = await one('select id from users where id = $1', [id]);
    if (!target) throw notFound('User not found');
    const inserted = await one('insert into follows (follower_id, followee_id) values ($1, $2) on conflict do nothing returning followee_id', [uid, id]);
    if (inserted) await notify([id], { kind: 'friend.follow', title: `${req.user.name} started following you`, body: 'They’ll see public crawls you host or go to.', url: `/u/${uid}` });
    return { ok: true, following: true };
  });

  app.delete('/users/:id/follow', { preHandler: app.authenticate }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await query('delete from follows where follower_id = $1 and followee_id = $2', [userId(req), id]);
    return { ok: true, following: false };
  });

  app.get('/users/:id', { preHandler: app.authenticate }, async (req): Promise<ProfileDTO> => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const uid = userId(req);
    const u = await one('select id, display_name, avatar_url, activity_visibility from users where id = $1', [id]);
    if (!u) throw notFound('User not found');
    const [counts, together] = await Promise.all([
      one(
        `select (select count(*)::int from follows where followee_id = $1) as followers, (select count(*)::int from follows where follower_id = $1) as following,
           exists (select 1 from follows where follower_id = $2 and followee_id = $1) as is_following`,
        [id, uid],
      ),
      one<{ n: number }>(
        `select count(*)::int as n from memberships a join memberships b on a.crawl_id = b.crawl_id where a.user_id = $1 and b.user_id = $2 and a.user_id <> b.user_id`,
        [id, uid],
      ),
    ]);
    const hidden = u.activity_visibility === 'nobody' && id !== uid;
    const rows = hidden ? [] : await query<CrawlRow>(upcomingPublic(`m.user_id = $1 and m.rsvp = 'going'`), [id]);
    return {
      user: userDTO(u),
      followers: counts!.followers,
      following: counts!.following,
      isFollowing: counts!.is_following,
      isMe: id === uid,
      upcoming: await summarize(rows, uid),
      activityHidden: hidden,
      crawlsTogether: together!.n,
    };
  });

  app.get('/me/follows', { preHandler: app.authenticate }, async (req) => {
    const uid = userId(req);
    const [following, followers] = await Promise.all([
      query('select u.id, u.display_name, u.avatar_url from follows f join users u on u.id = f.followee_id where f.follower_id = $1 order by u.display_name', [uid]),
      query(
        `select u.id, u.display_name, u.avatar_url, exists (select 1 from follows b where b.follower_id = $1 and b.followee_id = u.id) as following_back
         from follows f join users u on u.id = f.follower_id where f.followee_id = $1 order by u.display_name`,
        [uid],
      ),
    ]);
    return { following: following.map(userDTO), followers: followers.map((r) => ({ ...userDTO(r), followingBack: r.following_back })) };
  });

  /** People you've been on crawls with and don't follow yet, most shared crawls first. */
  app.get('/me/follow-suggestions', { preHandler: app.authenticate }, async (req): Promise<(UserDTO & { crawlsTogether: number })[]> => {
    const uid = userId(req);
    const rows = await query(
      `select u.id, u.display_name, u.avatar_url, count(*)::int as together
       from memberships a join memberships b on a.crawl_id = b.crawl_id and b.user_id <> a.user_id join users u on u.id = b.user_id
       where a.user_id = $1 and not exists (select 1 from follows f where f.follower_id = $1 and f.followee_id = b.user_id)
       group by u.id order by together desc, u.display_name limit 12`,
      [uid],
    );
    return rows.map((r) => ({ ...userDTO(r), crawlsTogether: r.together }));
  });

  /** Upcoming public crawls that people you follow are hosting or going to. */
  app.get('/friends/crawls', { preHandler: app.authenticate }, async (req): Promise<FriendActivityDTO[]> => {
    const uid = userId(req);
    const rows = await query<CrawlRow>(
      upcomingPublic(
        `m.rsvp = 'going' and m.user_id in (select f.followee_id from follows f join users u on u.id = f.followee_id where f.follower_id = $1 and u.activity_visibility = 'followers')
         and not exists (select 1 from memberships mine where mine.crawl_id = c.id and mine.user_id = $1)`,
      ),
      [uid],
    );
    if (!rows.length) return [];
    const friends = await query(
      `select m.crawl_id, u.id, u.display_name, u.avatar_url from memberships m join users u on u.id = m.user_id
       join follows f on f.followee_id = u.id and f.follower_id = $2
       where m.crawl_id = any($1) and m.rsvp = 'going' and u.activity_visibility = 'followers'`,
      [rows.map((r) => r.id), uid],
    );
    const summaries = await summarize(rows, uid);
    return summaries.map((crawl) => ({ crawl, friends: friends.filter((f) => f.crawl_id === crawl.id).map(userDTO) }));
  });
}
