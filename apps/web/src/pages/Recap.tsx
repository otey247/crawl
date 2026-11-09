import { useQuery } from '@tanstack/react-query';
import { Check, Images, Share2, Tag as TagIcon } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RecapDTO } from '@crawl/core';
import { CrewBadge, VenueImage } from '../components/domain';
import { MapView } from '../components/MapView';
import { Avatar, Button, Empty, PageSpinner, TopBar, errorMessage, useToast } from '../components/ui';
import { ApiError, api, tokenStore } from '../lib/api';
import { fmtDuration, fmtTime } from '../lib/format';

/** Post-crawl recap: the route, the numbers, each stop, the best photos and the crew. */
export function Recap() {
  const { id } = useParams<{ id: string }>();
  const recap = useQuery({ queryKey: ['recap', id], queryFn: () => api.recap(id!), retry: false });
  if (recap.isLoading) return <PageSpinner />;
  if (!recap.data) {
    const notEnded = recap.error instanceof ApiError && recap.error.code === 'not_ended';
    return (
      <div>
        <TopBar title="Recap" back={`/crawls/${id}`} />
        <Empty
          icon={<Images className="size-6" />}
          title={notEnded ? 'Still going' : 'Recap unavailable'}
          body={notEnded ? 'The recap is ready as soon as the crawl ends.' : errorMessage(recap.error)}
          action={
            <Link to={`/crawls/${id}`} className="font-semibold text-amber">
              Back to the crawl
            </Link>
          }
        />
      </div>
    );
  }
  return <RecapView r={recap.data} />;
}

