import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Globe, Images, Lock, MapPin, Pencil, Play, Copy, Share2, Sparkles, Trash2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { CrawlDetailDTO } from '@crawl/core';
import { MapView } from '../components/MapView';
import { Avatar, AvatarStack, Button, Empty, PageSpinner, Segmented, Sheet, TopBar, errorMessage, useToast } from '../components/ui';
import { Chat } from '../features/Chat';
import { EventBanner, WeatherCard } from '../features/Conditions';
import { SaveTemplateSheet } from '../features/SaveTemplate';
import { InvitePanel } from '../features/InvitePanel';
import { Itinerary } from '../features/Itinerary';
import { LiveCrawlView, type CrawlTab } from '../features/LiveCrawlView';
import { People, RsvpToggle } from '../features/People';
import { PhotoGallery } from '../features/PhotoGallery';
import { PushPrompt } from '../features/PushPrompt';
import { RouteReview } from '../features/RoutePanel';
import { HomeSafeCard, SafetyButton } from '../features/Safety';
import { useOfflineCrawl } from '../lib/offline';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDuration, fmtWhen } from '../lib/format';
import { useCrawlChannel } from '../lib/socket';

export function CrawlPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as CrawlTab) ?? 'plan';
  const setTab = (t: CrawlTab) => setParams((p) => (p.set('tab', t), p), { replace: true });
  const crawl = useQuery({ queryKey: ['crawl', id], queryFn: () => api.crawl(id!), refetchInterval: (q) => (q.state.data?.status === 'live' ? 60_000 : false) });
  useCrawlChannel(id, !!crawl.data?.permissions.isMember);

  if (crawl.isLoading) return <PageSpinner />;
  if (!crawl.data)
    return (
      <div>
        <TopBar title="" />
        <Empty icon={<Lock className="size-6" />} title="Crawl not found" body={crawl.error instanceof ApiError && crawl.error.status === 404 ? 'It may be private or deleted. Ask the organizer for an invite link.' : errorMessage(crawl.error)} />
      </div>
    );
  const c = crawl.data;
  if (c.status === 'live' && c.permissions.isMember) return <LiveCrawlView crawl={c} tab={tab} onTab={setTab} />;
  return <CrawlOverview crawl={c} tab={tab} onTab={setTab} />;
}

