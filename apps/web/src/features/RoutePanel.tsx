import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Clock, Footprints, Leaf, Ruler, Sparkles, Tag as TagIcon, Timer, VolumeX, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CrawlDetailDTO, PreferenceTag, RouteDTO } from '@crawl/core';
import { Button, Chip, Spinner, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { EventBanner, WeatherCard } from './Conditions';
import { fmtDistance, fmtDuration, fmtTime } from '../lib/format';

const PREFS: { tag: PreferenceTag; label: string; icon: React.ReactNode }[] = [
  { tag: 'fastest', label: 'Fastest', icon: <Zap className="size-4" /> },
  { tag: 'specials', label: 'Catch specials', icon: <TagIcon className="size-4" /> },
  { tag: 'quieter', label: 'Quieter streets', icon: <VolumeX className="size-4" /> },
  { tag: 'scenic', label: 'Scenic', icon: <Leaf className="size-4" /> },
  { tag: 'short_walks', label: 'Short walks', icon: <Footprints className="size-4" /> },
];

/** Organizer-facing optimizer: preferences in, proposed route out, approve or iterate. */
export function RoutePanel({ crawl, onRouteChange }: { crawl: CrawlDetailDTO; onRouteChange: (r: RouteDTO | null) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tags, setTags] = useState<PreferenceTag[]>(['specials']);
  const [note, setNote] = useState('');
  const [routeId, setRouteId] = useState<string | null>(crawl.latestProposal?.id ?? null);

  const route = useQuery({
    queryKey: ['route', crawl.id, routeId],
    queryFn: () => api.route(crawl.id, routeId!),
    enabled: !!routeId,
    refetchInterval: (q) => (q.state.data?.status === 'pending' ? 1000 : false),
  });
  const shown = route.data && route.data.status !== 'superseded' ? route.data : crawl.approvedRoute;
  useEffect(() => onRouteChange(shown ?? null), [shown, onRouteChange]);

  const optimize = useMutation({
    mutationFn: (order?: string[]) => api.optimize(crawl.id, { tags, note: note || undefined, order }),
    onSuccess: (r) => setRouteId(r.routeId),
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  const approve = useMutation({
    mutationFn: () => api.approveRoute(crawl.id, shown!.id),
    onSuccess: (c) => {
      qc.setQueryData(['crawl', crawl.id], c);
      qc.invalidateQueries({ queryKey: ['route', crawl.id] });
      toast({ title: 'Route approved', body: 'Everyone on the crawl now sees the final order and times.' });
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });

  const toggle = (t: PreferenceTag) =>
    setTags((cur) => {
      if (t === 'fastest') return ['fastest'];
      const next = cur.includes(t) ? cur.filter((x) => x !== t) : [...cur.filter((x) => x !== 'fastest'), t];
      return next.length ? next : ['fastest'];
    });

  const tooFew = crawl.stops.length < 2;
  const pending = optimize.isPending || route.data?.status === 'pending';

  return (
    <div className="space-y-5">
      <EventBanner events={crawl.events} tz={crawl.timezone} compact />
      <WeatherCard weather={crawl.weather} tz={crawl.timezone} compact />
      <div>
        <p className="text-[13px] font-semibold uppercase tracking-wider text-dim">Optimize for</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {PREFS.map((p) => (
            <Chip key={p.tag} active={tags.includes(p.tag)} icon={p.icon} onClick={() => toggle(p.tag)}>
              {p.label}
            </Chip>
          ))}
        </div>
        <textarea
          className="mt-3 h-20 w-full rounded-2xl border border-line bg-raised px-4 py-3 text-[15px] outline-none placeholder:text-faint focus:border-amber"
          placeholder="Anything else? e.g. “avoid Broadway after 10, keep walks under 10 minutes”"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="mt-3 flex gap-2">
          <Button className="flex-1" loading={pending} disabled={tooFew} onClick={() => optimize.mutate(undefined)}>
            <Sparkles className="size-4" /> {shown ? 'Re-optimize' : 'Optimize route'}
          </Button>
          <Button variant="secondary" disabled={tooFew || pending} onClick={() => optimize.mutate(crawl.stops.map((s) => s.id))}>
            Use my order
          </Button>
        </div>
        {tooFew ? <p className="mt-2 text-[14px] text-dim">Add at least two stops to plan a route.</p> : null}
      </div>

      {pending ? (
        <div className="flex items-center gap-3 rounded-2xl border border-line p-4 text-[15px] text-dim">
          <Spinner /> Pulling walking times and solving the best order…
        </div>
      ) : route.data?.status === 'failed' ? (
        <p className="rounded-2xl border border-line p-4 text-[15px]">Optimization failed: {route.data.error}. Try again.</p>
      ) : shown ? (
        <RouteReview crawl={crawl} route={shown} onApprove={() => approve.mutate()} approving={approve.isPending} />
      ) : null}
    </div>
  );
}

function Delta({ value, unit, better }: { value: number; unit: 'min' | 'dist' | 'count'; better: 'lower' | 'higher' }) {
  if (Math.abs(value) < (unit === 'dist' ? 30 : 0.5)) return <span className="text-[12px] text-faint">same as your order</span>;
  const good = better === 'lower' ? value < 0 : value > 0;
  const mag = unit === 'min' ? `${Math.round(Math.abs(value))} min` : unit === 'dist' ? fmtDistance(Math.abs(value)) : `${Math.abs(value)}`;
  return (
    <span className={`text-[12px] font-semibold ${good ? 'text-live' : 'text-dim'}`}>
      {value < 0 ? '−' : '+'}
      {mag} vs your order
    </span>
  );
}

export function RouteReview({ crawl, route, onApprove, approving }: { crawl: CrawlDetailDTO; route: RouteDTO; onApprove?: () => void; approving?: boolean }) {
  const byId = new Map(crawl.stops.map((s) => [s.id, s]));
  const specialTitle = (stopId: string, id: string) => byId.get(stopId)?.venue.specials.find((s) => s.id === id)?.title ?? 'Special';
  const b = route.baseline;
  const approved = route.status === 'approved';
  const metrics = [
    { icon: <Ruler className="size-4" />, label: 'Distance', value: fmtDistance(route.totalDistanceM), delta: b ? <Delta value={route.totalDistanceM - b.totalDistanceM} unit="dist" better="lower" /> : null },
    { icon: <Footprints className="size-4" />, label: 'Walking', value: fmtDuration(route.totalWalkS), delta: b ? <Delta value={(route.totalWalkS - b.totalWalkS) / 60} unit="min" better="lower" /> : null },
    { icon: <Timer className="size-4" />, label: 'Total', value: fmtDuration(route.totalS), delta: b ? <Delta value={(route.totalS - b.totalS) / 60} unit="min" better="lower" /> : null },
    { icon: <TagIcon className="size-4" />, label: 'Specials', value: `${route.caughtCount} caught`, delta: b ? <Delta value={route.caughtCount - b.caughtCount} unit="count" better="higher" /> : null },
  ];
  return (
    <section aria-label="Proposed route" className="rounded-3xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="font-display text-[20px] font-semibold">{approved ? 'Approved route' : 'Proposed route'}</p>
        <span className="text-[12px] text-faint">{route.method?.replace('/', ' · ')}</span>
      </div>
      {route.explanation ? <p className="mt-2 text-[15px] leading-relaxed text-fg/90">{route.explanation}</p> : null}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {metrics.map((m) => (
          <div key={m.label} className="rounded-2xl bg-raised p-3">
            <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wider text-dim">
              {m.icon}
              {m.label}
            </p>
            <p className="mt-1 text-[20px] font-semibold tabular">{m.value}</p>
            {!approved ? m.delta : null}
          </div>
        ))}
      </div>
      {route.violations.length ? <p className="mt-3 text-[14px] font-semibold">Some walks exceed your limit. Consider dropping the farthest stop.</p> : null}
      <ol className="mt-4 space-y-0">
        {route.stops.map((m, i) => {
          const stop = byId.get(m.stopId);
          const leg = route.legs[i - 1];
          return (
            <li key={m.stopId}>
              {leg ? (
                <p className="ml-[15px] flex items-center gap-2 border-l-2 border-dashed border-amber/50 py-2 pl-5 text-[13px] text-dim">
                  <Footprints className="size-3.5" /> {fmtDuration(leg.walkS)} · {fmtDistance(leg.distanceM)}
                </p>
              ) : null}
              <div className="flex gap-3">
                <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-amber text-[13px] font-bold">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-[16px] font-semibold">{stop?.venue.name}</p>
                    <p className="shrink-0 text-[14px] text-dim tabular">
                      <Clock className="mr-1 inline size-3.5" />
                      {fmtTime(m.arrival, crawl.timezone)}
                    </p>
                  </div>
                  {m.waitS > 60 ? <p className="text-[13px] text-dim">Waits {fmtDuration(m.waitS)} for opening</p> : null}
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {m.caught.map((id) => (
                      <span key={id} className="inline-flex h-7 items-center gap-1 rounded-full bg-amber px-2.5 text-[12px] font-semibold text-amber-ink">
                        <Check className="size-3.5" strokeWidth={3} /> {specialTitle(m.stopId, id)}
                      </span>
                    ))}
                    {m.missed.map((id) => (
                      <span key={id} className="inline-flex h-7 items-center rounded-full border border-line px-2.5 text-[12px] text-dim line-through">
                        {specialTitle(m.stopId, id)}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {!approved && onApprove ? (
        <Button size="lg" className="mt-5 w-full" loading={approving} onClick={onApprove} disabled={!crawl.permissions.canApprove}>
          <Check className="size-5" strokeWidth={2.5} /> {crawl.permissions.canApprove ? 'Approve route' : 'Only the organizer can approve'}
        </Button>
      ) : null}
    </section>
  );
}
