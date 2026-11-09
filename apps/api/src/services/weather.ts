import type { StopDTO, VenueDTO, WeatherDTO, WeatherPeriodDTO } from '@crawl/core';
import { one, query } from '../db/pool.js';

/**
 * Hourly forecasts from the National Weather Service (api.weather.gov: free, US-only, no key).
 * Cached per ~100 m grid cell for 30 minutes. Crawl pages read stale-while-revalidate so a slow
 * NWS response never delays the page; the optimizer awaits a fresh copy.
 */

const TTL_MS = 30 * 60_000;
const HORIZON_MS = 6.5 * 24 * 3600_000; // NWS hourly forecasts run ~7 days out
const RAINY = 40;

interface Hourly {
  periods: WeatherPeriodDTO[];
  fetchedAt: string;
}

/** Test seam: replaced in tests so they never call NWS. */
export const weatherProvider = {
  async fetchHourly(lat: number, lng: number): Promise<WeatherPeriodDTO[]> {
    if (process.env.WEATHER_DISABLED === 'true') throw new Error('weather disabled');
    const headers = { 'user-agent': 'crawl-app/1.0 (weather)', accept: 'application/geo+json' };
    const point = (await (await fetch(`https://api.weather.gov/points/${lat.toFixed(4)},${lng.toFixed(4)}`, { headers, signal: AbortSignal.timeout(6000) })).json()) as any;
    const url = point?.properties?.forecastHourly;
    if (!url) throw new Error('NWS: no forecast for this point');
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`NWS ${res.status}`);
    const data = (await res.json()) as any;
    return data.properties.periods.map((p: any) => ({
      start: new Date(p.startTime).toISOString(),
      temperatureF: p.temperatureUnit === 'C' ? Math.round((p.temperature * 9) / 5 + 32) : p.temperature,
      precipChance: p.probabilityOfPrecipitation?.value ?? 0,
      summary: p.shortForecast,
    }));
  },
};

const keyFor = (lat: number, lng: number) => `nws:${lat.toFixed(3)},${lng.toFixed(3)}`;
const inflight = new Map<string, Promise<Hourly | null>>();

async function refresh(lat: number, lng: number): Promise<Hourly | null> {
  const key = keyFor(lat, lng);
  if (inflight.has(key)) return inflight.get(key)!;
  const p = (async () => {
    try {
      const value: Hourly = { periods: await weatherProvider.fetchHourly(lat, lng), fetchedAt: new Date().toISOString() };
      await query(
        `insert into weather_cache (key, value, fetched_at) values ($1, $2, now()) on conflict (key) do update set value = excluded.value, fetched_at = now()`,
        [key, JSON.stringify(value)],
      );
      return value;
    } catch (err) {
      if (process.env.WEATHER_DISABLED !== 'true') console.warn('[weather]', (err as Error).message);
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** `fresh: true` waits for NWS when the cache is stale; otherwise returns whatever is cached and refreshes in the background. */
export async function hourlyForecast(lat: number, lng: number, opts: { fresh?: boolean } = {}): Promise<Hourly | null> {
  const row = await one<{ value: Hourly; fetched_at: string }>('select value, fetched_at from weather_cache where key = $1', [keyFor(lat, lng)]);
  const stale = !row || Date.now() - Date.parse(row.fetched_at) > TTL_MS;
  if (!stale) return row!.value;
  if (opts.fresh) return (await refresh(lat, lng)) ?? row?.value ?? null;
  void refresh(lat, lng);
  return row?.value ?? null;
}

export const isOutdoor = (v: Pick<VenueDTO, 'category' | 'tags'>) => v.category === 'biergarten' || v.tags.some((t) => /patio|beer garden|rooftop|courtyard/i.test(t));

export const precipAt = (periods: WeatherPeriodDTO[], t: number): number => {
  const p = periods.find((x) => Date.parse(x.start) <= t && t < Date.parse(x.start) + 3600_000);
  return p?.precipChance ?? 0;
};

/** Forecast for a crawl: the hours it spans, plus outdoor stops whose arrival lands in a rainy hour. */
export async function crawlWeather(
  crawl: { start_at: string; status: string },
  stops: StopDTO[],
  totalS: number | null,
  opts: { fresh?: boolean } = {},
): Promise<WeatherDTO | null> {
  if (!stops.length || crawl.status === 'ended') return null;
  const start = Date.parse(crawl.start_at);
  const durationMs = (totalS ?? stops.reduce((t, s) => t + s.dwellMin * 60 + 600, 0)) * 1000;
  const end = start + durationMs;
  if (start - Date.now() > HORIZON_MS || end < Date.now()) return null;
  const anchor = stops[0].venue;
  const hourly = await hourlyForecast(anchor.lat, anchor.lng, opts);
  if (!hourly) return null;
  const periods = hourly.periods.filter((p) => Date.parse(p.start) + 3600_000 > start && Date.parse(p.start) < end);
  if (!periods.length) return null;

  let clock = start;
  const outdoorAtRisk: WeatherDTO['outdoorAtRisk'] = [];
  for (const s of stops) {
    if (s.skipped) continue;
    const at = s.arrivedAt ? Date.parse(s.arrivedAt) : s.plannedArrivalAt ? Date.parse(s.plannedArrivalAt) : clock;
    clock = at + s.dwellMin * 60_000 + 600_000;
    if (!isOutdoor(s.venue) || s.departedAt) continue;
    const chance = precipAt(hourly.periods, at);
    if (chance >= RAINY) outdoorAtRisk.push({ stopId: s.id, venueName: s.venue.name, at: new Date(at).toISOString(), precipChance: chance });
  }
  return {
    periods,
    maxPrecipChance: Math.max(...periods.map((p) => p.precipChance)),
    minTempF: Math.min(...periods.map((p) => p.temperatureF)),
    maxTempF: Math.max(...periods.map((p) => p.temperatureF)),
    outdoorAtRisk,
    source: 'National Weather Service',
    fetchedAt: hourly.fetchedAt,
  };
}
