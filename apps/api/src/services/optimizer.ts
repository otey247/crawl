import { DateTime } from 'luxon';
import {
  distanceToPolylineM,
  evaluateOrder,
  samplePolyline,
  solve,
  specialWindows,
  type Evaluation,
  type LatLng,
  type PreferenceTag,
  type RoutePreferences,
  type SolveInput,
  type StopDTO,
} from '@crawl/core';
import { findNeighborhood, neighborhoodGeo } from '../cities/index.js';
import { one, query, tx } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';
import { hoursGuard } from './hours.js';
import { explainRoute, interpretPreferences } from './llm.js';
import { crawlMemberIds, notify } from './notify.js';
import { emitToCrawl, emitToHosts } from './realtime.js';
import { getCrawlRow, loadStops, specialRule } from './repo.js';
import { walkingLegs, walkingMatrix } from './routing.js';

export interface OptimizeRequest {
  tags: PreferenceTag[];
  note?: string | null;
  /** Evaluate this exact stop order instead of solving (organizer drag-to-reorder). */
  order?: string[] | null;
}

/** Creates a pending route row; the worker fills it in. */
export async function createRouteJob(crawlId: string, userId: string, req: OptimizeRequest): Promise<string> {
  const stops = await query('select id from crawl_stops where crawl_id = $1 and not skipped', [crawlId]);
  if (stops.length < 2) throw badRequest('Add at least two stops first');
  if (req.order) {
    const ids = new Set(stops.map((s) => s.id));
    if (req.order.length !== ids.size || !req.order.every((id) => ids.has(id))) throw badRequest('Order must contain every stop exactly once');
  }
  const row = await one(
    `insert into routes (crawl_id, status, preferences, method, created_by, metrics)
     values ($1, 'pending', $2, $3, $4, $5) returning id`,
    [crawlId, JSON.stringify({ tags: req.tags, note: req.note ?? null }), req.order ? 'manual' : null, userId, JSON.stringify({ requestedOrder: req.order ?? null })],
  );
  return row!.id;
}

/** Share of a leg on busy roads (s) and off green space (b), sampled along the straight line. */
function legShares(a: LatLng, b: LatLng, hoodId: string | null, busyAfterHours: boolean) {
  const geo = neighborhoodGeo(hoodId ?? 'soulard');
  const nightlife = busyAfterHours ? (findNeighborhood(hoodId)?.hood.nightlife ?? []) : [];
  const samples = samplePolyline([a, b], 10);
  let busy = 0;
  let green = 0;
  for (const p of samples) {
    const nearArterial = geo.arterials.some((r) => distanceToPolylineM(p, r.line) < 30);
    const nearNightlife = nightlife.some((r) => distanceToPolylineM(p, r.line.map(([lat, lng]) => ({ lat, lng }))) < 30);
    if (nearArterial) busy += 1;
    else if (nearNightlife) busy += 0.6;
    if (geo.green.some((g) => distanceToPolylineM(p, g.line) < 60)) green += 1;
  }
  return { s: busy / samples.length, b: 1 - green / samples.length };
}

export interface PreparedProblem {
  input: SolveInput;
  stops: StopDTO[];
  specialTitles: Map<string, string>;
}

