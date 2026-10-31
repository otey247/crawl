import { estimateWalk, haversineM } from './geo.js';
import { MIN, specialWindows, windowAt } from './time.js';
import type { LatLng, SpecialRule, SpecialState, TimeWindow } from './types.js';

/** A stop in the approved order, plus what has actually happened at it. */
export interface LiveStop {
  id: string;
  location: LatLng;
  dwellS: number;
  /** Planned walk from the previous stop in this order (0 for the first). */
  legWalkS: number;
  arrivedAt?: number | null;
  departedAt?: number | null;
  skipped?: boolean;
}

export interface LiveSnapshot {
  stops: LiveStop[];
  now: number;
  startAt: number;
  /** Last known group (leader) position. */
  position?: LatLng | null;
  /** Actual / planned walking time, learned from completed legs. */
  paceFactor?: number;
  /** Walking seconds between two stops by id, for re-ordering fixes. Falls back to an estimate. */
  walkBetween?: (fromId: string, toId: string) => number;
}

export type StopPhase = 'visited' | 'current' | 'next' | 'upcoming' | 'skipped';

export interface ProjectedStop {
  stopId: string;
  phase: StopPhase;
  eta: number;
  departure: number;
}

/** Ratio of actual to planned walking time over completed legs, clamped to a sane range. */
export function learnPace(stops: LiveStop[]): number {
  const active = stops.filter((s) => !s.skipped);
  let planned = 0;
  let actual = 0;
  for (let i = 1; i < active.length; i++) {
    const prev = active[i - 1];
    const cur = active[i];
    if (prev.departedAt && cur.arrivedAt && cur.legWalkS > 60) {
      planned += cur.legWalkS;
      actual += (cur.arrivedAt - prev.departedAt) / 1000;
    }
  }
  if (planned === 0) return 1;
  return Math.min(1.8, Math.max(0.7, actual / planned));
}

/**
 * Re-projects arrival and departure times for every stop.
 * Next stop: now + remaining share of the leg × pace. Later stops chain dwell + legs.
 * A stop the group is at counts its dwell from the actual arrival.
 */
export function projectSchedule(snap: LiveSnapshot): ProjectedStop[] {
  const pace = snap.paceFactor ?? learnPace(snap.stops);
  const out: ProjectedStop[] = [];
  const active = snap.stops.filter((s) => !s.skipped);
  const currentIdx = active.findIndex((s) => s.arrivedAt && !s.departedAt);
  const firstPending = active.findIndex((s) => !s.arrivedAt);

  let clock = snap.now;
  let nextAssigned = false;
  let prevActive: LiveStop | null = null;
  for (const stop of snap.stops) {
    if (stop.skipped) {
      out.push({ stopId: stop.id, phase: 'skipped', eta: NaN, departure: NaN });
      continue;
    }
    const idx = active.indexOf(stop);
    if (stop.arrivedAt && stop.departedAt) {
      out.push({ stopId: stop.id, phase: 'visited', eta: stop.arrivedAt, departure: stop.departedAt });
      clock = Math.max(snap.now, stop.departedAt);
    } else if (idx === currentIdx) {
      const departure = Math.max(snap.now, stop.arrivedAt! + stop.dwellS * 1000);
      out.push({ stopId: stop.id, phase: 'current', eta: stop.arrivedAt!, departure });
      clock = departure;
    } else {
      let eta: number;
      if (idx === firstPending && currentIdx < 0) {
        // In transit towards this stop (or the crawl has not started yet).
        if (snap.now < snap.startAt && !prevActive?.departedAt) {
          eta = snap.startAt + (idx > 0 ? stop.legWalkS * 1000 : 0);
        } else if (prevActive?.departedAt) {
          eta = snap.now + remainingWalkS(stop, prevActive, snap, pace) * 1000;
        } else if (snap.position) {
          eta = snap.now + estimateWalk(snap.position, stop.location).walkS * pace * 1000;
        } else {
          eta = Math.max(snap.now, snap.startAt);
        }
      } else {
        eta = clock + stop.legWalkS * pace * 1000;
      }
      const phase: StopPhase = nextAssigned ? 'upcoming' : 'next';
      nextAssigned = true;
      const departure = eta + stop.dwellS * 1000;
      out.push({ stopId: stop.id, phase, eta, departure });
      clock = departure;
    }
    prevActive = stop;
  }
  return out;
}

