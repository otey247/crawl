import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Camera, Clock, Search, Store, Trash2, Users } from 'lucide-react';
import { DateTime } from 'luxon';
import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PhotoCredit, VenueImage } from '../components/domain';
import { Button, Empty, PageSpinner, Sheet, Spinner, TopBar, errorMessage, inputCls, useToast } from '../components/ui';
import { SpecialForm, SpecialRow, VenueSheet } from '../features/VenueSheet';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const STATUS_COPY = { pending: 'In review', approved: 'Approved', rejected: 'Not approved' } as const;

/** Profile → "Manage a bar": venues you manage, claims in progress, and finding your bar to claim. */
export function MyVenues() {
  const venues = useQuery({ queryKey: ['my-venues'], queryFn: api.myVenues });
  const claims = useQuery({ queryKey: ['my-claims'], queryFn: api.myClaims });
  const [q, setQ] = useState('');
  const [venueId, setVenueId] = useState<string | null>(null);
  const search = useQuery({ queryKey: ['venue-search', 'soulard', q], queryFn: () => api.venues({ neighborhood: 'soulard', q, limit: 10 }), enabled: q.length > 1 });
  if (venues.isLoading) return <PageSpinner />;
  return (
    <div className="min-h-full pb-12">
      <TopBar title="Manage a bar" back="/profile" />
      <div className="space-y-6 px-4 pt-4">
        {venues.data?.length ? (
          <section>
            <h2 className="mb-2 text-[13px] font-bold uppercase tracking-[0.14em] text-dim">Your venues</h2>
            <div className="space-y-2">
              {venues.data.map((v) => (
                <Link key={v.id} to={`/venues/${v.id}/manage`} className="flex items-center gap-3 rounded-3xl border border-line bg-surface p-2.5 pr-4 hover:border-line-strong">
                  <VenueImage name={v.name} category={v.category} imageUrl={v.imageUrl} size="thumb" compact className="size-14 shrink-0 rounded-2xl" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[16px] font-semibold">
                      {v.name} <BadgeCheck className="size-4 text-amber" />
                    </span>
                    <span className="block truncate text-[13px] text-dim">{v.address}</span>
                  </span>
                </Link>
              ))}
            </div>
          </section>
        ) : (
          <Empty icon={<Store className="size-6" />} title="Run a bar in Soulard?" body="Claim your listing to post verified specials, use your own photos and see how many crawls are headed your way." />
        )}
        {claims.data?.filter((c) => c.status !== 'approved').length ? (
          <section>
            <h2 className="mb-2 text-[13px] font-bold uppercase tracking-[0.14em] text-dim">Claims</h2>
            {claims.data
              .filter((c) => c.status !== 'approved')
              .map((c) => (
                <div key={c.id} className="flex items-center justify-between rounded-2xl bg-raised px-4 py-3">
                  <span className="text-[15px] font-semibold">{c.venue.name}</span>
                  <span className="text-[13px] text-dim">{STATUS_COPY[c.status]}{c.reviewNote ? ` · ${c.reviewNote}` : ''}</span>
                </div>
              ))}
          </section>
        ) : null}
        <section>
          <h2 className="mb-2 text-[13px] font-bold uppercase tracking-[0.14em] text-dim">Find your bar</h2>
          <div className="relative">
            <Search className="pointer-events-none absolute left-4 top-1/2 size-5 -translate-y-1/2 text-dim" />
            <input className={`${inputCls} pl-12`} placeholder="Search Soulard bars" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="mt-2 space-y-1">
            {search.data?.map((v) => (
              <button key={v.id} onClick={() => setVenueId(v.id)} className="flex w-full items-center justify-between rounded-2xl px-3 py-3 text-left hover:bg-raised">
                <span className="text-[15px] font-semibold">{v.name}</span>
                <span className="text-[13px] text-dim">{v.verified ? 'Already managed' : 'Claim'}</span>
              </button>
            ))}
          </div>
        </section>
      </div>
      <VenueSheet venueId={venueId} onClose={() => setVenueId(null)} />
    </div>
  );
}

