import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Lock, LockOpen, Minus, Plus, Search, Tag as TagIcon, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { CrawlDetailDTO, RouteDTO, StopDTO } from '@crawl/core';
import { MapView } from '../components/MapView';
import { Button, Empty, PageSpinner, Segmented, Sheet, TopBar, errorMessage, inputCls, useToast } from '../components/ui';
import { InvitePanel } from '../features/InvitePanel';
import { RoutePanel } from '../features/RoutePanel';
import { SpecialForm, SpecialRow, VenueSheet } from '../features/VenueSheet';
import { api } from '../lib/api';
import { fmtDuration, fmtWhen } from '../lib/format';
import { useCrawlChannel } from '../lib/socket';
import { VenueRow } from './Explore';

type Step = 'stops' | 'route' | 'invite';

export function PlanCrawl() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [step, setStep] = useState<Step>('stops');
  const [q, setQ] = useState('');
  const [venueId, setVenueId] = useState<string | null>(null);
  const [specialFor, setSpecialFor] = useState<StopDTO | null>(null);
  const [shownRoute, setShownRoute] = useState<RouteDTO | null>(null);
  const crawl = useQuery({ queryKey: ['crawl', id], queryFn: () => api.crawl(id!) });
  useCrawlChannel(id, !!crawl.data?.permissions.isMember);
  const hood = crawl.data?.neighborhoodId ?? 'soulard';
  const venues = useQuery({ queryKey: ['venues', hood], queryFn: () => api.venues({ neighborhood: hood, limit: 200 }) });
  const search = useQuery({ queryKey: ['venue-search', hood, q], queryFn: () => api.venues({ neighborhood: hood, q, limit: 20 }), enabled: q.length > 1 });

  const set = (c: CrawlDetailDTO) => qc.setQueryData(['crawl', id], c);
  const onErr = (e: unknown) => toast({ title: errorMessage(e) });
  const addStop = useMutation({ mutationFn: (venueId: string) => api.addStop(id!, venueId), onSuccess: (c) => (set(c), setQ('')), onError: onErr });
  const removeStop = useMutation({ mutationFn: (stopId: string) => api.removeStop(id!, stopId), onSuccess: set, onError: onErr });
  const updateStop = useMutation({ mutationFn: (v: { stopId: string; dwellMin?: number; locked?: boolean }) => api.updateStop(id!, v.stopId, v), onSuccess: set, onError: onErr });
  const reorder = useMutation({ mutationFn: (order: string[]) => api.reorderStops(id!, order), onSuccess: set, onError: onErr });
  const onRouteChange = useCallback((r: RouteDTO | null) => setShownRoute(r), []);

  const c = crawl.data;
  const stopVenueIds = useMemo(() => new Set(c?.stops.map((s) => s.venue.id)), [c?.stops]);
  if (crawl.isLoading) return <PageSpinner />;
  if (!c) return <Empty icon={<Search className="size-6" />} title="Crawl not found" />;
  if (!c.permissions.canEdit)
    return (
      <div>
        <TopBar title={c.title} />
        <Empty icon={<Lock className="size-6" />} title="Only hosts can edit this plan" action={<Button onClick={() => nav(`/crawls/${c.id}`)}>Back to crawl</Button>} />
      </div>
    );

  const routeForMap = step === 'route' ? (shownRoute ?? c.approvedRoute) : c.approvedRoute;
  const order = routeForMap ? routeForMap.stopOrder : c.stops.map((s) => s.id);
  const pins = c.stops
    .map((s) => ({ s, i: order.indexOf(s.id) }))
    .map(({ s, i }) => ({ id: s.id, lat: s.venue.lat, lng: s.venue.lng, number: (i >= 0 ? i : s.position) + 1, name: s.venue.name, category: s.venue.category }));
  const totalMin = c.stops.reduce((t, s) => t + s.dwellMin, 0);
  const move = (i: number, d: -1 | 1) => {
    const ids = c.stops.map((s) => s.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    reorder.mutate(ids);
  };

  return (
    <div className="min-h-full pb-28">
      <TopBar
        title={c.title}
        back={`/crawls/${c.id}`}
        right={
          <Link to={`/crawls/${c.id}`} className="text-[15px] font-semibold text-amber">
            Done
          </Link>
        }
      />
      <MapView
        className="h-[34vh] min-h-[240px]"
        center={c.stops[0]?.venue ?? { lat: 38.6083, lng: -90.2052 }}
        zoom={15.3}
        stops={pins}
        route={routeForMap?.geometry ?? null}
        venues={(venues.data ?? []).filter((v) => !stopVenueIds.has(v.id)).map((v) => ({ id: v.id, lat: v.lat, lng: v.lng, name: v.name, category: v.category, hasSpecial: v.specials.length > 0 }))}
        fitKey={`${c.stops.length}:${routeForMap?.id ?? ''}`}
        onVenueClick={setVenueId}
        onStopClick={(sid) => setVenueId(c.stops.find((s) => s.id === sid)?.venue.id ?? null)}
      />
      <div className="sticky top-16 z-20 border-b border-line bg-ink px-4 py-3">
        <Segmented
          value={step}
          onChange={setStep}
          options={[
            { value: 'stops', label: `Stops · ${c.stops.length}` },
            { value: 'route', label: c.approvedRoute ? 'Route ✓' : 'Route' },
            { value: 'invite', label: 'Invite' },
          ]}
        />
      </div>

      <div className="px-4 pt-4">
        <p className="mb-4 text-[14px] text-dim">
          {fmtWhen(c.startAt, c.timezone)} · {c.visibility === 'public' ? 'Public' : 'Invite only'}
          {c.stops.length ? ` · ~${fmtDuration(totalMin * 60)} at bars` : ''}
        </p>

        {step === 'stops' ? (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-dim" />
              <input className={`${inputCls} pl-12`} placeholder="Add a bar — search or tap the map" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {q.length > 1 ? (
              <div className="mt-2 rounded-2xl border border-line bg-surface p-1">
                {(search.data ?? []).map((v) => (
                  <VenueRow
                    key={v.id}
                    venue={v}
                    onClick={() => setVenueId(v.id)}
                    right={
                      stopVenueIds.has(v.id) ? (
                        <span className="px-3 text-[13px] text-dim">Added</span>
                      ) : (
                        <Button size="sm" onClick={() => addStop.mutate(v.id)} loading={addStop.isPending && addStop.variables === v.id}>
                          <Plus className="size-4" /> Add
                        </Button>
                      )
                    }
                  />
                ))}
                {search.data?.length === 0 ? <p className="p-4 text-center text-[14px] text-dim">No bars found.</p> : null}
              </div>
            ) : null}

            <ol className="mt-5 space-y-3">
              {c.stops.map((s, i) => (
                <li key={s.id} className="rounded-3xl border border-line bg-surface p-4">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border-2 border-amber text-[13px] font-bold">{i + 1}</span>
                    <button className="min-w-0 flex-1 text-left" onClick={() => setVenueId(s.venue.id)}>
                      <p className="truncate text-[17px] font-semibold">{s.venue.name}</p>
                      <p className="truncate text-[13px] text-dim">{s.venue.address ?? s.venue.tags.join(' · ')}</p>
                    </button>
                    <div className="flex shrink-0 gap-1">
                      <button aria-label="Move up" disabled={i === 0 || reorder.isPending} onClick={() => move(i, -1)} className="flex size-9 items-center justify-center rounded-full border border-line disabled:opacity-30">
                        <ArrowUp className="size-4" />
                      </button>
                      <button aria-label="Move down" disabled={i === c.stops.length - 1 || reorder.isPending} onClick={() => move(i, 1)} className="flex size-9 items-center justify-center rounded-full border border-line disabled:opacity-30">
                        <ArrowDown className="size-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1 rounded-full border border-line p-1">
                      <button aria-label="Shorter stay" className="flex size-8 items-center justify-center rounded-full hover:bg-raised" onClick={() => updateStop.mutate({ stopId: s.id, dwellMin: Math.max(10, s.dwellMin - 5) })}>
                        <Minus className="size-4" />
                      </button>
                      <span className="w-16 text-center text-[14px] font-semibold tabular">{s.dwellMin} min</span>
                      <button aria-label="Longer stay" className="flex size-8 items-center justify-center rounded-full hover:bg-raised" onClick={() => updateStop.mutate({ stopId: s.id, dwellMin: Math.min(180, s.dwellMin + 5) })}>
                        <Plus className="size-4" />
                      </button>
                    </div>
                    <div className="flex gap-1">
                      <button
                        aria-pressed={s.locked}
                        aria-label={s.locked ? 'Unlock position' : 'Lock position'}
                        title="Locked stops keep their position when optimizing"
                        onClick={() => updateStop.mutate({ stopId: s.id, locked: !s.locked })}
                        className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold ${s.locked ? 'bg-fg text-ink' : 'border border-line text-dim'}`}
                      >
                        {s.locked ? <Lock className="size-3.5" /> : <LockOpen className="size-3.5" />} {s.locked ? 'Locked' : 'Lock'}
                      </button>
                      <button aria-label="Add special" onClick={() => setSpecialFor(s)} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line px-3 text-[13px] font-semibold">
                        <TagIcon className="size-3.5" /> Special
                      </button>
                      <button aria-label={`Remove ${s.venue.name}`} onClick={() => removeStop.mutate(s.id)} className="flex size-9 items-center justify-center rounded-full border border-line text-dim hover:text-fg">
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                  {s.venue.specials.length ? (
                    <div className="mt-3 space-y-1.5">
                      {s.venue.specials.map((sp) => (
                        <SpecialRow key={sp.id} special={sp} />
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ol>
            {c.stops.length === 0 ? <p className="mt-6 text-center text-[15px] text-dim">Tap bars on the map or search to add your first stop.</p> : null}
            {c.stops.length >= 2 ? (
              <Button size="lg" className="mt-6 w-full" onClick={() => setStep('route')}>
                Next: plan the route
              </Button>
            ) : null}
          </>
        ) : step === 'route' ? (
          <>
            <RoutePanel crawl={c} onRouteChange={onRouteChange} />
            {c.approvedRoute ? (
              <Button variant="secondary" size="lg" className="mt-4 w-full" onClick={() => setStep('invite')}>
                Next: invite people
              </Button>
            ) : null}
          </>
        ) : (
          <InvitePanel crawl={c} />
        )}
      </div>

      <VenueSheet
        venueId={venueId}
        onClose={() => setVenueId(null)}
        actions={(v) =>
          stopVenueIds.has(v.id) ? (
            <Button variant="secondary" className="flex-1" onClick={() => (removeStop.mutate(c.stops.find((s) => s.venue.id === v.id)!.id), setVenueId(null))}>
              Remove from crawl
            </Button>
          ) : (
            <Button className="flex-1" loading={addStop.isPending} onClick={() => addStop.mutate(v.id, { onSuccess: () => setVenueId(null) })}>
              <Plus className="size-4" /> Add to crawl
            </Button>
          )
        }
      />
      <Sheet open={!!specialFor} onClose={() => setSpecialFor(null)} title={specialFor ? `Special at ${specialFor.venue.name}` : ''}>
        {specialFor ? (
          <div className="pb-2">
            <p className="mb-4 text-[14px] text-dim">Organizer specials apply to this crawl only and feed the route optimizer and live alerts.</p>
            <SpecialForm
              venueId={specialFor.venue.id}
              crawlId={c.id}
              onDone={() => {
                setSpecialFor(null);
                qc.invalidateQueries({ queryKey: ['crawl', id] });
                toast({ title: 'Special added' });
              }}
            />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
