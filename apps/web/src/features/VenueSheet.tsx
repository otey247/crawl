import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgeCheck, Clock, MapPin, Plus, ThumbsUp } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SpecialDTO, VenueDTO } from '@crawl/core';
import { PhotoCredit, SourceLabel, VenueImage } from '../components/domain';
import { Button, Field, Sheet, Spinner, errorMessage, inputCls, useToast } from '../components/ui';
import { api, type SpecialInput } from '../lib/api';
import { ClaimVenueSheet } from './ClaimVenue';
import { useAuth } from '../lib/auth';
import { priceLabel } from '../lib/format';

export function VenueSheet({ venueId, onClose, actions }: { venueId: string | null; onClose: () => void; actions?: (v: VenueDTO) => React.ReactNode }) {
  const venue = useQuery({ queryKey: ['venue', venueId], queryFn: () => api.venue(venueId!), enabled: !!venueId });
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const confirm = useMutation({
    mutationFn: api.confirmSpecial,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['venue', venueId] });
      toast({ title: 'Thanks for confirming' });
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  const v = venue.data;
  return (
    <Sheet open={!!venueId} onClose={() => (setAdding(false), onClose())} title={v?.name ?? ' '}>
      {!v ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="pb-2">
          <VenueImage name={v.name} category={v.category} imageUrl={v.imageUrl} compact className="h-44 w-full rounded-2xl" />
          <div className="mt-1 text-right">
            <PhotoCredit credit={v.imageCredit} />
          </div>
          {v.status !== 'open' ? (
            <p className="mt-3 rounded-2xl border border-line-strong px-4 py-3 text-[14px]">
              <span className="font-semibold">Reported closed.</span> <span className="text-dim">{v.statusNote}</span>
            </p>
          ) : null}
          <div className="mt-4 space-y-2 text-[15px]">
            {v.verified ? (
              <p className="flex items-center gap-2 font-semibold">
                <BadgeCheck className="size-4 shrink-0 text-amber" /> Managed by the venue
              </p>
            ) : null}
            {v.address ? (
              <p className="flex items-center gap-2 text-dim">
                <MapPin className="size-4 shrink-0" /> {v.address}
              </p>
            ) : null}
            <p className="flex items-center gap-2">
              <Clock className="size-4 shrink-0 text-dim" />
              {v.openNow === null ? <span className="text-dim">Hours not listed</span> : v.openNow ? <span className="font-semibold">Open now</span> : <span className="text-dim">Closed now</span>}
              {v.openingHours ? <span className="truncate text-faint">· {v.openingHours}</span> : null}
            </p>
            <p className="text-dim">{[priceLabel(v.priceLevel), ...v.tags].filter(Boolean).join(' · ')}</p>
          </div>

          <h3 className="mt-6 text-[13px] font-semibold uppercase tracking-wider text-dim">Specials</h3>
          <div className="mt-2 space-y-2">
            {v.specials.length === 0 ? <p className="text-[15px] text-dim">No specials reported yet.</p> : null}
            {v.specials.map((s) => (
              <SpecialRow
                key={s.id}
                special={s}
                right={
                  me && s.source === 'crowd' ? (
                    <button className="inline-flex h-9 items-center gap-1.5 rounded-full border border-line-strong px-3 text-[13px] font-semibold" onClick={() => confirm.mutate(s.id)}>
                      <ThumbsUp className="size-3.5" /> Still on
                    </button>
                  ) : null
                }
              />
            ))}
          </div>

          {adding ? (
            <div className="mt-4 rounded-2xl border border-line p-4">
              <SpecialForm
                venueId={v.id}
                onDone={() => {
                  setAdding(false);
                  qc.invalidateQueries({ queryKey: ['venue', venueId] });
                  qc.invalidateQueries({ queryKey: ['venues'] });
                  toast({ title: 'Special added', body: 'Others can confirm it to raise its confidence.' });
                }}
              />
            </div>
          ) : me ? (
            <button className="mt-3 inline-flex items-center gap-1.5 text-[15px] font-semibold text-amber" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Report a special
            </button>
          ) : null}

          <div className="mt-6 flex gap-2">
            {actions ? actions(v) : <Button className="flex-1" onClick={() => nav(`/crawls/new?venue=${v.id}`)}>Start a crawl here</Button>}
          </div>
          {me?.managedVenueIds.includes(v.id) ? (
            <button className="mt-4 w-full text-center text-[14px] font-semibold text-amber" onClick={() => nav(`/venues/${v.id}/manage`)}>
              Manage this bar
            </button>
          ) : me && !v.verified ? (
            <button className="mt-4 w-full text-center text-[14px] text-dim hover:text-fg" onClick={() => setClaiming(true)}>
              Own or manage {v.name}? Claim this listing
            </button>
          ) : null}
          {claiming ? <ClaimVenueSheet venue={v} open onClose={() => setClaiming(false)} /> : null}
        </div>
      )}
    </Sheet>
  );
}

