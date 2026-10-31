import { DateTime } from 'luxon';
import {
  classifySpecial,
  estimateWalk,
  haversineM,
  learnPace,
  pointAlong,
  polylineLengthM,
  projectSchedule,
  suggestFixes,
  type AtRiskDTO,
  type LatLng,
  type LiveSnapshot,
  type LiveSpecialDTO,
  type LiveStateDTO,
  type LiveStop,
  type MemberRole,
  type ScheduleFix,
  type SpecialState,
  type StopDTO,
} from '@crawl/core';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { hoursGuard } from './hours.js';
import { crawlMemberIds, notify } from './notify.js';
import { emitToCrawl, emitToHosts, emitToParticipants } from './realtime.js';
import { getCrawlRow, loadStops, messageDTO, specialRule, specialsForVenues, type CrawlRow } from './repo.js';

/**
 * Live crawl engine: leader position → arrival/departure geofence → ETA projection →
 * specials classification → de-duplicated alerts. The server is the source of truth;
 * clients send intents and receive `live.state` snapshots plus discrete events.
 */

interface LiveRow {
  crawl_id: string;
  current_stop_id: string | null;
  leader_user_id: string | null;
  last_lat: number | null;
  last_lng: number | null;
  last_position_at: string | null;
  near_stop_id: string | null;
  near_since: string | null;
  away_since: string | null;
  schedule_drift_s: number;
  pace_factor: number;
  special_states: Record<string, { state: SpecialState; count: number }>;
  simulating: boolean;
}

const ALERTING: SpecialState[] = ['highlight', 'at_risk', 'projected_miss'];

async function getLive(crawlId: string): Promise<LiveRow | null> {
  return one<LiveRow>('select * from live_state where crawl_id = $1', [crawlId]);
}

async function buildSnapshot(crawl: CrawlRow, stops: StopDTO[], live: LiveRow | null, now = Date.now()): Promise<LiveSnapshot> {
  const legs = crawl.approved_route_id
    ? await query('select from_stop_id, to_stop_id, walk_s from route_legs where route_id = $1', [crawl.approved_route_id])
    : [];
  const legWalk = (from: StopDTO, to: StopDTO) =>
    legs.find((l) => l.from_stop_id === from.id && l.to_stop_id === to.id)?.walk_s ??
    estimateWalk({ lat: from.venue.lat, lng: from.venue.lng }, { lat: to.venue.lat, lng: to.venue.lng }).walkS;
  const byId = new Map(stops.map((s) => [s.id, s]));
  let prev: StopDTO | null = null;
  const liveStops: LiveStop[] = stops.map((s) => {
    const ls: LiveStop = {
      id: s.id,
      location: { lat: s.venue.lat, lng: s.venue.lng },
      dwellS: s.dwellMin * 60,
      legWalkS: prev && !s.skipped ? legWalk(prev, s) : 0,
      arrivedAt: s.arrivedAt ? Date.parse(s.arrivedAt) : null,
      departedAt: s.departedAt ? Date.parse(s.departedAt) : null,
      skipped: s.skipped,
    };
    if (!s.skipped) prev = s;
    return ls;
  });
  return {
    stops: liveStops,
    now,
    // A crawl started early counts from when it actually went live.
    startAt: Math.min(Date.parse(crawl.start_at), crawl.started_at ? Date.parse(crawl.started_at) : Infinity),
    position: live?.last_lat != null ? { lat: live.last_lat, lng: live.last_lng! } : null,
    paceFactor: learnPace(liveStops),
    walkBetween: (a, b) => legWalk(byId.get(a)!, byId.get(b)!),
  };
}

interface Computed {
  dto: LiveStateDTO;
  evaluations: (LiveSpecialDTO & { key: string })[];
  snapshot: LiveSnapshot;
  stops: StopDTO[];
}