function CrawlOverview({ crawl, tab, onTab }: { crawl: CrawlDetailDTO; tab: CrawlTab; onTab: (t: CrawlTab) => void }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const [inviting, setInviting] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const set = (c: CrawlDetailDTO) => qc.setQueryData(['crawl', crawl.id], c);
  const onErr = (e: unknown) => toast({ title: errorMessage(e) });
  const join = useMutation({ mutationFn: () => api.join(crawl.id), onSuccess: (c) => (set(c), qc.invalidateQueries({ queryKey: ['my-invites'] }), toast({ title: 'You’re in', body: 'See you there.' })), onError: onErr });
  const decline = useMutation({ mutationFn: () => api.declineInvite(crawl.id), onSuccess: () => (qc.invalidateQueries({ queryKey: ['my-invites'] }), nav('/invites')), onError: onErr });
  const start = useMutation({ mutationFn: () => api.start(crawl.id), onSuccess: set, onError: onErr });
  const leave = useMutation({ mutationFn: () => api.leave(crawl.id), onSuccess: () => (qc.invalidateQueries({ queryKey: ['crawl', crawl.id] }), nav('/my-crawls')), onError: onErr });
  const del = useMutation({ mutationFn: () => api.deleteCrawl(crawl.id), onSuccess: () => nav('/my-crawls', { replace: true }), onError: onErr });

  const p = crawl.permissions;
  const ended = crawl.status === 'ended';
  const totalMin = crawl.approvedRoute ? crawl.approvedRoute.totalS / 60 : crawl.stops.reduce((t, s) => t + s.dwellMin, 0);
  const pins = crawl.stops.map((s, i) => ({ id: s.id, lat: s.venue.lat, lng: s.venue.lng, number: i + 1, name: s.venue.name, category: s.venue.category, state: ended ? ('visited' as const) : undefined }));
  const memberTabs = p.isMember;
  useOfflineCrawl(crawl);

  return (
    <div className="min-h-full pb-10">
      <MapView className="h-[34vh] min-h-[240px]" center={crawl.stops[0]?.venue ?? { lat: 38.6083, lng: -90.2052 }} zoom={15.2} stops={pins} route={crawl.approvedRoute?.geometry} fitKey={crawl.id} padding={{ top: 80, bottom: 50, left: 50, right: 50 }}>
        <div className="absolute inset-x-0 top-0">
          <TopBar transparent back="/" right={<div className="flex gap-2">{p.isMember ? <SafetyButton crawl={crawl} /> : null}{p.canEdit && !ended ? <Link to={`/crawls/${crawl.id}/plan`} className="inline-flex h-11 items-center gap-1.5 rounded-full bg-ink/90 px-4 text-[14px] font-semibold shadow-float"><Pencil className="size-4" /> Edit plan</Link> : null}</div>} />
        </div>
      </MapView>

      <div className="relative z-10 -mt-6 rounded-t-[28px] border-t border-line bg-ink px-4 pt-5">
        <p className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[0.14em] text-dim">
          {crawl.visibility === 'public' ? <Globe className="size-3.5" /> : <Lock className="size-3.5" />}
          {crawl.visibility === 'public' ? 'Public crawl' : 'Private crawl'}
          {crawl.status === 'draft' ? ' · Draft' : ended ? ' · Ended' : ''}
        </p>
        <h1 className="mt-1.5 font-display text-[32px] font-bold leading-[1.05] tracking-tight">{crawl.title}</h1>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[15px] text-fg/90">
          <span className="inline-flex items-center gap-1.5">
            <CalendarDays className="size-4 text-dim" /> {fmtWhen(crawl.startAt, crawl.timezone)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="size-4 text-dim" /> {crawl.stopCount} stops{totalMin ? ` · ~${fmtDuration(totalMin * 60)}` : ''}
          </span>
          {ended && crawl.photoCount ? (
            <span className="inline-flex items-center gap-1.5">
              <Images className="size-4 text-dim" /> {crawl.photoCount} photos
            </span>
          ) : null}
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Avatar user={crawl.organizer} size={36} />
          <p className="text-[14px] text-dim">
            Organized by <span className="font-semibold text-fg">{crawl.organizer.displayName}</span>
          </p>
        </div>
        {crawl.description ? <p className="mt-4 text-[15px] leading-relaxed text-fg/90">{crawl.description}</p> : null}

        <div className="mt-4 flex items-center justify-between">
          <AvatarStack users={crawl.attendeesPreview.slice(0, 5)} extra={crawl.goingCount - Math.min(5, crawl.attendeesPreview.length)} size={36} />
          <p className="text-[14px] text-dim">
            {crawl.goingCount} going{crawl.maybeCount ? ` · ${crawl.maybeCount} maybe` : ''}
          </p>
        </div>

        {/* Primary actions */}
        <div className="mt-5 space-y-3">
          {!ended ? <EventBanner events={crawl.events} tz={crawl.timezone} /> : null}
          {!ended ? <WeatherCard weather={crawl.weather} tz={crawl.timezone} /> : null}
          {ended && p.isMember ? <HomeSafeCard crawl={crawl} /> : null}
          {ended && p.isMember ? (
            <Link to={`/crawls/${crawl.id}/recap`} className="flex items-center gap-3 rounded-3xl bg-amber p-4 text-amber-ink">
              <Sparkles className="size-6 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-[17px] font-semibold">Your recap is ready</span>
                <span className="block text-[14px] text-[#5a4210]">The route, the bars, the best photos, and a card to share.</span>
              </span>
            </Link>
          ) : null}
          {p.isMember && !ended ? <PushPrompt /> : null}
          {!p.isMember && !ended ? (
            me ? (
              <div className="flex gap-2">
                <Button size="lg" className="flex-1" loading={join.isPending} onClick={() => join.mutate()}>
                  Join crawl
                </Button>
                {crawl.visibility === 'private' ? (
                  <Button size="lg" variant="secondary" loading={decline.isPending} onClick={() => decline.mutate()}>
                    Decline
                  </Button>
                ) : null}
              </div>
            ) : (
              <Button size="lg" className="w-full" onClick={() => nav(`/signin?next=/crawls/${crawl.id}`)}>
                Sign in to join
              </Button>
            )
          ) : null}
          {p.isMember && !ended ? <RsvpToggle crawl={crawl} /> : null}
          {p.canRunLive && !ended ? (
            <div className="flex gap-2">
              <Button size="lg" className="flex-1" loading={start.isPending} disabled={crawl.stops.length === 0} onClick={() => start.mutate()}>
                <Play className="size-5 fill-current" /> Start crawl
              </Button>
              <Button size="lg" variant="secondary" onClick={() => setInviting(true)}>
                <UserPlus className="size-5" /> Invite
              </Button>
            </div>
          ) : null}
          {p.canRunLive && !crawl.approvedRoute && crawl.stops.length >= 2 && !ended ? (
            <p className="text-[14px] text-dim">
              No approved route yet. <Link to={`/crawls/${crawl.id}/plan`} className="font-semibold text-amber">Optimize the route</Link> so everyone gets arrival times and specials alerts.
            </p>
          ) : null}
          {ended && p.isMember ? (
            <Link to="/profile" className="flex items-center justify-between rounded-2xl bg-surface border border-line px-4 py-3.5">
              <span className="text-[15px] font-semibold">Your visited bars are in your profile</span>
              <span className="text-[14px] font-semibold text-amber">View</span>
            </Link>
          ) : null}
        </div>

        {memberTabs ? (
          <div className="sticky top-0 z-20 -mx-4 mt-6 bg-ink px-4 py-3">
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
        ) : (
          <h2 className="mb-3 mt-8 font-display text-[22px] font-semibold">Stops</h2>
        )}

        <div className={memberTabs ? 'pt-2' : ''}>
          {tab === 'plan' || !memberTabs ? (
            <>
              <Itinerary crawl={crawl} />
              {crawl.approvedRoute?.explanation && p.isMember ? (
                <details className="mt-6 rounded-3xl border border-line bg-surface p-4">
                  <summary className="cursor-pointer text-[15px] font-semibold">Why this order?</summary>
                  <div className="mt-3">
                    <RouteReview crawl={crawl} route={crawl.approvedRoute} />
                  </div>
                </details>
              ) : null}
            </>
          ) : tab === 'chat' ? (
            <Chat crawl={crawl} />
          ) : tab === 'photos' ? (
            <PhotoGallery crawl={crawl} />
          ) : (
            <People crawl={crawl} />
          )}
        </div>

        {p.canDelete && crawl.stops.length >= 2 ? (
          <div className="mt-10 flex justify-center border-t border-line pt-6">
            <button className="inline-flex items-center gap-1.5 text-[14px] text-dim hover:text-fg" onClick={() => setSavingTemplate(true)}>
              <Copy className="size-4" /> Save as template
            </button>
          </div>
        ) : null}
        {p.isMember && !ended ? (
          <div className={`flex justify-center gap-6 ${p.canDelete && crawl.stops.length >= 2 ? 'mt-4' : 'mt-10 border-t border-line pt-6'}`}>
            {p.canDelete ? (
              <button className="inline-flex items-center gap-1.5 text-[14px] text-dim hover:text-fg" onClick={() => confirm('Delete this crawl for everyone?') && del.mutate()}>
                <Trash2 className="size-4" /> Delete crawl
              </button>
            ) : (
              <button className="text-[14px] text-dim hover:text-fg" onClick={() => leave.mutate()}>
                Leave crawl
              </button>
            )}
            {p.canInvite ? (
              <button className="inline-flex items-center gap-1.5 text-[14px] text-dim hover:text-fg" onClick={() => setInviting(true)}>
                <Share2 className="size-4" /> Share
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <SaveTemplateSheet crawl={crawl} open={savingTemplate} onClose={() => setSavingTemplate(false)} />
      <Sheet open={inviting} onClose={() => setInviting(false)} title="Invite people">
        <div className="pb-2">
          <InvitePanel crawl={crawl} />
        </div>
      </Sheet>
    </div>
  );
}
