import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CloudDownload, Navigation2, AlertTriangle, ChevronLeft, Clock, DoorOpen, FlagTriangleRight, LocateFixed, MapPin, Play, Square, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { haversineM, type AtRiskDTO, type CrawlDetailDTO, type LiveSpecialDTO } from '@crawl/core';
import { MapView, type MapStop, type PinState } from '../components/MapView';
import { Button, IconButton, Segmented, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtTime } from '../lib/format';
import { useGeolocation } from '../lib/geo';
import { useOfflineCrawl } from '../lib/offline';
import { getSocket } from '../lib/socket';
import { PushPrompt } from './PushPrompt';
import { SafetyButton } from './Safety';
import { CatchUpCard } from './CatchUp';
import { Chat } from './Chat';
import { Itinerary } from './Itinerary';
import { People } from './People';
import { PhotoGallery } from './PhotoGallery';

export type CrawlTab = 'plan' | 'chat' | 'photos' | 'people';

/** Position updates at most every 30 s while moving; skip if we moved < 20 m. */
function usePositionPublisher(crawlId: string, enabled: boolean) {
  const geo = useGeolocation(enabled);
  const last = useRef<{ at: number; lat: number; lng: number } | null>(null);
  useEffect(() => {
    const p = geo.position;
    if (!enabled || !p) return;
    const now = Date.now();
    const prev = last.current;
    if (prev && now - prev.at < 30_000 && haversineM(prev, p) < 20) return;
    if (prev && now - prev.at < 10_000) return;
    last.current = { at: now, lat: p.lat, lng: p.lng };
    const s = getSocket();
    if (s?.connected) s.emit('position.update', { crawlId, lat: p.lat, lng: p.lng, accuracyM: p.accuracyM });
    else api.position(crawlId, { lat: p.lat, lng: p.lng, accuracyM: p.accuracyM }).catch(() => {});
  }, [geo.position, enabled, crawlId]);
  return geo;
}

