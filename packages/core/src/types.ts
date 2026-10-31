export interface LatLng {
  lat: number;
  lng: number;
}

export type Visibility = 'public' | 'private';
export type CrawlStatus = 'draft' | 'planned' | 'live' | 'ended';
export type Rsvp = 'going' | 'maybe' | 'declined';
export type MemberRole = 'organizer' | 'co_host' | 'participant';
export type CrewRole = 'designated_driver' | 'navigator' | 'photographer';
export type SpecialSource = 'venue' | 'organizer' | 'crowd';
export type RouteStatus = 'pending' | 'proposed' | 'approved' | 'superseded' | 'failed';
export type PhotoStatus = 'pending' | 'ready' | 'hidden';
export type AlertKind = 'highlight' | 'at_risk' | 'missed';

/**
 * Evaluation state of a special relative to the group's projected arrival.
 * `caught` and `unavailable` extend the five states in the spec: the first marks a
 * special that was live when the group arrived, the second one that is not running
 * at any point relevant to this crawl (wrong day, venue closed).
 */
export type SpecialState =
  | 'highlight'
  | 'on_track'
  | 'at_risk'
  | 'projected_miss'
  | 'missed'
  | 'caught'
  | 'unavailable';

export const CREW_ROLES: { id: CrewRole; label: string }[] = [
  { id: 'designated_driver', label: 'Designated Driver' },
  { id: 'navigator', label: 'Navigator' },
  { id: 'photographer', label: 'Photographer' },
];

export const RSVP_LABELS: Record<Rsvp, string> = {
  going: 'Going',
  maybe: 'Maybe',
  declined: "Can't make it",
};

/** A recurring special. Times are local wall-clock times in the crawl's timezone. */
export interface SpecialRule {
  id: string;
  title: string;
  /** ISO weekdays, 1 = Monday … 7 = Sunday. Empty means every day. */
  daysOfWeek: number[];
  /** "HH:mm" */
  startTime: string;
  /** "HH:mm"; an end before the start means the window crosses midnight. */
  endTime: string;
  /** Optional ISO dates bounding the rule. */
  validFrom?: string | null;
  validTo?: string | null;
}

export interface TimeWindow {
  start: number; // epoch ms
  end: number; // epoch ms
}

export interface RoutePreferences {
  /** Busy-road penalty (spec α). */
  alpha: number;
  /** Non-green street penalty (spec β). */
  beta: number;
  /** Missed special penalty, in minutes of equivalent walking (spec λ). */
  lambda: number;
  /** Waiting-outside-a-closed-venue penalty per minute (spec μ). */
  mu: number;
  /** Hard cap on any single leg, seconds. */
  maxLegS?: number | null;
  /** Human-readable tags that produced these weights. */
  tags: PreferenceTag[];
  /** Free text the organizer typed, if any. */
  note?: string | null;
}

export type PreferenceTag = 'fastest' | 'quieter' | 'scenic' | 'specials' | 'short_walks';

export const PREFERENCE_PRESETS: Record<PreferenceTag, Partial<RoutePreferences>> = {
  fastest: { alpha: 0, beta: 0 },
  quieter: { alpha: 0.4 },
  scenic: { beta: 0.3 },
  specials: { lambda: 30 },
  short_walks: { maxLegS: 15 * 60 },
};

export function preferencesFromTags(tags: PreferenceTag[], note?: string | null): RoutePreferences {
  const prefs: RoutePreferences = { alpha: 0, beta: 0, lambda: 10, mu: 1, maxLegS: null, tags, note: note ?? null };
  for (const tag of tags) Object.assign(prefs, PREFERENCE_PRESETS[tag]);
  return prefs;
}
