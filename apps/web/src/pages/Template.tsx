import { useMutation, useQuery } from '@tanstack/react-query';
import { Clock, Copy, Globe, Lock, MapPin } from 'lucide-react';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CategoryIcon, VenueImage } from '../components/domain';
import { MapView } from '../components/MapView';
import { Button, Empty, Field, PageSpinner, Segmented, TopBar, errorMessage, inputCls } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDuration } from '../lib/format';

/** A ready-made crawl: preview the bars, then use it to start your own. */
export function Template() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const { me } = useAuth();
  const t = useQuery({ queryKey: ['template', id], queryFn: () => api.template(id!) });
  const tz = 'America/Chicago';
  const now = DateTime.now().setZone(tz);
  const [form, setForm] = useState({ date: (now.hour >= 20 ? now.plus({ days: 1 }) : now).toISODate()!, startTime: '19:00', visibility: 'private' as 'public' | 'private' });
  const fork = useMutation({
    mutationFn: () => api.forkTemplate(t.data!.id, form),
    onSuccess: (c) => nav(`/crawls/${c.id}/plan`),
  });

  if (t.isLoading) return <PageSpinner />;
  if (!t.data) return <Empty icon={<Copy className="size-6" />} title="Template not found" />;
  const tpl = t.data;
  const first = tpl.stops[0]?.venue;

  return (
    <div className="min-h-full pb-12">
      <div className="relative">
        {first ? <VenueImage name={first.name} category={first.category} imageUrl={first.imageUrl} compact className="h-56 w-full" /> : null}
        <div className="absolute inset-0 bg-gradient-to-t from-ink via-ink/30 to-transparent" />
        <div className="absolute inset-x-0 top-0">
          <TopBar transparent back="/" />
        </div>
      </div>
      <div className="-mt-10 relative px-4">
        <p className="text-[12px] font-bold uppercase tracking-[0.16em] text-amber">
          {tpl.curated ? 'Ready-made crawl' : `Template by ${tpl.createdBy?.displayName ?? 'a Crawl organizer'}`}
        </p>
        <h1 className="mt-1 font-display text-[34px] font-bold leading-[1.05] tracking-tight">{tpl.title}</h1>
        {tpl.description ? <p className="mt-2 text-[15px] leading-relaxed text-fg/90">{tpl.description}</p> : null}
        <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[14px] text-dim">
          <span className="inline-flex items-center gap-1.5">
            <MapPin className="size-4" /> {tpl.stops.length} bars
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Clock className="size-4" /> about {fmtDuration(tpl.totalMin * 60)}
          </span>
          {tpl.uses ? <span>Used {tpl.uses} time{tpl.uses === 1 ? '' : 's'}</span> : null}
        </p>
        {tpl.tags.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {tpl.tags.map((tag) => (
              <span key={tag} className="inline-flex h-8 items-center rounded-full border border-line-strong px-3 text-[13px] font-semibold">
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <MapView
        className="mx-4 mt-5 h-[220px] rounded-3xl border border-line"
        center={first ?? { lat: 38.6083, lng: -90.2052 }}
        zoom={15}
        stops={tpl.stops.map((s, i) => ({ id: s.venue.id, lat: s.venue.lat, lng: s.venue.lng, number: i + 1, name: s.venue.name, category: s.venue.category }))}
        fitKey={tpl.id}
        padding={{ top: 60, bottom: 30, left: 40, right: 40 }}
      />

      <ol className="mt-5 space-y-2 px-4">
        {tpl.stops.map((s, i) => (
          <li key={s.venue.id} className="flex items-center gap-3 rounded-3xl border border-line bg-surface p-2.5 pr-4">
            <VenueImage name={s.venue.name} category={s.venue.category} imageUrl={s.venue.imageUrl} size="thumb" compact className="size-16 shrink-0 rounded-2xl" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[16px] font-semibold">
                {i + 1}. {s.venue.name}
              </p>
              <p className="flex items-center gap-1.5 truncate text-[13px] text-dim">
                <CategoryIcon category={s.venue.category} className="size-3.5" /> {s.dwellMin} min{s.venue.tags[0] ? ` · ${s.venue.tags[0]}` : ''}
                {s.venue.specials[0] ? ` · ${s.venue.specials[0].title}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ol>

      <section className="mx-4 mt-6 rounded-3xl border border-line-strong bg-surface p-4">
        <p className="font-display text-[20px] font-semibold">Use this crawl</p>
        <p className="mt-1 text-[14px] text-dim">You’ll get your own copy to tweak, optimize and invite people to.</p>
        {me ? (
          <form
            className="mt-4 space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              fork.mutate();
            }}
          >
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date">
                <input type="date" className={inputCls} required min={now.toISODate()!} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
              </Field>
              <Field label="Start">
                <input type="time" className={inputCls} required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
              </Field>
            </div>
            <Segmented
              value={form.visibility}
              onChange={(visibility) => setForm({ ...form, visibility })}
              options={[
                { value: 'private', label: 'Invite only', icon: <Lock className="size-4" /> },
                { value: 'public', label: 'Public', icon: <Globe className="size-4" /> },
              ]}
            />
            {fork.error ? <p className="text-[14px] text-alert">{errorMessage(fork.error)}</p> : null}
            <Button type="submit" size="lg" className="w-full" loading={fork.isPending}>
              <Copy className="size-5" /> Start my crawl
            </Button>
          </form>
        ) : (
          <Button size="lg" className="mt-4 w-full" onClick={() => nav(`/signin?next=/templates/${tpl.id}`)}>
            Sign in to use it
          </Button>
        )}
      </section>
    </div>
  );
}
