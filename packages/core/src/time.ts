import { DateTime } from 'luxon';
import type { SpecialRule, TimeWindow } from './types.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function parseHm(hm: string): { hour: number; minute: number } {
  const [h, m] = hm.split(':').map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
}

/**
 * Every concrete occurrence of a recurring special that overlaps [fromMs, toMs].
 * Days of week and valid dates are evaluated in `tz` on the day the window *starts*,
 * so a Friday 22:00–01:00 special still applies at 00:30 on Saturday.
 * Luxon resolves wall-clock times per day, so DST transitions are handled.
 */
export function specialWindows(rule: SpecialRule, fromMs: number, toMs: number, tz: string): TimeWindow[] {
  const out: TimeWindow[] = [];
  const s = parseHm(rule.startTime);
  const e = parseHm(rule.endTime);
  let day = DateTime.fromMillis(fromMs, { zone: tz }).startOf('day').minus({ days: 1 });
  const last = DateTime.fromMillis(toMs, { zone: tz }).startOf('day');
  while (day <= last) {
    const iso = day.toISODate()!;
    const dayOk = rule.daysOfWeek.length === 0 || rule.daysOfWeek.includes(day.weekday);
    const validOk = (!rule.validFrom || iso >= rule.validFrom) && (!rule.validTo || iso <= rule.validTo);
    if (dayOk && validOk) {
      const start = day.set({ hour: s.hour, minute: s.minute }).toMillis();
      let end = day.set({ hour: e.hour, minute: e.minute }).toMillis();
      if (end <= start) end = day.plus({ days: 1 }).set({ hour: e.hour, minute: e.minute }).toMillis();
      if (end > fromMs && start <= toMs) out.push({ start, end });
    }
    day = day.plus({ days: 1 });
  }
  return out;
}

export function windowAt(rule: SpecialRule, atMs: number, tz: string): TimeWindow | null {
  return specialWindows(rule, atMs, atMs, tz).find((w) => w.start <= atMs && atMs < w.end) ?? null;
}

export function isSpecialLive(rule: SpecialRule, atMs: number, tz: string): boolean {
  return windowAt(rule, atMs, tz) !== null;
}

/** Minutes of overlap between a stay and a window. */
export function overlapMin(a: TimeWindow, b: TimeWindow): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) / MIN;
}

/**
 * Whether a stay "catches" a special: the special must cover at least 20 minutes of the
 * stay (or the whole stay, if shorter). Shared by the solver and the schedule display.
 */
export function staysCatches(stay: TimeWindow, windows: TimeWindow[]): TimeWindow | null {
  const need = Math.min(20, (stay.end - stay.start) / MIN);
  return windows.find((w) => overlapMin(stay, w) >= need - 1e-6) ?? null;
}

/** "6–7pm", "10pm–1am", "4:30–6:30pm" */
export function formatWindow(rule: Pick<SpecialRule, 'startTime' | 'endTime'>): string {
  const fmt = (hm: string, withSuffix: boolean) => {
    const { hour, minute } = parseHm(hm);
    const h12 = hour % 12 === 0 ? 12 : hour % 12;
    const suffix = hour < 12 ? 'am' : 'pm';
    return `${h12}${minute ? `:${String(minute).padStart(2, '0')}` : ''}${withSuffix ? suffix : ''}`;
  };
  const sameHalf = parseHm(rule.startTime).hour < 12 === parseHm(rule.endTime).hour < 12;
  return `${fmt(rule.startTime, !sameHalf)}–${fmt(rule.endTime, true)}`;
}

export function formatDays(days: number[]): string {
  if (days.length === 0 || days.length === 7) return 'Daily';
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const sorted = [...days].sort();
  if (sorted.join() === '1,2,3,4,5') return 'Weekdays';
  if (sorted.join() === '6,7') return 'Weekends';
  const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
  if (contiguous && sorted.length > 2) return `${names[sorted[0] - 1]}–${names[sorted[sorted.length - 1] - 1]}`;
  return sorted.map((d) => names[d - 1]).join(', ');
}

export { MIN, DAY };
