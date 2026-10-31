import { DateTime } from 'luxon';
import { one, query } from '../db/pool.js';
import { notify } from './notify.js';

/**
 * Day-of nudges, each sent at most once per (crawl, user, kind):
 *   maybe_nudge  — RSVP'd Maybe, crawl starts within 24 h (and more than 2 h out)
 *   starts_soon  — Going/Maybe, crawl starts within the hour
 *   home_safe    — Going, crawl ended 60+ min ago, hasn't confirmed they got home
 */
async function claim(crawlId: string, userIds: string[], kind: string): Promise<string[]> {
  if (!userIds.length) return [];
  const rows = await query<{ user_id: string }>(
    `insert into reminders_sent (crawl_id, user_id, kind) select $1, u, $3 from unnest($2::uuid[]) u
     on conflict do nothing returning user_id`,
    [crawlId, userIds, kind],
  );
  return rows.map((r) => r.user_id);
}

export async function runReminders(): Promise<{ sent: number }> {
  let sent = 0;

  const upcoming = await query(
    `select c.id, c.title, c.start_at, c.timezone,
       (select coalesce(v.name_override, v.name) from crawl_stops s join venues v on v.id = s.venue_id where s.crawl_id = c.id order by s.position limit 1) as first_stop
     from crawls c where c.status in ('planned', 'draft') and c.start_at > now() and c.start_at < now() + interval '24 hours'`,
  );
  for (const c of upcoming) {
    const when = DateTime.fromISO(c.start_at, { zone: c.timezone });
    const minutesOut = when.diffNow('minutes').minutes;
    if (minutesOut > 120) {
      const maybes = await query<{ user_id: string }>(`select user_id from memberships where crawl_id = $1 and rsvp = 'maybe'`, [c.id]);
      const to = await claim(c.id, maybes.map((m) => m.user_id), 'maybe_nudge');
      if (to.length) {
        await notify(to, {
          kind: 'reminder.rsvp',
          title: `Still a maybe for ${c.title}?`,
          body: `It starts ${when.hasSame(DateTime.now().setZone(c.timezone), 'day') ? 'today' : 'tomorrow'} at ${when.toFormat('h:mm a')}. Let the crew know if you’re in.`,
          crawlId: c.id,
          push: true,
        });
        sent += to.length;
      }
    }
    if (minutesOut <= 60) {
      const people = await query<{ user_id: string }>(`select user_id from memberships where crawl_id = $1 and rsvp in ('going', 'maybe')`, [c.id]);
      const to = await claim(c.id, people.map((m) => m.user_id), 'starts_soon');
      if (to.length) {
        await notify(to, {
          kind: 'reminder.starts_soon',
          title: `${c.title} starts at ${when.toFormat('h:mm a')}`,
          body: c.first_stop ? `First stop: ${c.first_stop}. Plan your ride home before you head out.` : 'Plan your ride home before you head out.',
          crawlId: c.id,
          push: true,
        });
        sent += to.length;
      }
    }
  }

  const ended = await query(
    `select id, title from crawls where status = 'ended' and ended_at < now() - interval '60 minutes' and ended_at > now() - interval '12 hours'`,
  );
  for (const c of ended) {
    const notHome = await query<{ user_id: string }>(`select user_id from memberships where crawl_id = $1 and rsvp = 'going' and home_safe_at is null`, [c.id]);
    const to = await claim(c.id, notHome.map((m) => m.user_id), 'home_safe');
    if (to.length) {
      await notify(to, {
        kind: 'reminder.home_safe',
        title: 'Home safe?',
        body: `Tap to let the ${c.title} crew know you made it.`,
        crawlId: c.id,
        url: `/crawls/${c.id}?homeSafe=1`,
        push: true,
      });
      sent += to.length;
    }
  }
  return { sent };
}

export async function markHomeSafe(crawlId: string, userId: string): Promise<string> {
  const row = await one<{ home_safe_at: string }>(
    `update memberships set home_safe_at = coalesce(home_safe_at, now()) where crawl_id = $1 and user_id = $2 returning home_safe_at`,
    [crawlId, userId],
  );
  return row!.home_safe_at;
}