function remainingWalkS(stop: LiveStop, prev: LiveStop, snap: LiveSnapshot, pace: number): number {
  const planned = stop.legWalkS * pace;
  if (snap.position) {
    const total = haversineM(prev.location, stop.location);
    const left = haversineM(snap.position, stop.location);
    const fraction = total > 0 ? Math.min(1, Math.max(0, left / total)) : 0;
    return planned * fraction;
  }
  return Math.max(0, planned - (snap.now - prev.departedAt!) / 1000);
}

export interface SpecialEvaluation {
  state: SpecialState;
  window: TimeWindow | null;
  /** End of the relevant window — what the UI counts down to. */
  endsAt: number | null;
  /** Minutes the group would arrive after (`> 0`) or before the cut-off. */
  minutesShort: number | null;
  hoursUnverified: boolean;
}

export const HIGHLIGHT_LEAD_MIN = 10;
export const NEAR_STOP_M = 400;

export interface ClassifyInput {
  rule: SpecialRule;
  tz: string;
  now: number;
  crawlStartAt: number;
  stop: ProjectedStop;
  /** Distance from the group to the stop, metres, if known. */
  distanceM?: number | null;
  /** Opening-hours guard. `undefined` = hours unknown. */
  isOpenAt?: (t: number) => boolean | undefined;
}

/** Classifies one special at one stop against the projected arrival. See the spec's state table. */
export function classifySpecial(input: ClassifyInput): SpecialEvaluation {
  const { rule, tz, now, stop, crawlStartAt } = input;
  const openAt = (t: number) => input.isOpenAt?.(t);
  const hoursUnverified = input.isOpenAt === undefined || openAt(stop.eta) === undefined;
  const result = (state: SpecialState, window: TimeWindow | null, minutesShort: number | null = null): SpecialEvaluation => ({
    state,
    window,
    endsAt: window?.end ?? null,
    minutesShort,
    hoursUnverified,
  });

  if (stop.phase === 'skipped') return result('unavailable', null);

  if (stop.phase === 'visited' || stop.phase === 'current') {
    const stayEnd = stop.phase === 'current' ? Math.max(now, stop.eta) : stop.departure;
    const overlapping = specialWindows(rule, stop.eta, stayEnd, tz).filter((w) => w.start < stayEnd && w.end > stop.eta);
    if (stop.phase === 'current') {
      const live = windowAt(rule, now, tz);
      if (live && openAt(now) !== false) return result('highlight', live);
    }
    if (overlapping.length) return result('caught', overlapping[0]);
    const earlier = specialWindows(rule, crawlStartAt, stop.eta, tz).filter((w) => w.end > crawlStartAt && w.end <= stop.eta);
    return earlier.length ? result('missed', earlier[earlier.length - 1]) : result('unavailable', null);
  }

  const eta = stop.eta;
  const atEta = windowAt(rule, eta, tz);
  if (atEta && openAt(eta) !== false) {
    const leadMin = (atEta.end - eta) / MIN;
    if (leadMin < HIGHLIGHT_LEAD_MIN) return result('at_risk', atEta, HIGHLIGHT_LEAD_MIN - leadMin);
    const near = stop.phase === 'next' || (input.distanceM != null && input.distanceM <= NEAR_STOP_M);
    return result(near ? 'highlight' : 'on_track', atEta);
  }

  // Not live at the ETA: is there a window during the crawl that ends before we get there?
  const before = specialWindows(rule, Math.min(now, crawlStartAt), eta, tz).filter((w) => w.end <= eta && w.end > crawlStartAt);
  if (before.length) {
    const w = before[before.length - 1];
    if (now < w.end) return result('projected_miss', w, (eta - w.end) / MIN);
    return result('missed', w);
  }
  return result('unavailable', null);
}

export type FixKind = 'cut_dwell' | 'swap_forward' | 'skip_stop';

export interface ScheduleFix {
  kind: FixKind;
  label: string;
  /** How much earlier the at-risk stop is reached. */
  minutesSaved: number;
  /** Whether the special is caught (with the 10-minute buffer) after applying. */
  catchesSpecial: boolean;
  patch:
    | { kind: 'cut_dwell'; stopId: string; dwellS: number }
    | { kind: 'swap_forward'; order: string[] }
    | { kind: 'skip_stop'; stopId: string };
}

/**
 * The three one-tap fixes for an at-risk special at `targetId` whose window ends at `endsAt`.
 * Each is evaluated by re-projecting the schedule; the best one comes first.
 */
