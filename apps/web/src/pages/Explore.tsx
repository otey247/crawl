import { useQuery } from '@tanstack/react-query';
import { CalendarDays, ChevronDown, ChevronRight, Footprints, Navigation, Plus, Search, SlidersHorizontal, Tag as TagIcon, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { haversineM, type CrawlSummaryDTO, type VenueDTO } from '@crawl/core';
import { CategoryIcon, VenueImage } from '../components/domain';
import { MapView, type MapStop } from '../components/MapView';
import { AvatarStack, Button, Chip, Empty, IconButton, Sheet, inputCls } from '../components/ui';
import { EventBanner } from '../features/Conditions';
import { VenueSheet } from '../features/VenueSheet';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDay, fmtDistance, fmtTime, priceLabel } from '../lib/format';
import { useGeolocation } from '../lib/geo';

type When = 'tonight' | 'week' | 'all';
const WHEN_LABEL: Record<When, string> = { tonight: 'Tonight', week: 'This week', all: 'Any time' };
const WALK_RADIUS_M = 800; // ≈ 10-minute walk

export function Explore() {
  const nav = useNavigate();
  const [hoodId, setHoodId] = useState('soulard');
  const [when, setWhen] = useState<When>('tonight');
  const [walking, setWalking] = useState(false);
  const [specialsOnly, setSpecialsOnly] = useState(false);
  const [publicOnly, setPublicOnly] = useState(true);
  const [venueId, setVenueId] = useState<string | null>(null);
  const [picker, setPicker] = useState<'hood' | 'when' | 'search' | 'bars' | null>(null);
  const [q, setQ] = useState('');
  const geo = useGeolocation(false);
  const { me } = useAuth();

  const hoods = useQuery({ queryKey: ['neighborhoods'], queryFn: api.neighborhoods, staleTime: Infinity });
  const hood = hoods.data?.find((h) => h.id === hoodId);
  const center = hood?.center ?? { lat: 38.6083, lng: -90.2052 };
  const origin = geo.position && haversineM(geo.position, center) < 5000 ? geo.position : center;

  const events = useQuery({ queryKey: ['events', hoodId], queryFn: () => api.events(hoodId, 7) });
  const templates = useQuery({ queryKey: ['templates', hoodId], queryFn: () => api.templates(hoodId) });
  const friends = useQuery({ queryKey: ['friends-crawls'], queryFn: api.friendsCrawls, enabled: !!me });
  const crawls = useQuery({ queryKey: ['crawls', hoodId, when], queryFn: () => api.crawls({ neighborhood: hoodId, when }) });
  const venues = useQuery({ queryKey: ['venues', hoodId], queryFn: () => api.venues({ neighborhood: hoodId, limit: 200 }) });
  const searchResults = useQuery({ queryKey: ['venue-search', hoodId, q], queryFn: () => api.venues({ neighborhood: hoodId, q, limit: 30 }), enabled: picker === 'search' && q.length > 1 });

  const visibleCrawls = (crawls.data ?? []).filter((c) => !publicOnly || c.visibility === 'public');
  const featured = visibleCrawls[0] ?? null;
  const featuredDetail = useQuery({ queryKey: ['crawl', featured?.id], queryFn: () => api.crawl(featured!.id), enabled: !!featured });

  const bars = useMemo(() => {
    let list = (venues.data ?? []).map((v) => ({ ...v, distanceM: haversineM(origin, v) }));
    if (specialsOnly) list = list.filter((v) => v.specials.length > 0);
    if (walking) list = list.filter((v) => v.distanceM <= WALK_RADIUS_M);
    const stopOrder = new Map(featuredDetail.data?.stops.map((s, i) => [s.venue.id, i]) ?? []);
    return list.sort((a, b) => (stopOrder.get(a.id) ?? 99) - (stopOrder.get(b.id) ?? 99) || a.distanceM - b.distanceM);
  }, [venues.data, specialsOnly, walking, origin, featuredDetail.data]);

  const stopPins: MapStop[] = (featuredDetail.data?.stops ?? []).map((s, i) => ({
    id: s.id,
    lat: s.venue.lat,
    lng: s.venue.lng,
    number: i + 1,
    name: s.venue.name,
    category: s.venue.category,
  }));
  const stopNumber = (venueId: string) => {
    const i = featuredDetail.data?.stops.findIndex((s) => s.venue.id === venueId) ?? -1;
    return i >= 0 ? i + 1 : null;
  };

  return (
    <div className="relative">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-ink/95 px-4 pb-3 backdrop-blur" style={{ paddingTop: 'max(14px, env(safe-area-inset-top))' }}>
        <div className="flex items-center gap-3">
          <h1 className="font-display text-[34px] font-bold leading-none text-amber">Crawl</h1>
          <button onClick={() => setPicker('search')} className="flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-surface border border-line px-4 text-left">
            <Search className="size-5 shrink-0 text-dim" />
            <span className="truncate text-[15px]">
              {hood?.name ?? 'Soulard'}, {hood?.cityName ?? 'St. Louis'}
            </span>
          </button>
          <IconButton label="Neighborhood and filters" onClick={() => setPicker('hood')} className="size-12">
            <SlidersHorizontal className="size-5" />
          </IconButton>
        </div>
        <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4">
          <Chip active icon={<CalendarDays className="size-4" />} onClick={() => setPicker('when')}>
            {WHEN_LABEL[when]} <ChevronDown className="size-4" />
          </Chip>
          <Chip active={walking} icon={<Footprints className="size-4" />} onClick={() => setWalking((x) => !x)} aria-label="Only bars within a 10-minute walk">
            10-min walk
          </Chip>
          <Chip active={specialsOnly} icon={<TagIcon className="size-4" />} onClick={() => setSpecialsOnly((x) => !x)}>
            Specials
          </Chip>
          <Chip active={publicOnly} icon={<Users className="size-4" />} onClick={() => setPublicOnly((x) => !x)}>
            Public
          </Chip>
        </div>
        {walking ? (
          <p className="mt-2 text-[13px] text-dim">
            Showing bars within a 10-minute walk of {geo.position && origin === geo.position ? 'you' : `the center of ${hood?.name ?? 'Soulard'}`}.
            {!geo.position ? (
              <button className="ml-1 font-semibold text-amber" onClick={() => geo.request()}>
                Use my location
              </button>
            ) : null}
          </p>
        ) : null}
      </header>

      {/* Map */}
      <MapView
        className="h-[46vh] min-h-[320px]"
        center={center}
        zoom={hood?.zoom ?? 15.4}
        stops={stopPins}
        route={featuredDetail.data?.approvedRoute?.geometry ?? null}
        venues={bars.map((v) => ({ id: v.id, lat: v.lat, lng: v.lng, name: v.name, category: v.category, hasSpecial: v.specials.some((s) => s.liveNow) || v.specials.length > 0 }))}
        me={geo.position}
        fitKey={featuredDetail.data ? `${featuredDetail.data.id}:${hoodId}` : hoodId}
        padding={{ top: 70, bottom: 90, left: 40, right: 40 }}
        onVenueClick={setVenueId}
        onStopClick={(id) => setVenueId(featuredDetail.data?.stops.find((s) => s.id === id)?.venue.id ?? null)}
      >
        <IconButton label="Use my location" className="absolute right-4 top-4 size-12 bg-ink/90 shadow-float" onClick={() => geo.request()}>
          <Navigation className="size-5 fill-current" />
        </IconButton>
        <Button size="lg" className="absolute bottom-10 right-4" onClick={() => nav('/crawls/new')}>
          <Plus className="size-5" strokeWidth={2.5} /> Create crawl
        </Button>
      </MapView>

      {/* Sheet */}
      <div className="relative z-10 -mt-6 rounded-t-[28px] border-t border-line bg-ink px-4 pt-3">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-line-strong" />
        {events.data?.length ? (
          <div className="mb-4">
            <EventBanner events={events.data} tz={hood?.timezone ?? 'America/Chicago'} />
          </div>
        ) : null}
        {featured ? (
          <FeaturedCrawl crawl={featured} onOpen={() => nav(`/crawls/${featured.id}`)} />
        ) : crawls.isLoading ? (
          <div className="h-44 animate-pulse rounded-3xl bg-surface" />
        ) : (
          <div className="rounded-3xl border border-line bg-surface">
            <Empty
              icon={<Users className="size-6" />}
              title={`No ${publicOnly ? 'public ' : ''}crawls ${when === 'tonight' ? 'tonight' : when === 'week' ? 'this week' : 'yet'}`}
              body="Start one and invite your crew. Public crawls show up here for everyone nearby."
              action={<Button onClick={() => nav('/crawls/new')}>Create a crawl</Button>}
            />
          </div>
        )}

        {friends.data?.length ? (
          <section className="mt-7" aria-label="Friends are going">
            <h2 className="mb-3 font-display text-[22px] font-semibold">Friends are going</h2>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
              {friends.data.map(({ crawl: c, friends: fs }) => (
                <button key={c.id} onClick={() => nav(`/crawls/${c.id}`)} className="w-[270px] shrink-0 rounded-3xl border border-line bg-surface p-4 text-left hover:border-line-strong">
                  <div className="flex items-center gap-2">
                    <AvatarStack users={fs.slice(0, 3)} size={28} />
                    <p className="min-w-0 truncate text-[13px] text-dim">
                      {fs[0].displayName.split(' ')[0]}
                      {fs.length > 1 ? ` +${fs.length - 1}` : ''} going
                    </p>
                  </div>
                  <p className="mt-2 font-display text-[19px] font-semibold leading-tight">{c.title}</p>
                  <p className="mt-1 text-[13px] font-semibold uppercase tracking-wider text-dim">
                    {fmtDay(c.startAt, c.timezone)} · {fmtTime(c.startAt, c.timezone)}
                  </p>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {visibleCrawls.length > 1 ? (
          <section className="mt-7">
            <h2 className="mb-3 font-display text-[22px] font-semibold">More crawls</h2>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
              {visibleCrawls.slice(1).map((c) => (
                <button key={c.id} onClick={() => nav(`/crawls/${c.id}`)} className="w-[260px] shrink-0 rounded-3xl border border-line bg-surface p-4 text-left hover:border-line-strong">
                  <p className="text-[12px] font-semibold uppercase tracking-wider text-dim">{fmtDay(c.startAt, c.timezone)} · {fmtTime(c.startAt, c.timezone)}</p>
                  <p className="mt-1 font-display text-[19px] font-semibold leading-tight">{c.title}</p>
                  <p className="mt-2 text-[14px] text-dim">
                    {c.stopCount} stops · {c.goingCount} going
                  </p>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {templates.data?.length ? (
          <section className="mt-7" aria-label="Ready-made crawls">
            <h2 className="mb-3 font-display text-[22px] font-semibold">Ready-made crawls</h2>
            <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-1">
              {templates.data.map((t) => (
                <button key={t.id} onClick={() => nav(`/templates/${t.id}`)} className="w-[230px] shrink-0 overflow-hidden rounded-3xl border border-line bg-surface text-left hover:border-line-strong">
                  <VenueImage name={t.stops[0]?.venue.name ?? t.title} category={t.stops[0]?.venue.category ?? 'pub'} imageUrl={t.stops[0]?.venue.imageUrl} size="thumb" compact className="h-28 w-full" />
                  <div className="p-3.5">
                    <p className="font-display text-[18px] font-semibold leading-tight">{t.title}</p>
                    <p className="mt-1 truncate text-[13px] text-dim">
                      {t.stops.length} bars · {t.tags.join(' · ') || (t.curated ? 'Curated' : 'Community')}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section className="mt-7">
          <div className="mb-3 flex items-end justify-between">
            <h2 className="font-display text-[22px] font-semibold">Nearby Bars</h2>
            <button className="text-[15px] font-semibold text-amber" onClick={() => setPicker('bars')}>
              See all
            </button>
          </div>
          <div className="no-scrollbar -mx-4 flex gap-3 overflow-x-auto px-4 pb-4">
            {bars.slice(0, 12).map((v) => (
              <BarCard key={v.id} venue={v} number={stopNumber(v.id)} onClick={() => setVenueId(v.id)} />
            ))}
            {!venues.isLoading && bars.length === 0 ? <p className="py-6 text-[15px] text-dim">No bars match these filters.</p> : null}
          </div>
        </section>
        <p className="pb-4 text-center text-[12px] text-faint">Venue data © OpenStreetMap contributors. Please drink responsibly.</p>
      </div>

      <VenueSheet venueId={venueId} onClose={() => setVenueId(null)} />

      <Sheet open={picker === 'when'} onClose={() => setPicker(null)} title="When">
        <div className="space-y-2 pb-2">
          {(Object.keys(WHEN_LABEL) as When[]).map((w) => (
            <button key={w} onClick={() => (setWhen(w), setPicker(null))} className={`flex h-14 w-full items-center justify-between rounded-2xl px-4 text-[16px] font-medium ${when === w ? 'bg-fg text-ink' : 'bg-raised'}`}>
              {WHEN_LABEL[w]}
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={picker === 'hood'} onClose={() => setPicker(null)} title="Neighborhood">
        <div className="space-y-2 pb-2">
          {hoods.data?.map((h) => (
            <button
              key={h.id}
              onClick={() => (setHoodId(h.id), setPicker(null))}
              className={`flex h-16 w-full items-center justify-between rounded-2xl px-4 text-left ${hoodId === h.id ? 'bg-fg text-ink' : 'bg-raised'}`}
            >
              <span>
                <span className="block text-[16px] font-semibold">{h.name}</span>
                <span className={`text-[13px] ${hoodId === h.id ? 'text-[#4a4741]' : 'text-dim'}`}>{h.cityName}</span>
              </span>
              <span className={`text-[13px] ${hoodId === h.id ? 'text-[#4a4741]' : 'text-dim'}`}>{h.venueCount ? `${h.venueCount} bars` : 'Coming soon'}</span>
            </button>
          ))}
        </div>
      </Sheet>

      <Sheet open={picker === 'search'} onClose={() => setPicker(null)} title="Find a bar">
        <input autoFocus className={inputCls} placeholder={`Search ${hood?.name ?? 'Soulard'} bars, streets, vibes…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="mt-3 space-y-1 pb-3">
          {(q.length > 1 ? (searchResults.data ?? []) : bars.slice(0, 8)).map((v) => (
            <VenueRow key={v.id} venue={v} distanceM={haversineM(origin, v)} onClick={() => (setVenueId(v.id), setPicker(null))} />
          ))}
          {q.length > 1 && searchResults.data?.length === 0 ? <p className="py-6 text-center text-dim">No bars found.</p> : null}
        </div>
      </Sheet>

      <Sheet open={picker === 'bars'} onClose={() => setPicker(null)} title={`Bars in ${hood?.name ?? 'Soulard'}`}>
        <div className="space-y-1 pb-3">
          {bars.map((v) => (
            <VenueRow key={v.id} venue={v} distanceM={v.distanceM} onClick={() => (setVenueId(v.id), setPicker(null))} />
          ))}
        </div>
      </Sheet>
    </div>
  );
}

function FeaturedCrawl({ crawl, onOpen }: { crawl: CrawlSummaryDTO; onOpen: () => void }) {
  const day = fmtDay(crawl.startAt, crawl.timezone);
  const live = crawl.status === 'live';
  return (
    <button onClick={onOpen} className="flex w-full gap-4 rounded-3xl border border-line bg-surface p-3 text-left transition hover:border-line-strong">
      <VenueImage name={crawl.cover?.venueName ?? crawl.title} category={crawl.cover?.category ?? 'pub'} imageUrl={crawl.cover?.imageUrl} className="h-auto min-h-[176px] w-[38%] shrink-0 rounded-2xl" />
      <div className="min-w-0 flex-1 py-1 pr-1">
        <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.12em] text-dim">
            <Users className="size-3.5" /> {crawl.visibility === 'public' ? 'Public crawl' : 'Private crawl'}
          </span>
          <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-fg">
            <span className={`size-2 rounded-full ${live ? 'bg-alert' : 'bg-live'}`} />
            {live ? 'Live now' : `Happening ${day.toLowerCase()}`}
          </span>
        </div>
        <p className="mt-1.5 font-display text-[26px] font-bold leading-[1.08] tracking-tight">{crawl.title}</p>
        <p className="mt-1.5 text-[16px] text-fg/90 tabular">
          {crawl.stopCount} stops · {fmtTime(crawl.startAt, crawl.timezone)}
        </p>
        <div className="mt-3 flex items-center justify-between">
          <AvatarStack users={crawl.attendeesPreview.slice(0, 3)} extra={crawl.goingCount - Math.min(3, crawl.attendeesPreview.length)} size={38} />
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[15px] font-medium">
            {crawl.goingCount} going <ChevronRight className="size-4 text-dim" />
          </span>
        </div>
        {crawl.highlights.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {crawl.highlights.slice(0, 2).map((h, i) => (
              <span key={h} className={`inline-flex h-8 items-center rounded-full px-3 text-[13px] font-semibold ${i === 0 && h === 'Happy hour' ? 'bg-amber text-amber-ink' : 'border border-line-strong text-fg'}`}>
                {h}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </button>
  );
}

function BarCard({ venue, number, onClick }: { venue: VenueDTO & { distanceM: number }; number: number | null; onClick: () => void }) {
  const special = venue.specials.find((s) => s.liveNow) ?? venue.specials[0];
  return (
    <button onClick={onClick} className="flex w-[330px] shrink-0 gap-3 rounded-3xl border border-line bg-surface p-2.5 text-left hover:border-line-strong">
      <VenueImage name={venue.name} category={venue.category} imageUrl={venue.imageUrl} size="thumb" compact className="size-[104px] shrink-0 rounded-2xl" />
      <div className="min-w-0 flex-1 py-1">
        <div className="flex items-center gap-2">
          {number ? <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border-2 border-amber text-[12px] font-bold">{number}</span> : null}
          <p className="truncate text-[16px] font-semibold">{venue.name}</p>
        </div>
        <p className="mt-1 truncate text-[14px] text-dim tabular">
          {fmtDistance(venue.distanceM)} · {priceLabel(venue.priceLevel) || '$'} · {venue.tags[0] ?? venue.category}
        </p>
        <div className="mt-2.5 flex gap-1.5 overflow-hidden">
          {special ? (
            <span className={`inline-flex h-8 shrink-0 items-center rounded-full px-3 text-[13px] font-semibold ${special.liveNow ? 'bg-amber text-amber-ink' : 'bg-raised text-amber border border-line'}`}>{special.title}</span>
          ) : null}
          {venue.tags[1] ? <span className="inline-flex h-8 shrink-0 items-center rounded-full border border-line px-3 text-[13px]">{venue.tags[1]}</span> : null}
        </div>
      </div>
    </button>
  );
}

export function VenueRow({ venue, distanceM, onClick, right }: { venue: VenueDTO; distanceM?: number; onClick?: () => void; right?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl px-2 py-2.5 hover:bg-raised">
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-raised border border-line text-amber">
          <CategoryIcon category={venue.category} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[16px] font-semibold">{venue.name}</span>
          <span className="block truncate text-[13px] text-dim">
            {[distanceM != null ? fmtDistance(distanceM) : null, venue.address, venue.specials.length ? `${venue.specials.length} special${venue.specials.length > 1 ? 's' : ''}` : null].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      {right}
    </div>
  );
}
