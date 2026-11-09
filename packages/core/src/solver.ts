import { staysCatches } from './time.js';
import type { RoutePreferences, TimeWindow } from './types.js';

/**
 * Open-path TSP with time windows over the selected bars.
 *
 * Cost (minutes):  C = Σ t_ij · p_ij  +  λ · missed specials  +  μ · minutes waiting for a venue to open
 * where p_ij = 1 + α·s_ij + β·b_ij is precomputed by the caller (see `penalty`).
 *
 * ≤ 12 stops: Held–Karp over (visited set, last stop) with a small Pareto set of
 * (cost, clock) labels per state, so time-dependent special penalties are respected.
 * Larger inputs: multi-start local search (or-opt + 2-opt) under a time budget.
 * Both finish with a local-search polish and honour locked positions.
 */

export interface SolverSpecial {
  id: string;
  windows: TimeWindow[];
}

export interface SolverStop {
  dwellS: number;
  specials: SolverSpecial[];
  /** Earliest instant ≥ t at which the venue is open. Omit if hours are unknown. */
  openFrom?: (t: number) => number;
}

export interface SolveInput {
  stops: SolverStop[];
  walkS: number[][];
  distanceM: number[][];
  /** Per-leg multiplier p_ij. Defaults to 1. */
  penalty?: number[][];
  /** Optional fixed starting point (e.g. a meeting spot) → each stop. */
  originWalkS?: number[];
  originDistanceM?: number[];
  startAt: number;
  prefs: Pick<RoutePreferences, 'lambda' | 'mu' | 'maxLegS'>;
  /** locked[position] = stop index that must sit at that position. */
  locked?: (number | null | undefined)[];
  timeLimitMs?: number;
  /**
   * Extra cost (minutes) for arriving at a stop at a given time, e.g. a patio bar during a rainy
   * hour. Must be cheap: it runs inside the search.
   */
  stopPenalty?: (stop: number, arrival: number) => number;
}

export interface StopTiming {
  stop: number;
  arrival: number;
  departure: number;
  waitS: number;
  caught: string[];
  missed: string[];
}

export interface Evaluation {
  order: number[];
  cost: number;
  walkS: number;
  distanceM: number;
  totalS: number;
  waitS: number;
  timings: StopTiming[];
  caughtCount: number;
  missedCount: number;
  violations: string[];
}

const INFEASIBLE = 1000;

function legCost(input: SolveInput, from: number, to: number): { walk: number; dist: number; cost: number; violation: boolean } {
  const walk = from < 0 ? (input.originWalkS?.[to] ?? 0) : input.walkS[from][to];
  const dist = from < 0 ? (input.originDistanceM?.[to] ?? 0) : input.distanceM[from][to];
  const p = from < 0 ? 1 : (input.penalty?.[from]?.[to] ?? 1);
  const violation = !!input.prefs.maxLegS && walk > input.prefs.maxLegS;
  return { walk, dist, cost: (walk / 60) * p + (violation ? INFEASIBLE : 0), violation };
}

/** Arrive at `stop` at `t`; returns the stay and its incremental cost. */
function visit(input: SolveInput, stop: number, t: number) {
  const s = input.stops[stop];
  const arrival = s.openFrom ? Math.max(t, s.openFrom(t)) : t;
  const waitS = (arrival - t) / 1000;
  const departure = arrival + s.dwellS * 1000;
  const caught: string[] = [];
  const missed: string[] = [];
  for (const sp of s.specials) (staysCatches({ start: arrival, end: departure }, sp.windows) ? caught : missed).push(sp.id);
  const cost = input.prefs.lambda * missed.length + input.prefs.mu * (waitS / 60) + (input.stopPenalty?.(stop, arrival) ?? 0);
  return { arrival, departure, waitS, caught, missed, cost };
}

export function evaluateOrder(input: SolveInput, order: number[]): Evaluation {
  let t = input.startAt;
  let cost = 0;
  let walkS = 0;
  let distanceM = 0;
  let waitS = 0;
  const timings: StopTiming[] = [];
  const violations: string[] = [];
  let prev = input.originWalkS ? -1 : null;
  for (const stop of order) {
    if (prev !== null) {
      const leg = legCost(input, prev, stop);
      t += leg.walk * 1000;
      cost += leg.cost;
      walkS += leg.walk;
      distanceM += leg.dist;
      if (leg.violation) violations.push(`leg_${prev}_${stop}_exceeds_max`);
    }
    const v = visit(input, stop, t);
    cost += v.cost;
    waitS += v.waitS;
    timings.push({ stop, arrival: v.arrival, departure: v.departure, waitS: v.waitS, caught: v.caught, missed: v.missed });
    t = v.departure;
    prev = stop;
  }
  const caughtCount = timings.reduce((n, x) => n + x.caught.length, 0);
  const missedCount = timings.reduce((n, x) => n + x.missed.length, 0);
  return { order, cost, walkS, distanceM, totalS: (t - input.startAt) / 1000, waitS, timings, caughtCount, missedCount, violations };
}

function lockHelpers(input: SolveInput) {
  const n = input.stops.length;
  const lockedAt: (number | null)[] = Array.from({ length: n }, (_, i) => input.locked?.[i] ?? null);
  const lockedPos = new Map<number, number>();
  lockedAt.forEach((s, pos) => s !== null && lockedPos.set(s, pos));
  const canPlace = (stop: number, pos: number) =>
    (lockedAt[pos] === null || lockedAt[pos] === stop) && (!lockedPos.has(stop) || lockedPos.get(stop) === pos);
  const orderValid = (order: number[]) => order.every((s, pos) => canPlace(s, pos));
  return { canPlace, orderValid };
}