export function LiveCrawlView({ crawl, tab, onTab }: { crawl: CrawlDetailDTO; tab: CrawlTab; onTab: (t: CrawlTab) => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const live = crawl.live;
  const isLeader = !!me && live?.leaderUserId === me.id;
  const sharing = isLeader || !!crawl.members.find((m) => m.user.id === me?.id)?.locationSharing;
  const [publish, setPublish] = useState(isLeader);
  // Leadership can move mid-crawl (e.g. a Navigator is assigned); start publishing when it lands here.
  useEffect(() => {
    if (isLeader) setPublish(true);
  }, [isLeader]);
  const geo = usePositionPublisher(crawl.id, publish && sharing && !live?.simulating);

  const set = (c: CrawlDetailDTO) => qc.setQueryData(['crawl', crawl.id], c);
  const onErr = (e: unknown) => toast({ title: errorMessage(e) });
  const depart = useMutation({ mutationFn: () => api.depart(crawl.id), onSuccess: set, onError: onErr });
  const arrive = useMutation({ mutationFn: (stopId: string) => api.arrive(crawl.id, stopId), onSuccess: set, onError: onErr });
  const end = useMutation({ mutationFn: () => api.end(crawl.id), onSuccess: set, onError: onErr });
  const sim = useMutation({ mutationFn: (on: boolean) => api.simulate(crawl.id, on, 8), onSuccess: () => qc.invalidateQueries({ queryKey: ['crawl', crawl.id] }), onError: onErr });
  const fix = useMutation({
    mutationFn: (p: AtRiskDTO['fixes'][number]['patch']) => api.applyFix(crawl.id, p),
    onSuccess: (c) => (set(c), toast({ title: 'Schedule updated', body: 'Everyone has the new plan.' })),
    onError: onErr,
  });
  const toggleSharing = useMutation({
    mutationFn: (on: boolean) => api.updateMyMembership(crawl.id, { locationSharing: on }),
    onSuccess: (_, on) => (setPublish(on), qc.invalidateQueries({ queryKey: ['crawl', crawl.id] })),
    onError: onErr,
  });

  const sched = new Map(live?.schedule.map((s) => [s.stopId, s]) ?? []);
  const current = crawl.stops.find((s) => sched.get(s.id)?.phase === 'current');
  const next = crawl.stops.find((s) => sched.get(s.id)?.phase === 'next');
  const pins: MapStop[] = crawl.stops.map((s, i) => ({
    id: s.id,
    lat: s.venue.lat,
    lng: s.venue.lng,
    number: i + 1,
    name: s.venue.name,
    category: s.venue.category,
    state: (sched.get(s.id)?.phase ?? 'upcoming') as PinState,
  }));

  const drift = Math.round((live?.driftS ?? 0) / 60);
  const offline = useOfflineCrawl(crawl);
  const fitKey = useMemo(() => `${crawl.id}:${current?.id ?? next?.id ?? ''}`, [crawl.id, current?.id, next?.id]);

  return (
    <div className="min-h-full pb-6">
      <MapView
        className="h-[44vh] min-h-[300px]"
        center={live?.position ?? next?.venue ?? crawl.stops[0]?.venue ?? { lat: 38.6083, lng: -90.2052 }}
        zoom={15.5}
        stops={pins}
        route={crawl.approvedRoute?.geometry ?? null}
        group={live?.position ?? null}
        me={!isLeader ? geo.position : null}
        fitKey={fitKey}
        padding={{ top: 110, bottom: 50, left: 50, right: 50 }}
      >
        <div className="absolute inset-x-0 top-0 flex items-start gap-3 p-4" style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}>
          <IconButton label="Back" className="bg-ink/90 shadow-float" onClick={() => nav('/my-crawls')}>
            <ChevronLeft className="size-5" />
          </IconButton>
          <div className="min-w-0 flex-1 rounded-2xl bg-ink/90 px-4 py-2 shadow-float backdrop-blur">
            <p className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.14em]">
              <span className="relative flex size-2.5">
                <span className="pulse-ring absolute inline-flex size-full rounded-full bg-alert" />
                <span className="relative inline-flex size-2.5 rounded-full bg-alert" />
              </span>
              Live
              <span className="font-semibold normal-case tracking-normal text-dim">
                · {Math.abs(drift) <= 2 ? 'On schedule' : drift > 0 ? `${drift} min behind` : `${-drift} min ahead`}
              </span>
            </p>
            <p className="truncate font-display text-[18px] font-semibold">{crawl.title}</p>
            {offline === 'ready' ? (
              <p className="flex items-center gap-1 text-[11px] font-semibold text-dim">
                <CloudDownload className="size-3.5" /> Saved for offline
              </p>
            ) : offline === 'saving' ? (
              <p className="text-[11px] font-semibold text-dim">Saving map for offline…</p>
            ) : null}
          </div>
          <SafetyButton crawl={crawl} />
        </div>
      </MapView>

      <div className="relative z-10 -mt-6 space-y-3 rounded-t-[28px] border-t border-line bg-ink px-4 pt-5">
        {/* Where we are / next */}
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-bold uppercase tracking-[0.14em] text-dim">{current ? 'You’re at' : next ? 'Heading to' : 'All stops done'}</p>
            <p className="line-clamp-2 font-display text-[24px] font-bold leading-[1.1]">{(current ?? next)?.venue.name ?? 'Nice work'}</p>
            {next && !current ? (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[15px] text-dim tabular">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="size-4" /> ETA {fmtTime(sched.get(next.id)?.eta, crawl.timezone)}
                </span>
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${next.venue.lat},${next.venue.lng}&travelmode=walking`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-amber"
                >
                  <Navigation2 className="size-4" /> Walking directions
                </a>
              </p>
            ) : current ? (
              <p className="flex items-center gap-1.5 text-[15px] text-dim tabular">
                <Clock className="size-4" /> Leave by {fmtTime(sched.get(current.id)?.departure, crawl.timezone)}
                {next ? ` · then ${next.venue.name}` : ''}
              </p>
            ) : null}
          </div>
          {crawl.permissions.canRunLive ? (
            current ? (
              <Button variant="secondary" loading={depart.isPending} onClick={() => depart.mutate()}>
                <DoorOpen className="size-4" /> Leave now
              </Button>
            ) : next ? (
              <Button loading={arrive.isPending} onClick={() => arrive.mutate(next.id)}>
                <MapPin className="size-4" /> We’re here
              </Button>
            ) : null
          ) : null}
        </div>

        <CatchUpCard crawl={crawl} />
        <LiveAlerts alerts={rankAlerts(live?.specials ?? [], live?.atRisk ?? [], current?.id ?? null)} tz={crawl.timezone} applying={fix.isPending} onApply={(p) => fix.mutate(p)} />

        {/* Location + host tools */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {isLeader ? (
            <Button size="sm" variant={publish ? 'secondary' : 'primary'} onClick={() => setPublish((x) => !x)}>
              <LocateFixed className="size-4" /> {publish ? 'Sharing group location' : 'Share group location'}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" loading={toggleSharing.isPending} onClick={() => toggleSharing.mutate(!sharing)}>
              <LocateFixed className="size-4" /> {sharing ? 'Stop sharing my location' : 'Share my location'}
            </Button>
          )}
          {crawl.permissions.canRunLive && import.meta.env.DEV ? (
            <Button size="sm" variant="secondary" loading={sim.isPending} onClick={() => sim.mutate(!live?.simulating)}>
              {live?.simulating ? <Square className="size-4" /> : <Play className="size-4" />} {live?.simulating ? 'Stop walk sim' : 'Simulate walk'}
            </Button>
          ) : null}
          {crawl.permissions.canRunLive ? (
            <Button size="sm" variant="ghost" className="text-dim" loading={end.isPending} onClick={() => confirm('End the crawl for everyone?') && end.mutate()}>
              <FlagTriangleRight className="size-4" /> End crawl
            </Button>
          ) : null}
        </div>
        {isLeader ? (
          <p className="text-[13px] text-dim">
            You’re leading: your phone’s location is “the group” for arrivals and ETAs. Keep Crawl open while walking.
          </p>
        ) : null}
        <PushPrompt />
        {geo.error && publish ? <p className="text-[13px] text-dim">{geo.error}. The organizer can still tap “We’re here”.</p> : null}

        <div className="sticky top-0 z-20 -mx-4 bg-ink px-4 py-3">
          <Segmented
            value={tab}
            onChange={onTab}
            options={[
              { value: 'plan', label: 'Plan' },
              { value: 'chat', label: 'Chat' },
              { value: 'photos', label: 'Photos' },
              { value: 'people', label: 'People' },
            ]}
          />
        </div>
        {tab === 'plan' ? <Itinerary crawl={crawl} /> : tab === 'chat' ? <Chat crawl={crawl} /> : tab === 'photos' ? <PhotoGallery crawl={crawl} /> : <People crawl={crawl} />}
      </div>
    </div>
  );
}

type Alert =
  | { kind: 'highlight'; key: string; rank: number; special: LiveSpecialDTO; current: boolean }
  | { kind: 'risk'; key: string; rank: number; risk: AtRiskDTO }
  | { kind: 'miss'; key: string; rank: number; special: LiveSpecialDTO };

/**
 * One ranked list instead of stacked cards: each special appears once, in the richest form the
 * viewer can act on (hosts get fixes; everyone else gets the warning). The top alert is full size;
 * the rest collapse into compact rows.
 */
export function rankAlerts(specials: LiveSpecialDTO[], atRisk: AtRiskDTO[], currentStopId: string | null): Alert[] {
  const out: Alert[] = [];
  const riskKeys = new Set(atRisk.map((r) => `${r.stopId}:${r.specialId}`));
  for (const r of atRisk) {
    const rescuable = r.fixes.some((f) => f.catchesSpecial);
    out.push({ kind: 'risk', key: `${r.stopId}:${r.specialId}`, rank: rescuable ? 1 : 4, risk: r });
  }
  for (const s of specials) {
    const key = `${s.stopId}:${s.specialId}`;
    if (riskKeys.has(key)) continue;
    if (s.state === 'highlight') {
      const current = s.stopId === currentStopId;
      out.push({ kind: 'highlight', key, rank: current ? 0 : 2, special: s, current });
    } else if (s.state === 'at_risk' || s.state === 'projected_miss') {
      out.push({ kind: 'miss', key, rank: s.state === 'at_risk' ? 3 : 5, special: s });
    }
  }
  return out.sort((a, b) => a.rank - b.rank);
}

function LiveAlerts({ alerts, tz, applying, onApply }: { alerts: Alert[]; tz: string; applying: boolean; onApply: (p: AtRiskDTO['fixes'][number]['patch']) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!alerts.length) return null;
  const [top, ...rest] = alerts;
  const full = (a: Alert) =>
    a.kind === 'highlight' ? (
      <HighlightCard key={a.key} special={a.special} tz={tz} current={a.current} />
    ) : a.kind === 'risk' ? (
      <AtRiskCard key={a.key} risk={a.risk} tz={tz} applying={applying} onApply={onApply} />
    ) : (
      <MissCard key={a.key} special={a.special} tz={tz} />
    );
  return (
    <div className="space-y-2" aria-label="Alerts">
      {full(top)}
      {rest.length ? (
        expanded ? (
          rest.map(full)
        ) : (
          <button onClick={() => setExpanded(true)} className="w-full rounded-2xl border border-line bg-surface px-4 py-3 text-left">
            <span className="flex items-center justify-between text-[14px] font-semibold">
              {rest.length} more alert{rest.length > 1 ? 's' : ''}
              <span className="text-dim">Show</span>
            </span>
            <span className="mt-0.5 block truncate text-[13px] text-dim">
              {rest.map((a) => (a.kind === 'risk' ? `${a.risk.title} at ${a.risk.venueName}` : `${a.special.title} at ${a.special.venueName}`)).join(' · ')}
            </span>
          </button>
        )
      ) : null}
    </div>
  );
}

/** The one place we go loud: solid amber, black type. */
function HighlightCard({ special, tz, current }: { special: LiveSpecialDTO; tz: string; current: boolean }) {
  return (
    <section aria-label="Special highlight" className="rounded-3xl bg-amber p-4 text-amber-ink shadow-float">
      <p className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.14em]">
        <Zap className="size-4 fill-current" /> {current ? 'Live here now' : 'Live when you arrive'}
      </p>
      <p className="mt-1 font-display text-[24px] font-bold leading-tight">{special.title}</p>
      <p className="mt-0.5 text-[15px] font-medium">
        {special.venueName}
        {special.details ? ` · ${special.details}` : ''}
      </p>
      <p className="mt-2 text-[14px] font-semibold tabular">
        Until {fmtTime(special.endsAt, tz)}
        {!current && special.eta ? ` · you arrive ${fmtTime(special.eta, tz)}` : ''}
        {special.hoursUnverified ? ' · hours unverified' : ''}
      </p>
    </section>
  );
}

function MissCard({ special, tz }: { special: LiveSpecialDTO; tz: string }) {
  return (
    <section aria-label="Special will be missed" className="flex gap-3 rounded-3xl bg-raised p-4">
      <AlertTriangle className="mt-0.5 size-5 shrink-0 text-fg" />
      <div className="min-w-0">
        <p className="text-[16px] font-semibold">
          {special.title} at {special.venueName} ends {fmtTime(special.endsAt, tz)}
        </p>
        <p className="mt-0.5 text-[14px] text-dim">
          At this pace you arrive {fmtTime(special.eta, tz)}
          {special.minutesShort ? `, ${special.minutesShort} min too late` : ''}.
        </p>
      </div>
    </section>
  );
}

function AtRiskCard({ risk, tz, onApply, applying }: { risk: AtRiskDTO; tz: string; onApply: (p: AtRiskDTO['fixes'][number]['patch']) => void; applying: boolean }) {
  const late = risk.minutesShort && risk.state === 'projected_miss' ? `${risk.minutesShort} min late` : 'under 10 min to spare';
  return (
    <section aria-label="Special at risk" className="rounded-3xl border border-line-strong bg-surface p-4">
      <p className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-dim">
        <AlertTriangle className="size-3.5" /> {risk.state === 'at_risk' ? 'Cutting it close' : 'Will miss'} · only hosts see fixes
      </p>
      <p className="mt-1.5 text-[17px] font-semibold leading-snug">
        {risk.title} at {risk.venueName}
      </p>
      <p className="text-[14px] text-dim tabular">
        Ends {fmtTime(risk.endsAt, tz)} · ETA {fmtTime(risk.eta, tz)} ({late})
      </p>
      {risk.fixes.length ? (
        <div className="mt-3 grid gap-2">
          {risk.fixes.map((f, i) => (
            <button
              key={f.kind}
              disabled={applying}
              onClick={() => onApply(f.patch)}
              className={`rounded-2xl px-4 py-3 text-left transition active:scale-[0.99] disabled:opacity-50 ${i === 0 ? 'bg-amber text-amber-ink' : 'border border-line bg-raised'}`}
            >
              <span className="block text-[15px] font-semibold leading-snug">{f.label}</span>
              <span className={`mt-0.5 block text-[13px] font-medium ${i === 0 ? 'text-[#5a4210]' : 'text-dim'}`}>
                Saves {Math.round(f.minutesSaved)} min · {f.catchesSpecial ? 'makes it in time' : 'still late'}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-[14px] text-dim">No schedule change gets you there in time.</p>
      )}
    </section>
  );
}
