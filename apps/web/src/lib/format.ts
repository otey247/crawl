import { DateTime } from 'luxon';

export const fmtTime = (iso: string | null | undefined, tz: string) => (iso ? DateTime.fromISO(iso, { zone: tz }).toFormat('h:mm a') : '—');

/** "Tonight", "Tomorrow", "Sat, Nov 7" relative to now in the crawl's timezone. */
export function fmtDay(iso: string, tz: string): string {
  const d = DateTime.fromISO(iso, { zone: tz });
  const today = DateTime.now().setZone(tz).startOf('day');
  const diff = Math.round(d.startOf('day').diff(today, 'days').days);
  if (diff === 0) return d.hour >= 17 ? 'Tonight' : 'Today';
  if (diff === 1) return d.hour >= 17 ? 'Tomorrow night' : 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toFormat('cccc');
  return d.toFormat('ccc, LLL d');
}

export const fmtWhen = (iso: string, tz: string) => `${fmtDay(iso, tz)} · ${fmtTime(iso, tz)}`;

export function fmtDistance(m: number): string {
  const mi = m / 1609.34;
  return mi < 0.1 ? `${Math.round(m * 3.281)} ft` : `${mi.toFixed(1)} mi`;
}

export function fmtDuration(s: number): string {
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

export function fmtRelative(iso: string): string {
  return DateTime.fromISO(iso).toRelative({ style: 'short' }) ?? '';
}

export const priceLabel = (n: number | null) => (n ? '$'.repeat(n) : '');

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