async function compute(crawlId: string, includeFixes: boolean): Promise<Computed> {
  const crawl = await getCrawlRow(crawlId);
  const stops = await loadStops(crawlId, crawl.timezone);
  const live = await getLive(crawlId);
  const now = Date.now();
  const snapshot = await buildSnapshot(crawl, stops, live, now);
  const projection = projectSchedule(snapshot);
  const specialRows = await specialsForVenues(stops.map((s) => s.venue.id), crawlId);
  const names = Object.fromEntries(stops.map((s) => [s.id, s.venue.name]));

  const evaluations: Computed['evaluations'] = [];
  for (const p of projection) {
    const stop = stops.find((s) => s.id === p.stopId)!;
    const guard = hoursGuard(stop.venue.openingHours, crawl.timezone);
    const distanceM = snapshot.position ? haversineM(snapshot.position, { lat: stop.venue.lat, lng: stop.venue.lng }) : null;
    for (const r of specialRows.filter((x) => x.venue_id === stop.venue.id)) {
      const ev = classifySpecial({
        rule: specialRule(r),
        tz: crawl.timezone,
        now,
        crawlStartAt: snapshot.startAt,
        stop: p,
        distanceM,
        isOpenAt: guard.known ? guard.isOpenAt : undefined,
      });
      evaluations.push({
        key: `${stop.id}:${r.id}`,
        stopId: stop.id,
        specialId: r.id,
        venueName: stop.venue.name,
        title: r.title,
        details: r.details,
        state: ev.state,
        endsAt: ev.endsAt ? new Date(ev.endsAt).toISOString() : null,
        eta: Number.isFinite(p.eta) ? new Date(p.eta).toISOString() : null,
        minutesShort: ev.minutesShort != null ? Math.round(ev.minutesShort) : null,
        hoursUnverified: ev.hoursUnverified,
        source: r.source,
      });
    }
  }

  const atRisk: AtRiskDTO[] = includeFixes
    ? evaluations
        .filter((e) => e.state === 'at_risk' || e.state === 'projected_miss')
        .map(({ key: _k, ...e }) => ({ ...e, fixes: suggestFixes(snapshot, e.stopId, Date.parse(e.endsAt!), names) }))
    : [];

  const current = projection.find((p) => p.phase === 'current');
  const next = projection.find((p) => p.phase === 'next');
  const planned = stops.find((s) => s.id === next?.stopId)?.plannedArrivalAt;
  // A crawl that went live early is measured against its plan shifted to the actual start.
  const earlyShiftMs = crawl.started_at ? Math.min(0, Date.parse(crawl.started_at) - Date.parse(crawl.start_at)) : 0;
  const driftS = next && planned ? (next.eta - (Date.parse(planned) + earlyShiftMs)) / 1000 : (live?.schedule_drift_s ?? 0);

  return {
    snapshot,
    stops,
    evaluations,
    dto: {
      currentStopId: current?.stopId ?? null,
      leaderUserId: live?.leader_user_id ?? null,
      position: live?.last_lat != null ? { lat: live.last_lat, lng: live.last_lng!, at: live.last_position_at! } : null,
      driftS,
      paceFactor: snapshot.paceFactor ?? 1,
      schedule: projection.map((p) => ({
        stopId: p.stopId,
        phase: p.phase,
        eta: Number.isFinite(p.eta) ? new Date(p.eta).toISOString() : null,
        departure: Number.isFinite(p.departure) ? new Date(p.departure).toISOString() : null,
      })),
      specials: evaluations.map(({ key: _k, ...e }) => e),
      atRisk,
      simulating: live?.simulating ?? false,
    },
  };
}

export async function liveStateFor(crawlId: string, role: MemberRole | null): Promise<LiveStateDTO> {
  const { dto } = await compute(crawlId, role === 'organizer' || role === 'co_host');
  return dto;
}

