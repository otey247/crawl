import type { LatLng } from './types.js';

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Average adult walking pace used when no router is available, m/s. */
export const WALK_SPEED_MS = 1.3;
/** Street-grid detour over straight-line distance. Soulard's grid lands close to 1.3. */
export const GRID_DETOUR = 1.3;

export function estimateWalk(a: LatLng, b: LatLng): { distanceM: number; walkS: number } {
  const distanceM = haversineM(a, b) * GRID_DETOUR;
  return { distanceM, walkS: distanceM / WALK_SPEED_MS };
}

/** Local equirectangular projection around `origin`, metres. Accurate enough at neighbourhood scale. */
function toXY(p: LatLng, origin: LatLng): [number, number] {
  return [rad(p.lng - origin.lng) * R * Math.cos(rad(origin.lat)), rad(p.lat - origin.lat) * R];
}

export function distanceToSegmentM(p: LatLng, a: LatLng, b: LatLng): number {
  const [px, py] = toXY(p, a);
  const [bx, by] = toXY(b, a);
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

export function distanceToPolylineM(p: LatLng, line: LatLng[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegmentM(p, line[i - 1], line[i]));
  return best;
}

export function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

/** Evenly spaced samples along a polyline (inclusive of both ends). */
export function samplePolyline(line: LatLng[], count: number): LatLng[] {
  if (line.length < 2) return line.slice();
  const segs: number[] = [];
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const d = haversineM(line[i - 1], line[i]);
    segs.push(d);
    total += d;
  }
  const out: LatLng[] = [];
  for (let k = 0; k < count; k++) {
    let target = (total * k) / Math.max(1, count - 1);
    let i = 0;
    while (i < segs.length - 1 && target > segs[i]) target -= segs[i++];
    out.push(interpolate(line[i], line[i + 1], segs[i] === 0 ? 0 : Math.min(1, target / segs[i])));
  }
  return out;
}

/** Point `distM` metres along a polyline. Used by the walk simulator. */
export function pointAlong(line: LatLng[], distM: number): LatLng {
  let remaining = distM;
  for (let i = 1; i < line.length; i++) {
    const d = haversineM(line[i - 1], line[i]);
    if (remaining <= d) return interpolate(line[i - 1], line[i], d === 0 ? 0 : remaining / d);
    remaining -= d;
  }
  return line[line.length - 1];
}

export function polylineLengthM(line: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += haversineM(line[i - 1], line[i]);
  return total;
}
