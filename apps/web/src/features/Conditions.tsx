import { CloudRain, ExternalLink, PartyPopper, Thermometer, Trophy, Users } from 'lucide-react';
import { DateTime } from 'luxon';
import { useState } from 'react';
import type { EventDTO, WeatherDTO } from '@crawl/core';
import { fmtTime } from '../lib/format';

const EVENT_ICON = { parade: PartyPopper, holiday: PartyPopper, festival: PartyPopper, sports: Trophy } as const;

/** St. Louis events that change the night: parade crowds, holiday rushes, Cardinals home games. */
export function EventBanner({ events, tz, compact }: { events: EventDTO[]; tz: string; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  const e = events[0];
  const Icon = EVENT_ICON[e.kind] ?? Users;
  const when = DateTime.fromISO(e.startsAt, { zone: tz });
  const padded = Math.round((e.crowdFactor - 1) * 100);
  return (
    <section aria-label="Event" className="rounded-3xl border border-line-strong bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-fg text-ink">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-dim">
            {e.kind === 'sports' ? 'Game day' : e.kind === 'parade' ? 'Parade day' : 'Big night'} · {when.toFormat('ccc, LLL d')}
          </p>
          <p className="mt-0.5 text-[16px] font-semibold leading-snug">{e.title}</p>
          <p className="mt-0.5 text-[14px] text-dim">
            {padded >= 10 ? `Expect crowds: routes plan ${padded}% more walking time.` : 'Expect busier bars nearby.'}
            {events.length > 1 ? ` Also: ${events.slice(1).map((x) => x.title).join(', ')}.` : ''}
          </p>
        </div>
      </div>
      {e.advice.length && !compact ? (
        open ? (
          <ul className="mt-3 space-y-1.5 pl-[52px]">
            {e.advice.map((a) => (
              <li key={a} className="text-[14px] leading-snug text-fg/90">
                {a}
              </li>
            ))}
            {e.sourceUrl ? (
              <li>
                <a href={e.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13px] font-semibold text-amber">
                  Official details <ExternalLink className="size-3.5" />
                </a>
              </li>
            ) : null}
          </ul>
        ) : (
          <button className="mt-2 pl-[52px] text-[14px] font-semibold text-amber" onClick={() => setOpen(true)}>
            What to know
          </button>
        )
      ) : null}
    </section>
  );
}

/** Forecast for the crawl window (NWS), with patio stops that land in rainy hours called out. */
export function WeatherCard({ weather, tz, compact }: { weather: WeatherDTO | null; tz: string; compact?: boolean }) {
  if (!weather) return null;
  const wet = weather.maxPrecipChance >= 40;
  const cold = weather.minTempF <= 40;
  if (compact && !weather.outdoorAtRisk.length) return null;
  const hours = weather.periods.slice(0, 8);
  return (
    <section aria-label="Weather" className="rounded-3xl border border-line bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-raised text-fg border border-line">
          {wet ? <CloudRain className="size-5" /> : <Thermometer className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold leading-snug">
            {weather.minTempF === weather.maxTempF ? `${weather.minTempF}°F` : `${weather.minTempF}–${weather.maxTempF}°F`}
            {wet ? ` · up to ${weather.maxPrecipChance}% chance of rain` : ' · staying dry'}
          </p>
          {weather.outdoorAtRisk.length ? (
            <p className="mt-0.5 text-[14px] text-fg/90">
              {weather.outdoorAtRisk.map((o) => `${o.venueName} (patio) around ${fmtTime(o.at, tz)}: ${o.precipChance}%`).join(' · ')}. Re-optimize to move patio stops into drier hours.
            </p>
          ) : (
            <p className="mt-0.5 text-[14px] text-dim">{cold ? 'Bring a jacket for the walks between bars.' : wet ? 'Patio stops look fine at your planned times.' : 'Good night for patios.'}</p>
          )}
        </div>
      </div>
      {!compact ? (
        <div className="no-scrollbar -mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4">
          {hours.map((p) => (
            <div key={p.start} className="flex w-14 shrink-0 flex-col items-center rounded-2xl bg-raised py-2">
              <span className="text-[11px] font-semibold text-dim">{DateTime.fromISO(p.start, { zone: tz }).toFormat('h a')}</span>
              <span className="mt-1 text-[15px] font-semibold tabular">{p.temperatureF}°</span>
              <span className={`text-[11px] tabular ${p.precipChance >= 40 ? 'font-bold text-fg' : 'text-faint'}`}>{p.precipChance}%</span>
            </div>
          ))}
        </div>
      ) : null}
      <p className="mt-2 text-[11px] text-faint">Forecast: {weather.source}</p>
    </section>
  );
}