/** Owner tools for one venue: demand, verified specials, and the venue's own photo. */
export function ManageVenue() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const { me } = useAuth();
  const venue = useQuery({ queryKey: ['venue', id], queryFn: () => api.venue(id!) });
  const insights = useQuery({ queryKey: ['venue-insights', id], queryFn: () => api.venueInsights(id!), retry: false });
  const [adding, setAdding] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const del = useMutation({ mutationFn: api.deleteSpecial, onSuccess: () => qc.invalidateQueries({ queryKey: ['venue', id] }), onError: (e) => toast({ title: errorMessage(e) }) });
  const photo = useMutation({
    mutationFn: async (f: File) => {
      const type = ['image/jpeg', 'image/png', 'image/webp'].includes(f.type) ? f.type : 'image/jpeg';
      const { key, uploadUrl } = await api.venuePhotoUploadUrl(id!, type);
      const res = await fetch(uploadUrl, { method: 'PUT', headers: { 'content-type': type }, body: f });
      if (!res.ok) throw new Error('Upload failed');
      return api.venuePhotoComplete(id!, key);
    },
    onSuccess: (v) => {
      qc.setQueryData(['venue', id], v);
      qc.invalidateQueries({ queryKey: ['venues'] });
      toast({ title: 'Photo updated', body: 'It now shows everywhere your bar appears.' });
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });

  if (venue.isLoading) return <PageSpinner />;
  const v = venue.data;
  if (!v || (insights.isError && !me?.isAdmin)) return <Empty icon={<Store className="size-6" />} title="You don’t manage this venue" />;
  const ins = insights.data;
  const venueSpecials = v.specials.filter((s) => s.source === 'venue');
  const otherSpecials = v.specials.filter((s) => s.source !== 'venue');

  return (
    <div className="min-h-full pb-12">
      <TopBar title={v.name} back="/venues/manage" />
      <div className="space-y-6 px-4 pt-4">
        <section>
          <div className="relative">
            <VenueImage name={v.name} category={v.category} imageUrl={v.imageUrl} compact className="h-44 w-full rounded-3xl" />
            <Button size="sm" variant="secondary" className="absolute bottom-3 right-3" loading={photo.isPending} onClick={() => file.current?.click()}>
              <Camera className="size-4" /> {v.imageCredit?.license === 'Provided by the venue' ? 'Change photo' : 'Use your own photo'}
            </Button>
            <input ref={file} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && photo.mutate(e.target.files[0])} />
          </div>
          <div className="mt-1 text-right">
            <PhotoCredit credit={v.imageCredit} />
          </div>
        </section>

        <section aria-label="Demand">
          <h2 className="font-display text-[22px] font-semibold">Coming your way</h2>
          {!ins ? (
            <Spinner />
          ) : (
            <>
              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                {[
                  [ins.next14Days.crawls, 'crawls, 14 days'],
                  [ins.next14Days.people, 'people going'],
                  [ins.checkInsLast30Days, 'check-ins, 30 days'],
                ].map(([n, label]) => (
                  <div key={label} className="rounded-2xl border border-line bg-surface py-3">
                    <p className="font-display text-[26px] font-bold tabular">{n}</p>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-dim">{label}</p>
                  </div>
                ))}
              </div>
              <ul className="mt-3 divide-y divide-line">
                {ins.upcoming.map((u) => (
                  <li key={u.crawlId} className="flex items-center gap-3 py-2.5">
                    <Clock className="size-4 shrink-0 text-dim" />
                    <span className="flex-1 text-[15px]">
                      {DateTime.fromISO(u.plannedArrival ?? u.startAt, { zone: u.timezone }).toFormat("ccc, LLL d · h:mm a")}
                      {u.plannedArrival ? '' : ' (crawl start)'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[14px] font-semibold">
                      <Users className="size-4 text-dim" /> {u.going}
                    </span>
                  </li>
                ))}
                {!ins.upcoming.length ? <li className="py-3 text-[14px] text-dim">No crawls planned here yet.</li> : null}
              </ul>
              <p className="mt-1 text-[12px] text-faint">Group sizes and arrival times only. Crawl doesn’t share who’s coming.</p>
            </>
          )}
        </section>

        <section aria-label="Specials">
          <div className="flex items-end justify-between">
            <h2 className="font-display text-[22px] font-semibold">Your specials</h2>
            <Button size="sm" onClick={() => setAdding(true)}>
              Add special
            </Button>
          </div>
          <p className="mt-1 text-[14px] text-dim">Shown as “From the venue” and used for live alerts and route planning.</p>
          <div className="mt-3 space-y-2">
            {venueSpecials.map((s) => (
              <SpecialRow
                key={s.id}
                special={s}
                right={
                  <button aria-label={`Delete ${s.title}`} className="p-2 text-dim hover:text-fg" onClick={() => confirm(`Remove “${s.title}”?`) && del.mutate(s.id)}>
                    <Trash2 className="size-4" />
                  </button>
                }
              />
            ))}
            {!venueSpecials.length ? <p className="text-[14px] text-dim">No verified specials yet.</p> : null}
          </div>
          {otherSpecials.length ? (
            <>
              <h3 className="mt-5 text-[13px] font-bold uppercase tracking-[0.14em] text-dim">Reported by guests</h3>
              <p className="mt-1 text-[13px] text-faint">Remove anything that isn’t right. Crowd reports fade on their own after 30 days without a confirmation.</p>
              <div className="mt-2 space-y-2">
                {otherSpecials.map((s) => (
                  <SpecialRow
                    key={s.id}
                    special={s}
                    right={
                      <button aria-label={`Remove ${s.title}`} className="p-2 text-dim hover:text-fg" onClick={() => confirm(`Remove “${s.title}”?`) && del.mutate(s.id)}>
                        <Trash2 className="size-4" />
                      </button>
                    }
                  />
                ))}
              </div>
            </>
          ) : null}
        </section>
      </div>
      <Sheet open={adding} onClose={() => setAdding(false)} title="New special">
        <div className="pb-2">
          <SpecialForm
            venueId={v.id}
            onDone={() => {
              setAdding(false);
              qc.invalidateQueries({ queryKey: ['venue', id] });
              toast({ title: 'Special posted', body: 'It’s live for every crawl that stops here.' });
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}

/** Admin queue for claims that couldn't be verified by email domain. */
export function AdminClaims() {
  const qc = useQueryClient();
  const toast = useToast();
  const claims = useQuery({ queryKey: ['admin-claims'], queryFn: () => api.adminClaims('pending'), retry: false });
  const done = () => qc.invalidateQueries({ queryKey: ['admin-claims'] });
  const onError = (e: unknown) => toast({ title: errorMessage(e) });
  const approve = useMutation({ mutationFn: (id: string) => api.approveClaim(id), onSuccess: done, onError });
  const reject = useMutation({ mutationFn: (v: { id: string; note: string }) => api.rejectClaim(v.id, v.note), onSuccess: done, onError });
  if (claims.isLoading) return <PageSpinner />;
  if (claims.isError) return <Empty icon={<Store className="size-6" />} title="Admins only" />;
  return (
    <div className="min-h-full pb-12">
      <TopBar title="Venue claims" back="/profile" />
      <div className="space-y-3 px-4 pt-4">
        {!claims.data?.length ? <Empty icon={<BadgeCheck className="size-6" />} title="Nothing to review" /> : null}
        {claims.data?.map((c) => (
          <article key={c.id} className="rounded-3xl border border-line bg-surface p-4">
            <p className="text-[17px] font-semibold">{c.venue.name}</p>
            <p className="text-[14px] text-dim">{c.venue.address}</p>
            <dl className="mt-3 space-y-1 text-[14px]">
              <div>
                <dt className="inline text-dim">Who: </dt>
                <dd className="inline">
                  {c.user.displayName} · {c.role.replace('_', ' ')}
                </dd>
              </div>
              <div>
                <dt className="inline text-dim">Contact: </dt>
                <dd className="inline">
                  {c.contactEmail}
                  {c.contactPhone ? ` · ${c.contactPhone}` : ''}
                </dd>
              </div>
              {c.message ? <dd className="rounded-2xl bg-raised px-3 py-2">{c.message}</dd> : null}
            </dl>
            <p className="mt-3 text-[13px] text-dim">Call the bar’s public number to confirm before approving.</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" loading={approve.isPending && approve.variables === c.id} onClick={() => approve.mutate(c.id)}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  const note = prompt('Reason (sent to the requester)');
                  if (note && note.trim().length > 1) reject.mutate({ id: c.id, note: note.trim() });
                }}
              >
                Reject
              </Button>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
