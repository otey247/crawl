import { useMutation } from '@tanstack/react-query';
import { BadgeCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { VenueDTO } from '@crawl/core';
import { Button, Field, Sheet, errorMessage, inputCls } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

const ROLES = [
  { value: 'owner', label: 'Owner' },
  { value: 'general_manager', label: 'General manager' },
  { value: 'bar_manager', label: 'Bar manager' },
  { value: 'marketing', label: 'Marketing' },
];

/** "Own or manage this bar?" — email on the venue's domain verifies instantly; otherwise an admin reviews. */
export function ClaimVenueSheet({ venue, open, onClose }: { venue: VenueDTO; open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const { refresh } = useAuth();
  const [form, setForm] = useState({ contactEmail: '', contactPhone: '', role: 'owner', message: '' });
  const [code, setCode] = useState('');
  const claim = useMutation({ mutationFn: () => api.claimVenue(venue.id, { ...form, contactPhone: form.contactPhone || null, message: form.message || null }) });
  const verify = useMutation({
    mutationFn: () => api.verifyClaim(claim.data!.claimId, code),
    onSuccess: (r) => {
      refresh();
      onClose();
      nav(`/venues/${r.venueId}/manage`);
    },
  });
  return (
    <Sheet open={open} onClose={onClose} title={`Manage ${venue.name}`}>
      <div className="pb-2">
        {!claim.data ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              claim.mutate();
            }}
          >
            <p className="text-[14px] text-dim">Verified venues post specials marked “From the venue”, use their own photos, and see how many crawls plan to stop by. Use an email on your bar’s website domain to verify instantly.</p>
            <Field label="Work email">
              <input type="email" className={inputCls} required value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} placeholder="you@yourbar.com" />
            </Field>
            <Field label="Your role">
              <select className={inputCls} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Phone (optional)" hint="Only used by Crawl to confirm a claim.">
              <input type="tel" className={inputCls} value={form.contactPhone} onChange={(e) => setForm({ ...form, contactPhone: e.target.value })} />
            </Field>
            <Field label="Anything that helps us verify (optional)">
              <textarea className={`${inputCls} h-20 py-3`} maxLength={500} value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} />
            </Field>
            {claim.error ? <p className="text-[14px] text-alert">{errorMessage(claim.error)}</p> : null}
            <Button type="submit" className="w-full" loading={claim.isPending}>
              Request access
            </Button>
          </form>
        ) : claim.data.verification === 'email_domain' ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              verify.mutate();
            }}
          >
            <p className="text-[15px]">{claim.data.message}</p>
            {claim.data.devCode ? <p className="text-[13px] text-dim">Development code: {claim.data.devCode}</p> : null}
            <input
              className={`${inputCls} text-center text-[22px] tracking-[0.5em] tabular`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              required
              pattern="\d{6}"
              aria-label="6-digit code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            {verify.error ? <p className="text-[14px] text-alert">{errorMessage(verify.error)}</p> : null}
            <Button type="submit" className="w-full" loading={verify.isPending} disabled={code.length !== 6}>
              <BadgeCheck className="size-5" /> Verify
            </Button>
          </form>
        ) : (
          <div className="space-y-4">
            <p className="text-[15px]">{claim.data.message}</p>
            <p className="text-[14px] text-dim">You’ll get a notification when it’s approved. Track it under Profile → Manage a bar.</p>
            <Button className="w-full" onClick={onClose}>
              Done
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
