import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Footprints, MapPin, SkipForward, Undo2 } from 'lucide-react';
import type { CrawlDetailDTO, LiveSpecialDTO, StopDTO } from '@crawl/core';
import { STATE_COPY } from '../components/domain';
import { Button, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmtDuration, fmtTime } from '../lib/format';
import { useGeolocation } from '../lib/geo';

export function Itinerary({ crawl }: { crawl: CrawlDetailDTO }) {
  const qc = useQueryClient();
  const toast = useToast();
  const live = crawl.live;
  const isLive = crawl.status === 'live';
  const checkIns = useQuery({ queryKey: ['check-ins', crawl.id], queryFn: () => api.myCheckIns(crawl.id), enabled: crawl.permissions.isMember && crawl.status !== 'draft' });
  const geo = useGeolocation(false);
  const set = (c: CrawlDetailDTO) => qc.setQueryData(['crawl', crawl.id], c);
  const onErr = (e: unknown) => toast({ title: errorMessage(e) });
  const checkIn = useMutation({
    mutationFn: (stopId: string) => api.checkIn(crawl.id, stopId, geo.position ?? undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['check-ins', crawl.id] });
      toast({ title: 'Checked in', body: 'Saved to your Visited History when the crawl ends.' });
    },
    onError: onErr,
  });
  const arrive = useMutation({ mutationFn: (stopId: string) => api.arrive(crawl.id, stopId), onSuccess: set, onError: onErr });
  const skip = useMutation({ mutationFn: (v: { stopId: string; skipped: boolean }) => api.skipStop(crawl.id, v.stopId, v.skipped), onSuccess: set, onError: onErr });

  const legByTo = new Map(crawl.approvedRoute?.legs.map((l) => [l.toStopId, l]) ?? []);
  const sched = new Map(live?.schedule.map((s) => [s.stopId, s]) ?? []);
  const specialsByStop = new Map<string, LiveSpecialDTO[]>();
  for (const s of live?.specials ?? []) specialsByStop.set(s.stopId, [...(specialsByStop.get(s.stopId) ?? []), s]);
  const checked = new Set(checkIns.data?.map((c) => c.stopId));

  return (
    <ol>
      {crawl.stops.map((stop, i) => {
        const p = sched.get(stop.id);
        const phase = p?.phase ?? (stop.departedAt ? 'visited' : 'planned');
        const leg = legByTo.get(stop.id);
        const eta = p?.eta ?? stop.plannedArrivalAt;
        const isCurrent = phase === 'current';
        const isNext = phase === 'next';
        const done = phase === 'visited';
        const skipped = phase === 'skipped' || stop.skipped;
        return (
          <li key={stop.id}>
            {i > 0 ? (
              <p className="ml-[19px] flex items-center gap-2 border-l-2 border-dashed border-line-strong py-2.5 pl-6 text-[13px] text-dim">
                <Footprints className="size-3.5" /> {leg ? `${fmtDuration(leg.walkS)} walk` : 'Walk'}
              </p>
            ) : null}
            <div className={`rounded-3xl p-4 ${isCurrent ? 'bg-fg text-ink' : 'border border-line bg-surface'} ${skipped || done ? 'opacity-60' : ''}`}>
              <div className="flex items-start gap-3">
                <span
                  className={`inline-flex size-10 shrink-0 items-center justify-center rounded-full text-[15px] font-bold ${
                    isCurrent ? 'bg-ink text-amber' : isNext ? 'bg-amber text-amber-ink' : 'border-2 border-line-strong'
                  }`}
                >
                  {done ? <Check className="size-5" strokeWidth={3} /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className={`truncate text-[17px] font-semibold ${skipped ? 'line-through' : ''}`}>{stop.venue.name}</p>
                    <p className={`shrink-0 text-[14px] font-medium tabular ${isCurrent ? 'text-[#4a4741]' : 'text-dim'}`}>
                      {skipped ? 'Skipped' : isCurrent ? `Until ${fmtTime(p?.departure, crawl.timezone)}` : done ? fmtTime(stop.arrivedAt, crawl.timezone) : eta ? fmtTime(eta, crawl.timezone) : `${stop.dwellMin} min`}
                    </p>
                  </div>
                  <p className={`text-[13px] ${isCurrent ? 'text-[#4a4741]' : 'text-dim'}`}>
                    {isCurrent ? 'You’re here' : isNext ? 'Next stop' : done ? 'Visited' : `${stop.dwellMin} min stay`}
                    {stop.venue.address ? ` · ${stop.venue.address}` : ''}
                  </p>
                  <StopSpecials stop={stop} live={specialsByStop.get(stop.id)} inverted={isCurrent} tz={crawl.timezone} />
                </div>
              </div>
              {isLive && !skipped ? (
                <div className="mt-3 flex flex-wrap gap-2 pl-[52px]">
                  {crawl.permissions.isMember && (isCurrent || done) ? (
                    checked.has(stop.id) ? (
                      <span className={`inline-flex h-9 items-center gap-1.5 text-[14px] font-semibold ${isCurrent ? '' : 'text-dim'}`}>
                        <Check className="size-4" strokeWidth={3} /> Checked in
                      </span>
                    ) : (
                      <Button size="sm" variant={isCurrent ? 'secondary' : 'primary'} className={isCurrent ? '!bg-ink !text-fg' : ''} loading={checkIn.isPending && checkIn.variables === stop.id} onClick={() => checkIn.mutate(stop.id)}>
                        <MapPin className="size-4" /> Check in
                      </Button>
                    )
                  ) : null}
                  {crawl.permissions.canRunLive && isNext ? (
                    <>
                      <Button size="sm" loading={arrive.isPending} onClick={() => arrive.mutate(stop.id)}>
                        We’re here
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => skip.mutate({ stopId: stop.id, skipped: true })}>
                        <SkipForward className="size-4" /> Skip
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {isLive && skipped && crawl.permissions.canRunLive && !stop.arrivedAt ? (
                <div className="mt-3 pl-[52px]">
                  <Button size="sm" variant="secondary" onClick={() => skip.mutate({ stopId: stop.id, skipped: false })}>
                    <Undo2 className="size-4" /> Put back
                  </Button>
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StopSpecials({ stop, live, inverted, tz }: { stop: StopDTO; live?: LiveSpecialDTO[]; inverted: boolean; tz: string }) {
  if (!stop.venue.specials.length) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {stop.venue.specials.map((sp) => {
        const ev = live?.find((l) => l.specialId === sp.id);
        const copy = ev ? STATE_COPY[ev.state] : null;
        const strong = copy?.tone === 'strong';
        const muted = copy?.tone === 'muted';
        const warn = copy?.tone === 'warn';
        return (
          <div key={sp.id} className={`flex items-center justify-between gap-2 rounded-2xl px-3 py-2 ${inverted ? 'bg-ink/10' : strong ? 'bg-amber text-amber-ink' : 'bg-raised'}`}>
            <div className="min-w-0">
              <p className={`truncate text-[14px] font-semibold ${muted ? 'line-through opacity-70' : ''}`}>{sp.title}</p>
              <p className={`truncate text-[12px] ${strong ? 'text-[#5a4210]' : inverted ? 'text-[#4a4741]' : 'text-dim'}`}>
                {sp.label}
                {ev?.hoursUnverified ? ' · hours unverified' : ''}
              </p>
            </div>
            {copy ? (
              <span className={`shrink-0 text-[12px] font-bold uppercase tracking-wide ${warn ? (inverted ? '' : 'text-fg') : muted ? 'opacity-70' : ''}`}>
                {ev!.state === 'projected_miss' && ev!.minutesShort ? `Miss by ${ev!.minutesShort}m` : ev!.state === 'highlight' && ev!.endsAt ? `Until ${fmtTime(ev!.endsAt, tz)}` : copy.label}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