/** Re-evaluate, alert on stable state changes, broadcast. */
export async function evaluateLive(crawlId: string): Promise<void> {
  const crawl = await getCrawlRow(crawlId);
  if (crawl.status !== 'live') return;
  const live = await getLive(crawlId);
  const { dto, evaluations } = await compute(crawlId, true);
  const prevStates = live?.special_states ?? {};
  const nextStates: LiveRow['special_states'] = {};
  const toAlert: (typeof evaluations)[number][] = [];
  for (const e of evaluations) {
    const prev = prevStates[e.key];
    const count = prev?.state === e.state ? prev.count + 1 : 1;
    nextStates[e.key] = { state: e.state, count };
    // Two consecutive evaluations in the same state before alerting (GPS jitter guard).
    if (count >= 2 && ALERTING.includes(e.state)) toAlert.push(e);
  }
  await query('update live_state set special_states = $2, schedule_drift_s = $3, pace_factor = $4, updated_at = now() where crawl_id = $1', [
    crawlId,
    JSON.stringify(nextStates),
    dto.driftS,
    dto.paceFactor,
  ]);

  // Hosts get the fixes; everyone else gets the same state without them.
  emitToParticipants(crawlId, 'live.state', { crawlId, live: { ...dto, atRisk: [] } });
  emitToHosts(crawlId, 'live.state', { crawlId, live: dto });
  emitToCrawl(crawlId, 'schedule.updated', { stops: dto.schedule });

  for (const e of toAlert) {
    const kind = e.state === 'highlight' ? 'highlight' : e.state === 'at_risk' ? 'at_risk' : 'missed';
    const inserted = await one(
      `insert into special_alerts (crawl_id, stop_id, special_id, kind) values ($1, $2, $3, $4)
       on conflict (crawl_id, special_id, kind) do nothing returning id`,
      [crawlId, e.stopId, e.specialId, kind],
    );
    if (!inserted) continue;
    const { key: _k, ...payload } = e;
    const endsAt = e.endsAt ? DateTime.fromISO(e.endsAt, { zone: crawl.timezone }).toFormat('h:mm a') : '';
    const risk = dto.atRisk.find((r) => r.specialId === e.specialId && r.stopId === e.stopId);
    if (kind === 'highlight') {
      emitToCrawl(crawlId, 'special.highlight', payload);
      await notify(await crawlMemberIds(crawlId, { excludeDeclined: true }), {
        kind: 'special.highlight',
        title: `${e.title} at ${e.venueName}`,
        body: `Live when you arrive — runs until ${endsAt}.`,
        crawlId,
        data: { stopId: e.stopId, specialId: e.specialId },
        push: true,
      });
    } else if (kind === 'at_risk') {
      if (risk) emitToHosts(crawlId, 'special.at_risk', risk);
      await notify(await crawlMemberIds(crawlId, { hostsOnly: true }), {
        kind: 'special.at_risk',
        title: `At risk: ${e.title}`,
        body: `${e.venueName}'s special ends at ${endsAt}; the group is projected to arrive with under 10 min to spare.${risk?.fixes[0] ? ` Suggested: ${risk.fixes[0].label}.` : ''}`,
        crawlId,
        data: { stopId: e.stopId, specialId: e.specialId },
        push: true,
      });
    } else {
      emitToCrawl(crawlId, 'special.missed', payload);
      if (risk) emitToHosts(crawlId, 'special.at_risk', risk);
      const members = await crawlMemberIds(crawlId, { excludeDeclined: true });
      await notify(members, {
        kind: 'special.missed',
        title: `Heads up: ${e.title} ends at ${endsAt}`,
        body: `At the current pace the group reaches ${e.venueName} about ${e.minutesShort ?? '?'} min after it ends.`,
        crawlId,
        data: { stopId: e.stopId, specialId: e.specialId },
        push: true,
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

export async function systemMessage(crawlId: string, body: string) {
  const row = await one(`insert into messages (crawl_id, body, kind) values ($1, $2, 'system') returning *`, [crawlId, body]);
  emitToCrawl(crawlId, 'chat.message', messageDTO(row));
}

export async function startCrawl(crawlId: string, userId: string): Promise<void> {
  const crawl = await getCrawlRow(crawlId);
  if (crawl.status === 'live') return;
  if (crawl.status === 'ended') throw badRequest('This crawl has ended');
  const stops = await query('select id from crawl_stops where crawl_id = $1', [crawlId]);
  if (stops.length === 0) throw badRequest('Add stops before going live');
  await tx(async (db) => {
    await db.query(`update crawls set status = 'live', started_at = now(), updated_at = now() where id = $1`, [crawlId]);
    await db.query(
      `insert into live_state (crawl_id, leader_user_id) values ($1, $2)
       on conflict (crawl_id) do update set leader_user_id = excluded.leader_user_id, updated_at = now()`,
      [crawlId, crawl.organizer_id ?? userId],
    );
  });
  await systemMessage(crawlId, 'The crawl is live. Have fun and look out for each other.');
  emitToCrawl(crawlId, 'crawl.updated', { crawlId });
  await notify(await crawlMemberIds(crawlId, { excludeDeclined: true }), {
    kind: 'crawl.live',
    title: `${crawl.title} is live`,
    body: 'Open the crawl to follow the group and the next stop’s specials.',
    crawlId,
    push: true,
  });
  await evaluateLive(crawlId);
}

export async function endCrawl(crawlId: string): Promise<void> {
  const crawl = await getCrawlRow(crawlId);
  if (crawl.status === 'ended') return;
  await tx(async (db) => {
    await db.query(`update crawl_stops set departed_at = now() where crawl_id = $1 and arrived_at is not null and departed_at is null`, [crawlId]);
    await db.query(`update crawls set status = 'ended', ended_at = now(), updated_at = now() where id = $1`, [crawlId]);
    await db.query(`update live_state set simulating = false, current_stop_id = null where crawl_id = $1`, [crawlId]);
    // Individual location sharing switches off automatically when the crawl ends.
    await db.query(`update memberships set location_sharing = false where crawl_id = $1`, [crawlId]);
  });
  const photoCount = Number((await one(`select count(*) as n from photos where crawl_id = $1 and status = 'ready'`, [crawlId]))!.n);
  const endedAt = new Date().toISOString();
  await systemMessage(crawlId, 'That’s a wrap. Your check-ins are saved to Visited History.');
  emitToCrawl(crawlId, 'crawl.ended', { endedAt, photoCount });
  await notify(await crawlMemberIds(crawlId, { excludeDeclined: true }), {
    kind: 'crawl.ended',
    title: `${crawl.title} has ended`,
    body: `${photoCount} photo${photoCount === 1 ? '' : 's'} in the album. Your visited bars are in your profile.`,
    crawlId,
    push: true,
  });
}

export async function markArrived(crawlId: string, stopId: string, at = new Date()): Promise<void> {
  const crawl = await getCrawlRow(crawlId);
  if (crawl.status !== 'live') throw badRequest('Crawl is not live');
  const stop = await one('select * from crawl_stops where id = $1 and crawl_id = $2', [stopId, crawlId]);
  if (!stop) throw badRequest('Unknown stop');
  if (stop.arrived_at) return;
  await tx(async (db) => {
    // Leaving wherever we were.
    await db.query(`update crawl_stops set departed_at = $2 where crawl_id = $1 and arrived_at is not null and departed_at is null`, [crawlId, at]);
    await db.query(`update crawl_stops set arrived_at = $2, skipped = false where id = $1`, [stopId, at]);
    await db.query(`update live_state set current_stop_id = $2, near_stop_id = null, near_since = null, away_since = null where crawl_id = $1`, [crawlId, stopId]);
  });
  const driftS = stop.planned_arrival_at ? (at.getTime() - Date.parse(stop.planned_arrival_at)) / 1000 : 0;
  emitToCrawl(crawlId, 'stop.arrived', { stopId, arrivedAt: at.toISOString(), driftS });
  const venue = await one(`select coalesce(name_override, name) as name from venues where id = $1`, [stop.venue_id]);
  await systemMessage(crawlId, `Arrived at ${venue!.name}. Tap Check in to add it to your history.`);
  await notify(await crawlMemberIds(crawlId, { excludeDeclined: true }), {
    kind: 'stop.arrived',
    title: `At ${venue!.name}`,
    body: 'Check in to save it to your Visited History.',
    crawlId,
    data: { stopId },
    push: true,
  });
  await evaluateLive(crawlId);
}

export async function markDeparted(crawlId: string, at = new Date()): Promise<void> {
  const live = await getLive(crawlId);
  if (!live?.current_stop_id) return;
  const stopId = live.current_stop_id;
  await query(`update crawl_stops set departed_at = $2 where id = $1`, [stopId, at]);
  await query(`update live_state set current_stop_id = null, away_since = null where crawl_id = $1`, [crawlId]);
  const { dto } = await compute(crawlId, false);
  const next = dto.schedule.find((s) => s.phase === 'next');
  emitToCrawl(crawlId, 'stop.departed', { stopId, departedAt: at.toISOString(), nextStopId: next?.stopId ?? null, eta: next?.eta ?? null });
  await evaluateLive(crawlId);
}

/** Leader position update. Throttled; drives the 40 m / 2 min geofence. */
export async function handlePosition(crawlId: string, userId: string, pos: LatLng & { accuracyM?: number }, at = new Date(), opts: { force?: boolean } = {}): Promise<void> {
  const live = await getLive(crawlId);
  if (!live) throw badRequest('Crawl is not live');
  if (live.leader_user_id !== userId && !opts.force) {
    // Opted-in individual sharing is logged but does not move "the group".
    await query('insert into position_log (crawl_id, user_id, lat, lng, accuracy_m, at) values ($1,$2,$3,$4,$5,$6)', [crawlId, userId, pos.lat, pos.lng, pos.accuracyM ?? null, at]);
    return;
  }
  await query('insert into position_log (crawl_id, user_id, lat, lng, accuracy_m, at) values ($1,$2,$3,$4,$5,$6)', [crawlId, userId, pos.lat, pos.lng, pos.accuracyM ?? null, at]);
  await query('update live_state set last_lat = $2, last_lng = $3, last_position_at = $4 where crawl_id = $1', [crawlId, pos.lat, pos.lng, at]);
  emitToCrawl(crawlId, 'group.position', { lat: pos.lat, lng: pos.lng, at: at.toISOString(), currentStopId: live.current_stop_id });

  const radius = config.live.arrivalRadiusM;
  const holdMs = config.live.arrivalDwellS * 1000;
  const stops = await query(
    `select s.id, s.arrived_at, s.departed_at, s.skipped, v.lat, v.lng from crawl_stops s join venues v on v.id = s.venue_id
     where s.crawl_id = $1 order by s.position`,
    [crawlId],
  );
  if (live.current_stop_id) {
    const cur = stops.find((s) => s.id === live.current_stop_id)!;
    const away = haversineM(pos, cur) > radius;
    if (!away) {
      if (live.away_since) await query('update live_state set away_since = null where crawl_id = $1', [crawlId]);
    } else if (!live.away_since) {
      await query('update live_state set away_since = $2 where crawl_id = $1', [crawlId, at]);
    } else if (at.getTime() - Date.parse(live.away_since) >= holdMs) {
      await markDeparted(crawlId, new Date(Date.parse(live.away_since)));
      return;
    }
  } else {
    const next = stops.find((s) => !s.arrived_at && !s.skipped);
    if (next && haversineM(pos, next) <= radius) {
      if (live.near_stop_id !== next.id) {
        await query('update live_state set near_stop_id = $2, near_since = $3 where crawl_id = $1', [crawlId, next.id, at]);
      } else if (at.getTime() - Date.parse(live.near_since!) >= holdMs) {
        await markArrived(crawlId, next.id, new Date(Date.parse(live.near_since!)));
        return;
      }
    } else if (live.near_stop_id) {
      await query('update live_state set near_stop_id = null, near_since = null where crawl_id = $1', [crawlId]);
    }
  }

  // Engine recomputes at most every 30 s on position updates.
  const last = lastEval.get(crawlId) ?? 0;
  if (opts.force || Date.now() - last >= config.live.positionThrottleS * 1000) {
    lastEval.set(crawlId, Date.now());
    await evaluateLive(crawlId);
  }
}
const lastEval = new Map<string, number>();

export async function applyFix(crawlId: string, fix: ScheduleFix['patch'], actorName: string): Promise<void> {
  const crawl = await getCrawlRow(crawlId);
  if (crawl.status !== 'live') throw badRequest('Crawl is not live');
  let summary = '';
  if (fix.kind === 'cut_dwell') {
    await query('update crawl_stops set dwell_min = $3 where id = $1 and crawl_id = $2', [fix.stopId, crawlId, Math.round(fix.dwellS / 60)]);
    const v = await one(`select coalesce(v.name_override, v.name) as name from crawl_stops s join venues v on v.id = s.venue_id where s.id = $1`, [fix.stopId]);
    summary = `shortened the stay at ${v?.name} to ${Math.round(fix.dwellS / 60)} min`;
  } else if (fix.kind === 'skip_stop') {
    await query('update crawl_stops set skipped = true where id = $1 and crawl_id = $2 and arrived_at is null', [fix.stopId, crawlId]);
    const v = await one(`select coalesce(v.name_override, v.name) as name from crawl_stops s join venues v on v.id = s.venue_id where s.id = $1`, [fix.stopId]);
    summary = `skipped ${v?.name}`;
  } else {
    const existing = await query('select id from crawl_stops where crawl_id = $1', [crawlId]);
    if (fix.order.length !== existing.length || !existing.every((s) => fix.order.includes(s.id))) throw badRequest('Order must include every stop');
    await tx(async (db) => {
      await db.query('update crawl_stops set position = position + 1000 where crawl_id = $1', [crawlId]);
      for (let i = 0; i < fix.order.length; i++) await db.query('update crawl_stops set position = $2 where id = $1', [fix.order[i], i]);
    });
    summary = 'moved the next stop forward';
  }
  await systemMessage(crawlId, `${actorName} ${summary} to catch a special.`);
  emitToCrawl(crawlId, 'crawl.updated', { crawlId });
  lastEval.set(crawlId, Date.now());
  await evaluateLive(crawlId);
}

export async function setSkipped(crawlId: string, stopId: string, skipped: boolean) {
  await query('update crawl_stops set skipped = $3 where id = $1 and crawl_id = $2 and arrived_at is null', [stopId, crawlId, skipped]);
  emitToCrawl(crawlId, 'crawl.updated', { crawlId });
  await evaluateLive(crawlId);
}

// ---------------------------------------------------------------------------------------------
// Walk simulator (dev + demos): moves the leader along the approved route at `speed`×.

const SIM_STEP_MS = 3000;
const simSpeed = new Map<string, number>();

export async function setSimulation(crawlId: string, on: boolean, speed = 6) {
  simSpeed.set(crawlId, speed);
  await query('update live_state set simulating = $2 where crawl_id = $1', [crawlId, on]);
  await evaluateLive(crawlId);
}

async function simStep(crawlId: string) {
  const crawl = await getCrawlRow(crawlId);
  const live = await getLive(crawlId);
  if (!live?.leader_user_id) return;
  const speed = simSpeed.get(crawlId) ?? 6;
  const stops = await loadStops(crawlId, crawl.timezone);
  const current = stops.find((s) => s.id === live.current_stop_id);
  if (current) {
    // Dwell compressed by the same factor.
    if (Date.now() - Date.parse(current.arrivedAt!) >= (current.dwellMin * 60_000) / speed) await markDeparted(crawlId);
    return;
  }
  const idx = stops.findIndex((s) => !s.arrivedAt && !s.skipped);
  if (idx < 0) {
    await query('update live_state set simulating = false where crawl_id = $1', [crawlId]);
    return;
  }
  const target = stops[idx];
  const from = [...stops.slice(0, idx)].reverse().find((s) => !s.skipped && s.arrivedAt);
  const leg = crawl.approved_route_id && from
    ? await one('select geometry from route_legs where route_id = $1 and from_stop_id = $2 and to_stop_id = $3', [crawl.approved_route_id, from.id, target.id])
    : null;
  const line: LatLng[] = leg?.geometry?.length
    ? leg.geometry.map(([lng, lat]: [number, number]) => ({ lat, lng }))
    : [live.last_lat != null ? { lat: live.last_lat, lng: live.last_lng! } : { lat: target.venue.lat - 0.0015, lng: target.venue.lng }, { lat: target.venue.lat, lng: target.venue.lng }];
  const total = polylineLengthM(line);
  const startedAt = from?.departedAt ? Date.parse(from.departedAt) : Date.parse(live.last_position_at ?? new Date().toISOString());
  const walked = ((Date.now() - startedAt) / 1000) * 1.35 * speed;
  const pos = pointAlong(line, Math.min(total, walked));
  await handlePosition(crawlId, live.leader_user_id, pos, new Date(), { force: true });
  if (walked >= total) await markArrived(crawlId, target.id);
}

// ---------------------------------------------------------------------------------------------
// Background ticks

let ticking = false;
export function startLiveTicker(acquireLock: (key: string, ttlMs: number) => Promise<boolean>) {
  setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      if (!(await acquireLock('tick:live', config.live.tickS * 1000 - 500))) return;
      const crawls = await query(`select id from crawls where status = 'live'`);
      for (const c of crawls) await evaluateLive(c.id).catch((e) => console.error('[live tick]', e));
      // 24 h raw-position retention after a crawl ends.
      await query(`delete from position_log where crawl_id in (select id from crawls where status = 'ended' and ended_at < now() - interval '24 hours')`);
      await query(`update live_state set last_lat = null, last_lng = null where crawl_id in (select id from crawls where status = 'ended' and ended_at < now() - interval '24 hours') and last_lat is not null`);
    } finally {
      ticking = false;
    }
  }, config.live.tickS * 1000);

  setInterval(async () => {
    if (!(await acquireLock('tick:sim', SIM_STEP_MS - 200))) return;
    const sims = await query(`select l.crawl_id from live_state l join crawls c on c.id = l.crawl_id where l.simulating and c.status = 'live'`);
    for (const s of sims) await simStep(s.crawl_id).catch((e) => console.error('[sim]', e));
  }, SIM_STEP_MS);
}