export function suggestFixes(snap: LiveSnapshot, targetId: string, endsAt: number, names: Record<string, string> = {}): ScheduleFix[] {
  const base = projectSchedule(snap).find((p) => p.stopId === targetId);
  if (!base) return [];
  const pace = snap.paceFactor ?? learnPace(snap.stops);
  const walk = (a: LiveStop, b: LiveStop) => snap.walkBetween?.(a.id, b.id) ?? estimateWalk(a.location, b.location).walkS;
  const deadline = endsAt - HIGHLIGHT_LEAD_MIN * MIN;
  const etaOf = (stops: LiveStop[]) => projectSchedule({ ...snap, stops, paceFactor: pace }).find((p) => p.stopId === targetId)!.eta;
  const fixes: ScheduleFix[] = [];
  const pending = snap.stops.filter((s) => !s.skipped && !s.departedAt);
  const current = pending.find((s) => s.arrivedAt);
  const targetPos = snap.stops.findIndex((s) => s.id === targetId);
  const name = (id: string) => names[id] ?? 'this stop';

  // 1. Cut dwell at the current stop (or the stop just before the target if we are walking).
  const dwellStop = current ?? [...snap.stops.slice(0, targetPos)].reverse().find((s) => !s.skipped && !s.departedAt);
  if (dwellStop) {
    const needS = Math.max(0, (base.eta - deadline) / 1000);
    const minDwell = 10 * 60;
    const elapsed = dwellStop.arrivedAt ? (snap.now - dwellStop.arrivedAt) / 1000 : 0;
    const newDwell = Math.max(minDwell, elapsed, dwellStop.dwellS - Math.ceil(needS / 60) * 60);
    if (newDwell < dwellStop.dwellS) {
      const stops = snap.stops.map((s) => (s.id === dwellStop.id ? { ...s, dwellS: newDwell } : s));
      const eta = etaOf(stops);
      fixes.push({
        kind: 'cut_dwell',
        label: `Leave ${name(dwellStop.id)} ${Math.round((dwellStop.dwellS - newDwell) / 60)} min early`,
        minutesSaved: (base.eta - eta) / MIN,
        catchesSpecial: eta <= deadline,
        patch: { kind: 'cut_dwell', stopId: dwellStop.id, dwellS: newDwell },
      });
    }
  }

  // 2. Swap the at-risk stop forward so it is next.
  const firstPendingIdx = snap.stops.findIndex((s) => !s.skipped && !s.arrivedAt);
  if (firstPendingIdx >= 0 && snap.stops[firstPendingIdx].id !== targetId) {
    const reordered = snap.stops.slice();
    const [target] = reordered.splice(targetPos, 1);
    reordered.splice(firstPendingIdx, 0, target);
    const relinked = relink(reordered, walk);
    const eta = etaOf(relinked);
    fixes.push({
      kind: 'swap_forward',
      label: `Go to ${name(targetId)} next`,
      minutesSaved: (base.eta - eta) / MIN,
      catchesSpecial: eta <= deadline,
      patch: { kind: 'swap_forward', order: relinked.map((s) => s.id) },
    });
  }

  // 3. Skip the pending stop before the target that saves the most time.
  let bestSkip: ScheduleFix | null = null;
  for (const s of snap.stops.slice(0, targetPos)) {
    if (s.skipped || s.arrivedAt) continue;
    const stops = relink(
      snap.stops.map((x) => (x.id === s.id ? { ...x, skipped: true } : x)),
      walk,
    );
    const eta = etaOf(stops);
    const fix: ScheduleFix = {
      kind: 'skip_stop',
      label: `Skip ${name(s.id)}`,
      minutesSaved: (base.eta - eta) / MIN,
      catchesSpecial: eta <= deadline,
      patch: { kind: 'skip_stop', stopId: s.id },
    };
    if (!bestSkip || fix.minutesSaved > bestSkip.minutesSaved) bestSkip = fix;
  }
  if (bestSkip) fixes.push(bestSkip);

  return fixes
    .filter((f) => f.minutesSaved > 0.5)
    .sort((a, b) => Number(b.catchesSpecial) - Number(a.catchesSpecial) || b.minutesSaved - a.minutesSaved);
}

/** Recomputes `legWalkS` after the order or the skip set changes. */
export function relink(stops: LiveStop[], walk: (a: LiveStop, b: LiveStop) => number): LiveStop[] {
  let prev: LiveStop | null = null;
  return stops.map((s) => {
    if (s.skipped) return s;
    const next = { ...s, legWalkS: prev ? (s.arrivedAt ? s.legWalkS : walk(prev, s)) : s.legWalkS };
    prev = s;
    return next;
  });
}
