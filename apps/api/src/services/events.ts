import { readFileSync, existsSync } from 'node:fs';
import { DateTime } from 'luxon';
import type { EventDTO } from '@crawl/core';
import { query } from '../db/pool.js';

/**
 * St. Louis events that change a night out in Soulard: Mardi Gras, St. Patrick's Day and
 * Cardinals home games at Busch Stadium (a few blocks north). Each carries a crowd factor that
 * pads walking times in the optimizer, plus advice shown on the crawl.
 */

export function eventDTO(r: any): EventDTO {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    crowdFactor: r.crowd_factor,
    advice: r.advice ?? [],
    sourceUrl: r.source_url,
    verified: r.verified,
  };
}

export async function eventsOverlapping(neighborhoodId: string | null, fromMs: number, toMs: number): Promise<EventDTO[]> {
  const rows = await query(
    `select * from events where starts_at < $3 and ends_at > $2 and ($1::text is null or $1 = any(neighborhood_ids) or cardinality(neighborhood_ids) = 0)
     order by crowd_factor desc, starts_at`,
    [neighborhoodId, new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  return rows.map(eventDTO);
}

/** Highest crowd factor among events overlapping a window. */
export const crowdFactorFor = (events: EventDTO[]) => events.reduce((f, e) => Math.max(f, e.crowdFactor), 1);

type Seed = Omit<EventDTO, 'id'> & { externalId: string; cityId: string; neighborhoodIds: string[] };

const TZ = 'America/Chicago';
const local = (iso: string) => DateTime.fromISO(iso, { zone: TZ }).toISO()!;

/** Curated St. Louis calendar. Dates are verified against the listed source where one is given. */
export function curatedEvents(): Seed[] {
  const out: Seed[] = [
    {
      externalId: 'stl-mardi-gras-grand-parade-2027',
      cityId: 'stl',
      neighborhoodIds: ['soulard', 'lafayette-square'],
      kind: 'parade',
      title: 'Soulard Mardi Gras: Bud Light Grand Parade',
      startsAt: local('2027-02-06T08:00'),
      endsAt: local('2027-02-07T01:30'),
      crowdFactor: 1.6,
      advice: [
        'Tens of thousands line the streets; the parade rolls from near Busch Stadium through Soulard to the Anheuser-Busch Brewery starting at 11 AM.',
        'Festival entry points: 13th & Russell, 9th & Ann, and Lafayette & Tucker.',
        'Rideshare drop-offs: 13th & Russell, 10th & Marion, South Broadway & Geyer, 7th & Marion. Don’t plan on driving in.',
        'Expect street closures along the parade route; walking times are padded and short legs work best.',
      ],
      sourceUrl: 'https://stlmardigras.org/events/bud-light-grand-parade',
      verified: true,
    },
    {
      externalId: 'stl-st-patricks-day-2027',
      cityId: 'stl',
      neighborhoodIds: ['soulard'],
      kind: 'holiday',
      title: 'St. Patrick’s Day',
      startsAt: local('2027-03-17T10:00'),
      endsAt: local('2027-03-18T01:30'),
      crowdFactor: 1.25,
      advice: ['Irish pubs fill early and may have lines or covers; start sooner and keep dwell times flexible.'],
      sourceUrl: null,
      verified: true,
    },
  ];

  for (const season of [2026, 2027]) {
    const file = new URL(`../../data/events/cardinals-${season}.json`, import.meta.url);
    if (!existsSync(file)) continue;
    const data = JSON.parse(readFileSync(file, 'utf8'));
    for (const g of data.games) {
      const first = Date.parse(g.startsAt);
      out.push({
        externalId: g.id,
        cityId: 'stl',
        neighborhoodIds: ['soulard', 'lafayette-square', 'washington-ave'],
        kind: 'sports',
        title: `Cardinals vs. ${g.opponent}`,
        // Bars near the stadium fill ~2 h before first pitch and again after the final out.
        startsAt: new Date(first - 2 * 3600_000).toISOString(),
        endsAt: new Date(first + 4.5 * 3600_000).toISOString(),
        crowdFactor: 1.15,
        advice: [
          `First pitch ${DateTime.fromISO(g.startsAt, { zone: TZ }).toFormat('h:mm a')} at Busch Stadium. Bars along Broadway fill before the game and right after it.`,
        ],
        sourceUrl: 'https://www.mlb.com/cardinals/schedule',
        verified: true,
      });
    }
  }
  return out;
}

export async function syncCuratedEvents(): Promise<number> {
  const events = curatedEvents();
  for (const e of events) {
    await query(
      `insert into events (external_id, city_id, neighborhood_ids, kind, title, starts_at, ends_at, crowd_factor, advice, source_url, verified)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       on conflict (external_id) do update set title = excluded.title, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
         crowd_factor = excluded.crowd_factor, advice = excluded.advice, source_url = excluded.source_url, verified = excluded.verified, neighborhood_ids = excluded.neighborhood_ids`,
      [e.externalId, e.cityId, e.neighborhoodIds, e.kind, e.title, e.startsAt, e.endsAt, e.crowdFactor, e.advice, e.sourceUrl, e.verified],
    );
  }
  return events.length;
}