export async function prepareProblem(crawlId: string, prefs: RoutePreferences): Promise<PreparedProblem> {
  const crawl = await getCrawlRow(crawlId);
  const stops = (await loadStops(crawlId, crawl.timezone)).filter((s) => !s.skipped);
  const points = stops.map((s) => ({ lat: s.venue.lat, lng: s.venue.lng }));
  const matrix = await walkingMatrix(points, prefs);
  const startAt = new Date(crawl.start_at).getTime();
  const horizonEnd = startAt + 14 * 3600_000;
  const crowdHour = findNeighborhood(crawl.neighborhood_id)?.city.crowdedAfterHour ?? 21;
  const endsAfterCrowdHour = DateTime.fromMillis(startAt + stops.reduce((t, s) => t + s.dwellMin * 60_000, 0), { zone: crawl.timezone }).hour >= crowdHour;

  const penalty = points.map((a, i) =>
    points.map((b, j) => {
      if (i === j || (prefs.alpha === 0 && prefs.beta === 0)) return 1;
      const { s, b: nb } = legShares(a, b, crawl.neighborhood_id, endsAfterCrowdHour);
      return 1 + prefs.alpha * s + prefs.beta * nb;
    }),
  );

  const specialRows = await query(
    `select * from specials where venue_id = any($1) and (crawl_id is null or crawl_id = $2)`,
    [stops.map((s) => s.venue.id), crawlId],
  );
  const visible = new Set(stops.flatMap((s) => s.venue.specials.map((sp) => sp.id)));
  const specialTitles = new Map<string, string>();
  const input: SolveInput = {
    stops: stops.map((s) => {
      const guard = hoursGuard(s.venue.openingHours, crawl.timezone);
      return {
        dwellS: s.dwellMin * 60,
        specials: specialRows
          .filter((r) => r.venue_id === s.venue.id && visible.has(r.id))
          .map((r) => {
            specialTitles.set(r.id, r.title);
            return { id: r.id, windows: specialWindows(specialRule(r), startAt, horizonEnd, crawl.timezone) };
          })
          .filter((sp) => sp.windows.length > 0),
        openFrom: guard.known ? guard.openFrom : undefined,
      };
    }),
    walkS: matrix.walkS,
    distanceM: matrix.distanceM,
    penalty,
    startAt,
    prefs,
    // A locked stop keeps its current position (stops are sorted by position).
    locked: stops.map((s, pos) => (s.locked ? pos : null)),
    timeLimitMs: 3000,
  };
  return { input, stops, specialTitles };
}

function routeMetrics(ev: Evaluation, stops: StopDTO[]) {
  return {
    stops: ev.timings.map((t) => ({
      stopId: stops[t.stop].id,
      arrival: new Date(t.arrival).toISOString(),
      departure: new Date(t.departure).toISOString(),
      waitS: t.waitS,
      caught: t.caught,
      missed: t.missed,
    })),
    caughtCount: ev.caughtCount,
    missedCount: ev.missedCount,
    violations: ev.violations,
  };
}

function totals(ev: Evaluation, stops: StopDTO[]) {
  return {
    order: ev.order.map((i) => stops[i].id),
    totalDistanceM: ev.distanceM,
    totalWalkS: ev.walkS,
    totalS: ev.totalS,
    caughtCount: ev.caughtCount,
    missedCount: ev.missedCount,
  };
}

/** Worker entry point: matrix → solve → legs → explain → store → notify. */
export async function runRouteJob(routeId: string): Promise<void> {
  const route = await one('select * from routes where id = $1', [routeId]);
  if (!route || route.status !== 'pending') return;
  const crawl = await getCrawlRow(route.crawl_id);
  try {
    const prefs = await interpretPreferences(route.preferences.tags ?? [], route.preferences.note);
    const { input, stops, specialTitles } = await prepareProblem(crawl.id, prefs);
    const requested: string[] | null = route.metrics?.requestedOrder ?? null;

    // Organizer's current order (by position) is the baseline we report deltas against.
    const baselineOrder = stops.map((_, i) => i);
    const baseline = evaluateOrder(input, baselineOrder);
    let best: Evaluation;
    let method: string;
    if (requested) {
      best = evaluateOrder(input, requested.map((id) => stops.findIndex((s) => s.id === id)));
      method = 'manual';
    } else {
      const res = solve(input);
      best = res.best;
      method = res.method;
    }

    const ordered = best.order.map((i) => stops[i]);
    const { legs, provider } = await walkingLegs(
      ordered.map((s) => ({ lat: s.venue.lat, lng: s.venue.lng })),
      prefs,
    );
    const geometry = legs.flatMap((l, i) => (i === 0 ? l.geometry : l.geometry.slice(1)));
    const fmt = (ms: number) => DateTime.fromMillis(ms, { zone: crawl.timezone }).toFormat('h:mm a');
    const explanation = await explainRoute({
      stops: best.timings.map((t) => ({
        name: stops[t.stop].venue.name,
        arrival: fmt(t.arrival),
        caught: t.caught.map((id) => specialTitles.get(id) ?? 'a special'),
        missed: t.missed.map((id) => specialTitles.get(id) ?? 'a special'),
      })),
      totalWalkMin: best.walkS / 60,
      totalDistanceKm: best.distanceM / 1000,
      totalHours: best.totalS / 3600,
      preferences: prefs,
      baseline: method === 'manual' ? null : { totalWalkMin: baseline.walkS / 60, caughtCount: baseline.caughtCount },
      caughtCount: best.caughtCount,
      violations: best.violations.length,
    });

    await tx(async (db) => {
      await db.query(`update routes set status = 'superseded' where crawl_id = $1 and status = 'proposed'`, [crawl.id]);
      await db.query(
        `update routes set status = 'proposed', stop_order = $2, geometry = $3, total_distance_m = $4, total_walk_s = $5, total_s = $6,
           preferences = $7, explanation = $8, method = $9, metrics = $10 where id = $1`,
        [
          routeId,
          ordered.map((s) => s.id),
          JSON.stringify(geometry),
          best.distanceM,
          best.walkS,
          best.totalS,
          JSON.stringify(prefs),
          explanation,
          `${method}/${provider}`,
          JSON.stringify({ ...routeMetrics(best, stops), baseline: totals(baseline, stops) }),
        ],
      );
      for (let i = 0; i < legs.length; i++) {
        await db.query(
          `insert into route_legs (route_id, seq, from_stop_id, to_stop_id, distance_m, walk_s, geometry) values ($1, $2, $3, $4, $5, $6, $7)`,
          [routeId, i, ordered[i].id, ordered[i + 1].id, legs[i].distanceM, legs[i].walkS, JSON.stringify(legs[i].geometry)],
        );
      }
    });
    emitToHosts(crawl.id, 'route.proposed', { crawlId: crawl.id, routeId, status: 'proposed' });
    await notify([route.created_by], {
      kind: 'route.proposed',
      title: 'Route ready for review',
      body: `${crawl.title}: ${(best.distanceM / 1000).toFixed(1)} km, ${Math.round(best.walkS / 60)} min walking.`,
      crawlId: crawl.id,
      data: { routeId },
      push: true,
    });
  } catch (err) {
    console.error('[optimizer]', err);
    await query(`update routes set status = 'failed', error = $2 where id = $1`, [routeId, (err as Error).message.slice(0, 500)]);
    emitToHosts(crawl.id, 'route.proposed', { crawlId: crawl.id, routeId, status: 'failed' });
  }
}

