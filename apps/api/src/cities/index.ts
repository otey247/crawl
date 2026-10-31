import { readFileSync, existsSync } from 'node:fs';
import type { LatLng } from '@crawl/core';

export interface NeighborhoodConfig {
  id: string;
  name: string;
  center: LatLng;
  zoom: number;
  /** [south, west, north, east] */
  bbox: [number, number, number, number];
  /** Streets that get crowded after `crowdedAfterHour` (local time). Approximated as polylines. */
  nightlife?: { name: string; line: [number, number][] }[];
}

export interface CityConfig {
  id: string;
  name: string;
  timezone: string;
  center: LatLng;
  crowdedAfterHour: number;
  neighborhoods: NeighborhoodConfig[];
}

export const CITIES: CityConfig[] = [
  {
    id: 'stl',
    name: 'St. Louis',
    timezone: 'America/Chicago',
    center: { lat: 38.6083, lng: -90.2052 },
    crowdedAfterHour: 21,
    neighborhoods: [
      {
        id: 'soulard',
        name: 'Soulard',
        center: { lat: 38.6083, lng: -90.2052 },
        zoom: 15.6,
        bbox: [38.594, -90.218, 38.616, -90.194],
        nightlife: [
          { name: 'S 9th St', line: [[38.6046, -90.2047], [38.6117, -90.2032]] },
          { name: 'Russell Blvd', line: [[38.6072, -90.2121], [38.6066, -90.2005]] },
          { name: 'S 12th St', line: [[38.6050, -90.2100], [38.6105, -90.2088]] },
        ],
      },
      { id: 'lafayette-square', name: 'Lafayette Square', center: { lat: 38.6158, lng: -90.2142 }, zoom: 15.4, bbox: [38.609, -90.226, 38.622, -90.205] },
      { id: 'the-grove', name: 'The Grove', center: { lat: 38.6273, lng: -90.2604 }, zoom: 15.4, bbox: [38.621, -90.272, 38.633, -90.248] },
      { id: 'cherokee-street', name: 'Cherokee Street', center: { lat: 38.5937, lng: -90.2311 }, zoom: 15.4, bbox: [38.589, -90.245, 38.599, -90.217] },
      { id: 'washington-ave', name: 'Washington Ave', center: { lat: 38.6315, lng: -90.1932 }, zoom: 15.4, bbox: [38.626, -90.206, 38.637, -90.183] },
      { id: 'central-west-end', name: 'Central West End', center: { lat: 38.6436, lng: -90.2585 }, zoom: 15.2, bbox: [38.636, -90.272, 38.651, -90.246] },
    ],
  },
];

export const DEFAULT_NEIGHBORHOOD = 'soulard';

export function findNeighborhood(id: string | null | undefined): { city: CityConfig; hood: NeighborhoodConfig } | null {
  for (const city of CITIES) {
    const hood = city.neighborhoods.find((n) => n.id === id);
    if (hood) return { city, hood };
  }
  return null;
}

export interface NeighborhoodGeo {
  arterials: { name: string; class: string; line: LatLng[] }[];
  green: { name: string; kind: string; line: LatLng[] }[];
}

const geoCache = new Map<string, NeighborhoodGeo>();

/** Busy roads and green space from OSM (refreshed by `npm run venues:import`). */
export function neighborhoodGeo(id: string): NeighborhoodGeo {
  const cached = geoCache.get(id);
  if (cached) return cached;
  const file = new URL(`../../data/${id}.geo.json`, import.meta.url);
  let geo: NeighborhoodGeo = { arterials: [], green: [] };
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const toLine = (l: [number, number][]) => l.map(([lat, lng]) => ({ lat, lng }));
    geo = {
      arterials: raw.arterials.map((a: any) => ({ ...a, line: toLine(a.line) })),
      green: raw.green.map((g: any) => ({ ...g, line: toLine(g.line) })),
    };
  }
  geoCache.set(id, geo);
  return geo;
}
