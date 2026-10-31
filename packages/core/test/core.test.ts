import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import {
  classifySpecial,
  evaluateOrder,
  formatWindow,
  projectSchedule,
  solve,
  specialWindows,
  suggestFixes,
  windowAt,
  type LiveStop,
  type SolveInput,
  type SpecialRule,
} from '../src/index.js';

const TZ = 'America/Chicago';
const at = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toMillis();
const rule = (p: Partial<SpecialRule>): SpecialRule => ({ id: 'sp', title: 'Happy hour', daysOfWeek: [], startTime: '16:00', endTime: '18:00', ...p });

describe('special windows', () => {
  it('handles windows that cross midnight on the starting day', () => {
    const late = rule({ daysOfWeek: [5], startTime: '22:00', endTime: '01:00' }); // Fridays
    // Friday 2026-10-30 22:00 → Saturday 01:00
    expect(windowAt(late, at('2026-10-31T00:30'), TZ)).not.toBeNull();
    expect(windowAt(late, at('2026-10-31T01:05'), TZ)).toBeNull();
    // Saturday night is not a Friday window
    expect(windowAt(late, at('2026-10-31T23:00'), TZ)).toBeNull();
  });

  it('evaluates weekdays in the crawl timezone, not UTC', () => {
    const fridayOnly = rule({ daysOfWeek: [5], startTime: '20:00', endTime: '22:00' });
    // 21:00 Friday in St. Louis is 02:00 Saturday UTC.
    expect(windowAt(fridayOnly, at('2026-10-30T21:00'), TZ)).not.toBeNull();
  });

  it('survives the DST change', () => {
    // US DST ends 2026-11-01 at 02:00.
    const r = rule({ startTime: '00:30', endTime: '03:00' });
    const ws = specialWindows(r, at('2026-11-01T00:00'), at('2026-11-01T04:00'), TZ);
    const w = ws.find((x) => x.start === at('2026-11-01T00:30'))!;
    expect((w.end - w.start) / 3_600_000).toBeCloseTo(3.5); // one extra hour that night
  });

  it('formats windows compactly', () => {
    expect(formatWindow({ startTime: '16:00', endTime: '18:30' })).toBe('4–6:30pm');
    expect(formatWindow({ startTime: '22:00', endTime: '01:00' })).toBe('10pm–1am');
  });
});

function grid(n: number): SolveInput {
  // Stops on a line, 5 minutes apart; the "organizer order" is scrambled.
  const walkS = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => Math.abs(i - j) * 300));
  return {
    stops: Array.from({ length: n }, () => ({ dwellS: 1800, specials: [] })),
    walkS,
    distanceM: walkS.map((r) => r.map((s) => s * 1.3)),
    startAt: at('2026-10-31T18:00'),
    prefs: { lambda: 10, mu: 1, maxLegS: null },
  };
}

describe('solver', () => {
  it('finds the straight walk along a line', () => {
    const res = solve(grid(8));
    expect(res.method).toBe('held-karp');
    expect(res.best.walkS).toBe(7 * 300);
  });

  it('beats a scrambled order', () => {
    const input = grid(10);
    const scrambled = evaluateOrder(input, [3, 7, 1, 9, 0, 5, 2, 8, 4, 6]);
    expect(solve(input).best.cost).toBeLessThan(scrambled.cost);
  });

  it('reorders to catch a happy hour that ends early', () => {
    const input = grid(4);
    // Stop 3 (far end) has a 6–7pm special. Fastest path 0→1→2→3 arrives at 19:45.
    input.stops[3].specials = [{ id: 'hh', windows: [{ start: at('2026-10-31T18:00'), end: at('2026-10-31T19:00') }] }];
    input.prefs.lambda = 30;
    const res = solve(input);
    expect(res.best.order[0]).toBe(3);
    expect(res.best.caughtCount).toBe(1);
  });

  it('respects locked positions', () => {
    const input = grid(6);
    input.locked = [4];
    expect(solve(input).best.order[0]).toBe(4);
  });

  it('falls back to local search above 12 stops within budget', () => {
    const res = solve({ ...grid(14), timeLimitMs: 2000 });
    expect(res.method).toBe('local-search');
    expect(res.best.walkS).toBe(13 * 300);
  });

  it('flags legs over the max-leg constraint', () => {
    const input = grid(3);
    input.prefs.maxLegS = 200;
    expect(solve(input).best.violations.length).toBeGreaterThan(0);
  });
});

const stops = (): LiveStop[] => [
  { id: 'a', location: { lat: 38.6026, lng: -90.209 }, dwellS: 1800, legWalkS: 0 },
  { id: 'b', location: { lat: 38.6031, lng: -90.2033 }, dwellS: 1800, legWalkS: 600 },
  { id: 'c', location: { lat: 38.6017, lng: -90.2032 }, dwellS: 1800, legWalkS: 300 },
];

describe('live projection and specials', () => {
  it('projects ETAs from the current stop', () => {
    const s = stops();
    s[0].arrivedAt = at('2026-10-31T18:00');
    const p = projectSchedule({ stops: s, now: at('2026-10-31T18:10'), startAt: at('2026-10-31T18:00') });
    expect(p[0].phase).toBe('current');
    expect(p[1].phase).toBe('next');
    expect(p[1].eta).toBe(at('2026-10-31T18:40'));
    expect(p[2].eta).toBe(at('2026-10-31T19:15'));
  });

  it('classifies highlight, at-risk and projected-miss', () => {
    const s = stops();
    s[0].arrivedAt = at('2026-10-31T18:00');
    const now = at('2026-10-31T18:10');
    const p = projectSchedule({ stops: s, now, startAt: at('2026-10-31T18:00') });
    const base = { tz: TZ, now, crawlStartAt: at('2026-10-31T18:00') };
    expect(classifySpecial({ ...base, rule: rule({ startTime: '18:00', endTime: '20:00' }), stop: p[1] }).state).toBe('highlight');
    expect(classifySpecial({ ...base, rule: rule({ startTime: '18:00', endTime: '20:00' }), stop: p[2] }).state).toBe('on_track');
    expect(classifySpecial({ ...base, rule: rule({ startTime: '18:00', endTime: '18:45' }), stop: p[1] }).state).toBe('at_risk');
    const miss = classifySpecial({ ...base, rule: rule({ startTime: '17:00', endTime: '19:00' }), stop: p[2] });
    expect(miss.state).toBe('projected_miss');
    expect(classifySpecial({ ...base, rule: rule({ startTime: '15:00', endTime: '17:00' }), stop: p[2] }).state).toBe('unavailable');
    expect(classifySpecial({ ...base, rule: rule({ startTime: '17:00', endTime: '19:00' }), stop: p[0] }).state).toBe('highlight');
  });

  it('suggests fixes that rescue an at-risk special', () => {
    const s = stops();
    s[0].arrivedAt = at('2026-10-31T18:00');
    const snap = { stops: s, now: at('2026-10-31T18:10'), startAt: at('2026-10-31T18:00') };
    // c is reached at 19:15; its special ends at 19:15.
    const fixes = suggestFixes(snap, 'c', at('2026-10-31T19:15'));
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes[0].catchesSpecial).toBe(true);
    expect(new Set(fixes.map((f) => f.kind))).toEqual(new Set(['cut_dwell', 'swap_forward', 'skip_stop']));
  });
});
