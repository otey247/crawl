import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Footprints, MapPin, Navigation2 } from 'lucide-react';
import { useEffect } from 'react';
import { estimateWalk, haversineM, type CrawlDetailDTO } from '@crawl/core';
import { Button, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDistance, fmtTime } from '../lib/format';
import { useGeolocation } from '../lib/geo';

const HERE_M = 60;

/**
 * For anyone not with the group yet (late, stepped out, joined mid-crawl): where the group is,
 * how far, walking directions, and an "On my way" that tells the crew. Arrival is confirmed
 * automatically on check-in or, with location sharing on, when they reach the bar.
 */
export function CatchUpCard({ crawl }: { crawl: CrawlDetailDTO }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const geo = useGeolocation(false);
  const live = crawl.live;
  const mine = crawl.members.find((m) => m.user.id === me?.id);
  const checkIns = useQuery({ queryKey: ['check-ins', crawl.id], queryFn: () => api.myCheckIns(crawl.id), enabled: !!mine });

  // Only use location if it was already granted; never prompt from a passive card.
  useEffect(() => {
    navigator.permissions
      ?.query({ name: 'geolocation' as PermissionName })
      .then((p) => p.state === 'granted' && geo.request())
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['crawl', crawl.id] });
    qc.invalidateQueries({ queryKey: ['check-ins', crawl.id] });
  };
  const onError = (e: unknown) => toast({ title: errorMessage(e) });
  const start = useMutation({
    mutationFn: () => api.catchUp(crawl.id, geo.position ? { lat: geo.position.lat, lng: geo.position.lng } : undefined),
    onSuccess: (r) => (refresh(), toast({ title: 'The crew knows you’re coming', body: r.walkMin ? `About ${r.walkMin} min to ${r.stopName}.` : `Meet them at ${r.stopName}.` })),
    onError,
  });
  const cancel = useMutation({ mutationFn: () => api.cancelCatchUp(crawl.id), onSuccess: refresh, onError });

  const sched = new Map(live?.schedule.map((s) => [s.stopId, s]) ?? []);
  const current = crawl.stops.find((s) => sched.get(s.id)?.phase === 'current');
  const next = crawl.stops.find((s) => sched.get(s.id)?.phase === 'next');
  const target = current ?? next;
  const checkInHere = useMutation({
    mutationFn: () => api.checkIn(crawl.id, target!.id, geo.position ? { lat: geo.position.lat, lng: geo.position.lng } : undefined),
    onSuccess: () => (refresh(), toast({ title: 'You’re with the group', body: 'Checked in.' })),
    onError,
  });

  if (!mine || !live || !target || live.leaderUserId === me?.id) return null;
  const catching = !!mine.catchingUpSince;
  const checkedInHere = !!current && !!checkIns.data?.some((c) => c.stopId === current.id);
  // With the group at a stop you've checked into, or walking with them, there's nothing to catch up on.
  if (!catching && (checkedInHere || !current)) return null;

  const dist = geo.position ? haversineM(geo.position, target.venue) : null;
  const walkMin = geo.position ? Math.max(1, Math.round(estimateWalk(geo.position, target.venue).walkS / 60)) : null;
  const here = dist != null && dist <= HERE_M;
  const directions = `https://www.google.com/maps/dir/?api=1&destination=${target.venue.lat},${target.venue.lng}&travelmode=walking`;

  return (
    <section aria-label="Catch up with the group" className="rounded-3xl border border-line-strong bg-surface p-4">
      <p className="flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-[0.14em] text-dim">
        <Footprints className="size-3.5" /> {catching ? 'On your way' : 'Catch up'}
      </p>
      <p className="mt-1.5 text-[17px] font-semibold leading-snug">
        {current ? `The group is at ${current.venue.name}` : `The group is heading to ${next!.venue.name}`}
        {current?.arrivedAt ? <span className="font-normal text-dim"> · since {fmtTime(current.arrivedAt, crawl.timezone)}</span> : null}
      </p>
      <p className="text-[14px] text-dim tabular">
        {here ? 'You’re here.' : dist != null ? `${fmtDistance(dist)} away · about ${walkMin} min walk` : target.venue.address ?? ''}
        {catching ? ' The crew knows you’re coming.' : ''}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {here || (catching && current) ? (
          <Button size="sm" loading={checkInHere.isPending} onClick={() => checkInHere.mutate()}>
            <MapPin className="size-4" /> I’m here, check in
          </Button>
        ) : null}
        {!here ? (
          <a href={directions} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong bg-raised px-3.5 text-[14px] font-semibold">
            <Navigation2 className="size-4" /> Walking directions
          </a>
        ) : null}
        {!catching && !here ? (
          <Button size="sm" loading={start.isPending} onClick={() => start.mutate()}>
            On my way
          </Button>
        ) : null}
        {catching ? (
          <Button size="sm" variant="ghost" className="text-dim" loading={cancel.isPending} onClick={() => cancel.mutate()}>
            Cancel
          </Button>
        ) : null}
      </div>
    </section>
  );
}