function RecapView({ r }: { r: RecapDTO }) {
  const tz = r.crawl.timezone;
  const miles = (r.totals.distanceM / 1609.34).toFixed(1);
  const stats: [string, string][] = [
    [String(r.totals.stopsVisited), r.totals.stopsVisited === 1 ? 'bar' : 'bars'],
    [miles, 'miles walked'],
    [fmtDuration(r.totals.durationS), 'out together'],
    [String(r.totals.specialsCaught), r.totals.specialsCaught === 1 ? 'special caught' : 'specials caught'],
  ];
  return (
    <div className="min-h-full pb-12">
      <TopBar title="Recap" back={`/crawls/${r.crawl.id}`} />
      <div className="px-4 pt-5">
        <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-amber">Crawl recap{r.crawl.neighborhood ? ` · ${r.crawl.neighborhood}` : ''}</p>
        <h1 className="mt-1 font-display text-[34px] font-bold leading-[1.05] tracking-tight">{r.crawl.title}</h1>
        <p className="mt-1 text-[15px] text-dim">{DateTime.fromISO(r.crawl.startAt, { zone: tz }).toFormat('cccc, LLLL d')}</p>
      </div>

      <MapView
        className="mx-4 mt-5 h-[260px] rounded-3xl border border-line"
        center={r.stops[0] ?? { lat: 38.6083, lng: -90.2052 }}
        zoom={15}
        stops={r.stops.map((s, i) => ({ id: s.stopId, lat: s.lat, lng: s.lng, number: i + 1, name: s.name, category: s.category }))}
        route={r.route}
        fitKey={r.crawl.id}
        padding={{ top: 50, bottom: 30, left: 40, right: 40 }}
      />

      <div className="mt-5 grid grid-cols-2 gap-2 px-4">
        {stats.map(([n, label]) => (
          <div key={label} className="rounded-3xl border border-line bg-surface p-4">
            <p className="font-display text-[34px] font-bold leading-none tabular">{n}</p>
            <p className="mt-1.5 text-[13px] font-semibold uppercase tracking-wider text-dim">{label}</p>
          </div>
        ))}
      </div>
      <p className="mt-3 px-4 text-[14px] text-dim">
        {r.totals.checkIns} check-in{r.totals.checkIns === 1 ? '' : 's'} · {r.totals.photos} photo{r.totals.photos === 1 ? '' : 's'} · {r.totals.homeSafe} of {r.totals.going} confirmed home safe
      </p>

      <ShareRecap crawlId={r.crawl.id} title={r.crawl.title} />

      <section className="mt-8 px-4">
        <h2 className="font-display text-[22px] font-semibold">The night, stop by stop</h2>
        <ol className="mt-3 space-y-3">
          {r.stops.map((s, i) => (
            <li key={s.stopId} className="flex gap-3 rounded-3xl border border-line bg-surface p-2.5 pr-4">
              <VenueImage name={s.name} category={s.category} imageUrl={s.imageUrl} size="thumb" compact className="size-[72px] shrink-0 rounded-2xl" />
              <div className="min-w-0 flex-1 py-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="truncate text-[16px] font-semibold">
                    {i + 1}. {s.name}
                  </p>
                  <p className="shrink-0 text-[13px] text-dim tabular">
                    {fmtTime(s.arrivedAt, tz)}
                    {s.departedAt ? `–${fmtTime(s.departedAt, tz)}` : ''}
                  </p>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {s.specialsCaught.map((t) => (
                    <span key={t} className="inline-flex h-7 items-center gap-1 rounded-full bg-amber px-2.5 text-[12px] font-semibold text-amber-ink">
                      <TagIcon className="size-3.5" /> {t}
                    </span>
                  ))}
                  {s.iCheckedIn ? (
                    <span className="inline-flex h-7 items-center gap-1 text-[12px] font-semibold">
                      <Check className="size-3.5 text-live" strokeWidth={3} /> You checked in
                    </span>
                  ) : null}
                  <span className="text-[12px] text-dim">{s.checkIns} check-in{s.checkIns === 1 ? '' : 's'}</span>
                </div>
              </div>
            </li>
          ))}
        </ol>
        {r.skipped.length ? <p className="mt-3 text-[13px] text-dim">Skipped: {r.skipped.join(', ')}</p> : null}
      </section>

      {r.photos.length ? (
        <section className="mt-8 px-4">
          <div className="flex items-end justify-between">
            <h2 className="font-display text-[22px] font-semibold">Best of the album</h2>
            <Link to={`/crawls/${r.crawl.id}?tab=photos`} className="text-[14px] font-semibold text-amber">
              All {r.totals.photos}
            </Link>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-1.5">
            {r.photos.map((p) => (
              <Link key={p.id} to={`/crawls/${r.crawl.id}?tab=photos`} className="relative aspect-square overflow-hidden rounded-xl bg-raised">
                <img src={p.thumbUrl} alt={`Photo by ${p.uploader.displayName}`} loading="lazy" className="size-full object-cover" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {r.crew.length ? (
        <section className="mt-8 px-4">
          <h2 className="font-display text-[22px] font-semibold">The crew</h2>
          <ul className="mt-3 space-y-2">
            {r.crew.map((c) => (
              <li key={`${c.role}:${c.user.id}`} className="flex items-center gap-3">
                <Avatar user={c.user} size={36} />
                <span className="flex-1 text-[15px] font-semibold">{c.user.displayName}</span>
                <CrewBadge role={c.role} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** Previews the shareable card and hands it to the share sheet (or downloads it). */
function ShareRecap({ crawlId, title }: { crawlId: string; title: string }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    fetch(api.recapCardUrl(crawlId), { headers: { authorization: `Bearer ${tokenStore.get()}` } })
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error('Card unavailable'))))
      .then((blob) => {
        const name = `${title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'crawl'}-recap.png`;
        setFile(new File([blob], name, { type: 'image/png' }));
        url = URL.createObjectURL(blob);
        setPreview(url);
      })
      .catch(() => {});
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [crawlId, title]);

  async function share() {
    if (!file) return;
    try {
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: `${title} recap` });
        return;
      }
    } catch {
      return; // cancelled
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast({ title: 'Recap card saved' });
  }

  return (
    <section className="mt-6 px-4">
      {preview ? <img src={preview} alt="Shareable recap card" className="w-full rounded-3xl border border-line" /> : <div className="aspect-[4/5] w-full animate-pulse rounded-3xl bg-surface" />}
      <Button size="lg" className="mt-3 w-full" disabled={!file} onClick={share}>
        <Share2 className="size-5" /> Share recap
      </Button>
      <p className="mt-2 text-center text-[12px] text-faint">The card shows the route, the bars and the numbers. No one’s photos or names.</p>
    </section>
  );
}
