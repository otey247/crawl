import { DateTime } from 'luxon';
import OpeningHours from 'opening_hours';

/**
 * OSM `opening_hours` evaluation in an arbitrary timezone. The library reads JS Date
 * local fields, so we hand it a Date whose local wall-clock equals the venue's.
 */
const toFake = (ms: number, tz: string) => {
  const d = DateTime.fromMillis(ms, { zone: tz });
  return new Date(d.year, d.month - 1, d.day, d.hour, d.minute, d.second);
};
const fromFake = (date: Date, tz: string) =>
  DateTime.fromObject(
    { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate(), hour: date.getHours(), minute: date.getMinutes() },
    { zone: tz },
  ).toMillis();

const cache = new Map<string, OpeningHours | null>();

function parse(value: string | null | undefined): OpeningHours | null {
  if (!value) return null;
  if (cache.has(value)) return cache.get(value)!;
  let oh: OpeningHours | null = null;
  try {
    oh = new OpeningHours(value, { address: { country_code: 'us', state: 'Missouri' } } as any, { mode: 0 } as any);
  } catch {
    oh = null;
  }
  cache.set(value, oh);
  return oh;
}

export interface HoursGuard {
  /** `undefined` when hours are unknown or unparseable. */
  isOpenAt: (ms: number) => boolean | undefined;
  /** Earliest instant ≥ t at which the venue is open; t itself if unknown. */
  openFrom: (ms: number) => number;
  known: boolean;
}

export function hoursGuard(value: string | null | undefined, tz: string): HoursGuard {
  const oh = parse(value);
  if (!oh) return { isOpenAt: () => undefined, openFrom: (t) => t, known: false };
  return {
    known: true,
    isOpenAt: (ms) => {
      const d = toFake(ms, tz);
      if (oh.getUnknown(d)) return undefined;
      return oh.getState(d);
    },
    openFrom: (ms) => {
      const d = toFake(ms, tz);
      if (oh.getState(d) || oh.getUnknown(d)) return ms;
      const next = oh.getNextChange(d);
      // Only wait for openings within the next 6 hours; otherwise treat as closed for the night.
      if (!next) return ms;
      const t = fromFake(next, tz);
      return t - ms <= 6 * 3600_000 ? t : ms;
    },
  };
}