interface Label {
  cost: number;
  time: number;
  stop: number;
  parent: Label | null;
}

const MAX_LABELS = 6;

function heldKarp(input: SolveInput): number[] | null {
  const n = input.stops.length;
  const { canPlace } = lockHelpers(input);
  const states = new Map<number, Label[]>(); // key = mask * n + last
  const push = (key: number, label: Label) => {
    const list = states.get(key) ?? [];
    if (list.some((l) => l.cost <= label.cost && l.time <= label.time)) return;
    const kept = list.filter((l) => !(label.cost <= l.cost && label.time <= l.time));
    kept.push(label);
    kept.sort((a, b) => a.cost - b.cost);
    states.set(key, kept.slice(0, MAX_LABELS));
  };

  for (let j = 0; j < n; j++) {
    if (!canPlace(j, 0)) continue;
    let t = input.startAt;
    let cost = 0;
    if (input.originWalkS) {
      const leg = legCost(input, -1, j);
      t += leg.walk * 1000;
      cost += leg.cost;
    }
    const v = visit(input, j, t);
    push((1 << j) * n + j, { cost: cost + v.cost, time: v.departure, stop: j, parent: null });
  }

  // Masks in order of popcount so every predecessor state is final before it is extended.
  const masks = Array.from({ length: 1 << n }, (_, m) => m).sort((a, b) => popcount(a) - popcount(b));
  for (const mask of masks) {
    const pos = popcount(mask);
    if (pos === 0 || pos === n) continue;
    for (let last = 0; last < n; last++) {
      const labels = states.get(mask * n + last);
      if (!labels) continue;
      for (let j = 0; j < n; j++) {
        if (mask & (1 << j) || !canPlace(j, pos)) continue;
        for (const l of labels) {
          const leg = legCost(input, last, j);
          const v = visit(input, j, l.time + leg.walk * 1000);
          push((mask | (1 << j)) * n + j, { cost: l.cost + leg.cost + v.cost, time: v.departure, stop: j, parent: l });
        }
      }
    }
  }

  const full = (1 << n) - 1;
  let best: Label | null = null;
  for (let last = 0; last < n; last++) for (const l of states.get(full * n + last) ?? []) if (!best || l.cost < best.cost) best = l;
  if (!best) return null;
  const order: number[] = [];
  for (let l: Label | null = best; l; l = l.parent) order.unshift(l.stop);
  return order;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}

/** Or-opt (move one stop) and 2-opt (reverse a segment) until no improving move remains. */
function polish(input: SolveInput, order: number[], deadline: number): number[] {
  const { orderValid } = lockHelpers(input);
  let best = order.slice();
  let bestCost = evaluateOrder(input, best).cost;
  let improved = true;
  while (improved && Date.now() < deadline) {
    improved = false;
    const n = best.length;
    for (let i = 0; i < n && !improved; i++) {
      for (let j = 0; j < n && !improved; j++) {
        if (i === j) continue;
        const moved = best.slice();
        const [s] = moved.splice(i, 1);
        moved.splice(j, 0, s);
        const reversed = i < j ? [...best.slice(0, i), ...best.slice(i, j + 1).reverse(), ...best.slice(j + 1)] : null;
        for (const cand of reversed ? [moved, reversed] : [moved]) {
          if (!orderValid(cand)) continue;
          const c = evaluateOrder(input, cand).cost;
          if (c < bestCost - 1e-9) {
            best = cand;
            bestCost = c;
            improved = true;
            break;
          }
        }
      }
    }
  }
  return best;
}

function nearestNeighbour(input: SolveInput, first: number): number[] {
  const n = input.stops.length;
  const { canPlace } = lockHelpers(input);
  const order = [first];
  const used = new Set(order);
  while (order.length < n) {
    const pos = order.length;
    const last = order[pos - 1];
    let pick = -1;
    for (let j = 0; j < n; j++) {
      if (used.has(j) || !canPlace(j, pos)) continue;
      if (pick < 0 || input.walkS[last][j] < input.walkS[last][pick]) pick = j;
    }
    if (pick < 0) pick = [...Array(n).keys()].find((j) => !used.has(j))!;
    order.push(pick);
    used.add(pick);
  }
  return order;
}

export interface SolveResult {
  best: Evaluation;
  method: 'held-karp' | 'local-search' | 'trivial';
  elapsedMs: number;
}

export function solve(input: SolveInput): SolveResult {
  const started = Date.now();
  const n = input.stops.length;
  const deadline = started + (input.timeLimitMs ?? 3000);
  if (n <= 1) return { best: evaluateOrder(input, n ? [0] : []), method: 'trivial', elapsedMs: 0 };

  const { canPlace, orderValid } = lockHelpers(input);
  let order: number[] | null = null;
  let method: SolveResult['method'] = 'local-search';
  if (n <= 12) {
    order = heldKarp(input);
    method = 'held-karp';
  }
  if (!order) {
    let bestCost = Infinity;
    for (let first = 0; first < n && Date.now() < deadline; first++) {
      if (!canPlace(first, 0)) continue;
      const cand = polish(input, nearestNeighbour(input, first), deadline);
      if (!orderValid(cand)) continue;
      const c = evaluateOrder(input, cand).cost;
      if (c < bestCost) {
        bestCost = c;
        order = cand;
      }
    }
    order ??= [...Array(n).keys()];
  }
  order = polish(input, order, deadline);
  return { best: evaluateOrder(input, order), method, elapsedMs: Date.now() - started };
}
