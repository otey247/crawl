import { estimateWalk, type LatLng, type RoutePreferences } from '@crawl/core';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { sha256 } from '../lib/ids.js';

/**
 * Walking matrix and leg geometry. Providers, in order of preference:
 *   1. Valhalla (self-hosted; pedestrian costing honours quieter/scenic preferences)
 *   2. OSRM foot profile (hosted community instance by default)
 *   3. Straight-line estimate × street-grid detour (always available)
 * Results are cached in Postgres by point set + costing.
 */

export interface Matrix {
  walkS: number[][];
  distanceM: number[][];
  provider: string;
}

export interface Leg {
  distanceM: number;
  walkS: number;
  geometry: [number, number][]; // [lng, lat]
}

const key = (kind: string, points: LatLng[], extra: unknown) =>
  sha256(`${kind}|${points.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(';')}|${JSON.stringify(extra)}`);

async function cached<T>(k: string, compute: () => Promise<T>): Promise<T> {
  const hit = await one<{ value: T }>('select value from routing_cache where key = $1 and created_at > now() - interval \'30 days\'', [k]);
  if (hit) return hit.value;
  const value = await compute();
  await query('insert into routing_cache (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value, created_at = now()', [
    k,
    JSON.stringify(value),
  ]);
  return value;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(config.routing.timeoutMs), headers: { 'user-agent': 'crawl-app/1.0', ...(init?.headers ?? {}) } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
  return res.json();
}

function valhallaCosting(prefs?: Pick<RoutePreferences, 'alpha' | 'beta'>) {
  const alpha = prefs?.alpha ?? 0;
  const beta = prefs?.beta ?? 0;
  return {
    costing: 'pedestrian',
    costing_options: {
      pedestrian: {
        use_living_roads: Math.min(1, 0.5 + alpha),
        walkway_factor: Math.max(0.6, 1 - alpha),
        use_tracks: Math.min(1, 0.5 + beta),
        sidewalk_factor: 1,
      },
    },
  };
}

async function valhallaMatrix(points: LatLng[], prefs?: Pick<RoutePreferences, 'alpha' | 'beta'>): Promise<Matrix> {
  const locs = points.map((p) => ({ lat: p.lat, lon: p.lng }));
  const body = { sources: locs, targets: locs, ...valhallaCosting(prefs) };
  const res = await fetchJson(`${config.routing.valhallaUrl}/sources_to_targets`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const rows: any[][] = res.sources_to_targets;
  return {
    walkS: rows.map((r) => r.map((c) => c.time ?? Infinity)),
    distanceM: rows.map((r) => r.map((c) => (c.distance ?? Infinity) * 1000)),
    provider: 'valhalla',
  };
}

async function osrmMatrix(points: LatLng[]): Promise<Matrix> {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await fetchJson(`${config.routing.osrmUrl}/table/v1/foot/${coords}?annotations=duration,distance`);
  if (res.code !== 'Ok') throw new Error(res.code);
  return { walkS: res.durations, distanceM: res.distances, provider: 'osrm' };
}

function estimateMatrix(points: LatLng[]): Matrix {
  const walkS = points.map((a) => points.map((b) => estimateWalk(a, b).walkS));
  const distanceM = points.map((a) => points.map((b) => estimateWalk(a, b).distanceM));
  return { walkS, distanceM, provider: 'estimate' };
}

export async function walkingMatrix(points: LatLng[], prefs?: Pick<RoutePreferences, 'alpha' | 'beta'>): Promise<Matrix> {
  if (points.length < 2) return estimateMatrix(points);
  const costing = config.routing.valhallaUrl ? valhallaCosting(prefs) : 'osrm';
  return cached(key('matrix', points, costing), async () => {
    try {
      if (config.routing.valhallaUrl) return await valhallaMatrix(points, prefs);
      return await osrmMatrix(points);
    } catch (err) {
      console.warn('[routing] matrix provider failed, using estimate:', (err as Error).message);
      return estimateMatrix(points);
    }
  });
}

/** Precision-6 polyline decoder (Valhalla shapes). */
function decodePolyline6(str: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < str.length) {
    for (const which of [0, 1]) {
      let result = 0;
      let shift = 0;
      let b: number;
      do {
        b = str.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}

async function valhallaLegs(points: LatLng[], prefs?: Pick<RoutePreferences, 'alpha' | 'beta'>): Promise<Leg[]> {
  const body = { locations: points.map((p) => ({ lat: p.lat, lon: p.lng })), ...valhallaCosting(prefs), units: 'kilometers' };
  const res = await fetchJson(`${config.routing.valhallaUrl}/route`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return res.trip.legs.map((l: any) => ({ distanceM: l.summary.length * 1000, walkS: l.summary.time, geometry: decodePolyline6(l.shape) }));
}

async function osrmLegs(points: LatLng[]): Promise<Leg[]> {
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
  const res = await fetchJson(`${config.routing.osrmUrl}/route/v1/foot/${coords}?overview=false&steps=true&geometries=geojson`);
  if (res.code !== 'Ok') throw new Error(res.code);
  return res.routes[0].legs.map((l: any) => {
    const geometry: [number, number][] = [];
    for (const step of l.steps) for (const c of step.geometry.coordinates) {
      const last = geometry[geometry.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) geometry.push([c[0], c[1]]);
    }
    return { distanceM: l.distance, walkS: l.duration, geometry };
  });
}

function estimateLegs(points: LatLng[]): Leg[] {
  return points.slice(1).map((b, i) => {
    const a = points[i];
    const { distanceM, walkS } = estimateWalk(a, b);
    // Manhattan-style L so the line follows the street grid rather than cutting through blocks.
    return { distanceM, walkS, geometry: [[a.lng, a.lat], [b.lng, a.lat], [b.lng, b.lat]] };
  });
}

/** Turn-by-turn geometry for consecutive pairs in `points`. */
export async function walkingLegs(points: LatLng[], prefs?: Pick<RoutePreferences, 'alpha' | 'beta'>): Promise<{ legs: Leg[]; provider: string }> {
  if (points.length < 2) return { legs: [], provider: 'none' };
  const costing = config.routing.valhallaUrl ? valhallaCosting(prefs) : 'osrm';
  return cached(key('legs', points, costing), async () => {
    try {
      if (config.routing.valhallaUrl) return { legs: await valhallaLegs(points, prefs), provider: 'valhalla' };
      return { legs: await osrmLegs(points), provider: 'osrm' };
    } catch (err) {
      console.warn('[routing] legs provider failed, using estimate:', (err as Error).message);
      return { legs: estimateLegs(points), provider: 'estimate' };
    }
  });
}
