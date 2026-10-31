import { useMutation, useQuery } from '@tanstack/react-query';
import { Globe, Lock } from 'lucide-react';
import { DateTime } from 'luxon';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Field, Segmented, TopBar, errorMessage, inputCls } from '../components/ui';
import { api } from '../lib/api';

export function CreateCrawl() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const startVenue = params.get('venue');
  const hoods = useQuery({ queryKey: ['neighborhoods'], queryFn: api.neighborhoods, staleTime: Infinity });
  const tz = 'America/Chicago';
  const now = DateTime.now().setZone(tz);
  const defaultDay = now.hour >= 20 ? now.plus({ days: 1 }) : now;
  const [form, setForm] = useState({
    title: '',
    description: '',
    visibility: 'private' as 'public' | 'private',
    date: defaultDay.toISODate()!,
    startTime: '19:00',
    neighborhoodId: 'soulard',
  });
  const create = useMutation({
    mutationFn: async () => {
      const crawl = await api.createCrawl({ ...form, description: form.description || undefined });
      if (startVenue) await api.addStop(crawl.id, startVenue);
      return crawl;
    },
    onSuccess: (c) => nav(`/crawls/${c.id}/plan`, { replace: true }),
  });

  return (
    <div className="min-h-full pb-10">
      <TopBar title="New crawl" />
      <form
        className="space-y-5 px-5 pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <h1 className="font-display text-[30px] font-semibold leading-tight">What’s the plan?</h1>
        <Field label="Name">
          <input className={inputCls} required minLength={2} maxLength={80} autoFocus placeholder="Soulard Saturday Crawl" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Description" hint="Meeting spot, dress code, ground rules.">
          <textarea className={`${inputCls} h-24 py-3`} maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            <input type="date" className={inputCls} required min={now.toISODate()!} value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          </Field>
          <Field label="Start">
            <input type="time" className={inputCls} required value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
          </Field>
        </div>
        <Field label="Neighborhood">
          <select className={inputCls} value={form.neighborhoodId} onChange={(e) => setForm({ ...form, neighborhoodId: e.target.value })}>
            {(hoods.data ?? [{ id: 'soulard', name: 'Soulard', cityName: 'St. Louis', venueCount: 1 }]).map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}, {h.cityName}
                {h.venueCount ? '' : ' (venue data coming soon)'}
              </option>
            ))}
          </select>
        </Field>
        <div>
          <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wider text-dim">Who can join</span>
          <Segmented
            value={form.visibility}
            onChange={(visibility) => setForm({ ...form, visibility })}
            options={[
              { value: 'private', label: 'Invite only', icon: <Lock className="size-4" /> },
              { value: 'public', label: 'Public', icon: <Globe className="size-4" /> },
            ]}
          />
          <p className="mt-2 text-[13px] text-faint">
            {form.visibility === 'public' ? 'Anyone nearby can find and join. Location, photos and the guest list stay members-only.' : 'Only people with your invite link can see it.'}
          </p>
        </div>
        {create.error ? <p className="text-[14px] text-alert">{errorMessage(create.error)}</p> : null}
        <Button type="submit" size="lg" className="w-full" loading={create.isPending}>
          Next: pick bars
        </Button>
      </form>
    </div>
  );
}