export function SpecialRow({ special, right, state }: { special: SpecialDTO; right?: React.ReactNode; state?: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-raised px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-[16px] font-semibold">{special.title}</p>
          {special.liveNow ? <span className="shrink-0 rounded-full bg-amber px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-ink">Live</span> : null}
        </div>
        <p className="truncate text-[14px] text-dim">
          {special.label}
          {special.details ? ` · ${special.details}` : ''}
        </p>
        {state ?? <SourceLabel source={special.source} confidence={special.confidence} />}
      </div>
      {right}
    </div>
  );
}

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export function SpecialForm({ venueId, crawlId, onDone }: { venueId: string; crawlId?: string; onDone: () => void }) {
  const [form, setForm] = useState<SpecialInput>({ title: '', details: '', daysOfWeek: [], startTime: '16:00', endTime: '19:00', crawlId: crawlId ?? null });
  const m = useMutation({ mutationFn: () => api.addSpecial(venueId, { ...form, details: form.details || null }), onSuccess: onDone });
  const toggle = (d: number) => setForm((f) => ({ ...f, daysOfWeek: f.daysOfWeek.includes(d) ? f.daysOfWeek.filter((x) => x !== d) : [...f.daysOfWeek, d].sort() }));
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <Field label="Special">
        <input className={inputCls} required minLength={2} maxLength={80} placeholder="$3 pints" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <Field label="Details">
        <input className={inputCls} maxLength={280} placeholder="Domestic drafts only" value={form.details ?? ''} onChange={(e) => setForm({ ...form, details: e.target.value })} />
      </Field>
      <div>
        <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wider text-dim">Days</span>
        <div className="flex gap-1.5">
          {DAYS.map((d, i) => {
            const on = form.daysOfWeek.includes(i + 1);
            return (
              <button type="button" key={i} aria-pressed={on} aria-label={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][i]} onClick={() => toggle(i + 1)} className={`size-10 rounded-full text-[14px] font-semibold ${on ? 'bg-fg text-ink' : 'bg-raised border border-line text-dim'}`}>
                {d}
              </button>
            );
          })}
        </div>
        <span className="mt-1.5 block text-[13px] text-faint">{form.daysOfWeek.length === 0 ? 'Every day' : ''}</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts">
          <input type="time" className={inputCls} value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} required />
        </Field>
        <Field label="Ends" hint={form.endTime <= form.startTime ? 'Runs past midnight' : undefined}>
          <input type="time" className={inputCls} value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} required />
        </Field>
      </div>
      {m.error ? <p className="text-[14px] text-alert">{errorMessage(m.error)}</p> : null}
      <Button type="submit" className="w-full" loading={m.isPending}>
        {crawlId ? 'Add to this crawl' : 'Submit special'}
      </Button>
    </form>
  );
}