/** Approve a proposed route: reorder stops, set planned times, publish. */
export async function approveRoute(crawlId: string, routeId: string): Promise<void> {
  const route = await one('select * from routes where id = $1 and crawl_id = $2', [routeId, crawlId]);
  if (!route) throw badRequest('Unknown route');
  if (route.status !== 'proposed') throw badRequest(`Route is ${route.status}`);
  const crawl = await getCrawlRow(crawlId);
  const metrics = route.metrics?.stops ?? [];
  await tx(async (db) => {
    // Two-phase position update avoids transient duplicates.
    await db.query('update crawl_stops set position = position + 1000 where crawl_id = $1', [crawlId]);
    for (let i = 0; i < route.stop_order.length; i++) {
      const m = metrics.find((x: any) => x.stopId === route.stop_order[i]);
      await db.query('update crawl_stops set position = $2, planned_arrival_at = $3, planned_departure_at = $4 where id = $1', [
        route.stop_order[i],
        i,
        m?.arrival ?? null,
        m?.departure ?? null,
      ]);
    }
    await db.query(`update routes set status = 'superseded' where crawl_id = $1 and status = 'approved'`, [crawlId]);
    await db.query(`update routes set status = 'approved' where id = $1`, [routeId]);
    await db.query(
      `update crawls set approved_route_id = $2, status = case when status = 'draft' then 'planned' else status end, updated_at = now() where id = $1`,
      [crawlId, routeId],
    );
  });
  emitToCrawl(crawlId, 'route.approved', { crawlId, routeId, stopOrder: route.stop_order });
  const members = await crawlMemberIds(crawlId, { excludeDeclined: true });
  await notify(members, {
    kind: 'route.approved',
    title: 'Route set',
    body: `${crawl.title} has a final route: ${route.stop_order.length} stops, ${(route.total_distance_m / 1000).toFixed(1)} km.`,
    crawlId,
    data: { routeId },
    push: true,
  });
}

/** Any edit to stops invalidates the approved route's timings; drop back to needing approval. */
export async function invalidateRoute(crawlId: string): Promise<void> {
  const crawl = await getCrawlRow(crawlId);
  if (crawl.status === 'live' || crawl.status === 'ended') return;
  await query(`update routes set status = 'superseded' where crawl_id = $1 and status in ('proposed','approved')`, [crawlId]);
  await query(`update crawls set approved_route_id = null, updated_at = now() where id = $1`, [crawlId]);
}
