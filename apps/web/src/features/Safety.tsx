import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Car, Check, HeartHandshake, House, Phone, Share2, ShieldPlus, Siren } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CrawlDetailDTO } from '@crawl/core';
import { CrewBadge } from '../components/domain';
import { Avatar, Button, Sheet, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtTime } from '../lib/format';
import { useGeolocation } from '../lib/geo';

const fmtPhone = (p: string) => p.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3');

export function SafetyButton({ crawl, className = '' }: { crawl: CrawlDetailDTO; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} aria-label="Safety" className={`inline-flex h-11 items-center gap-1.5 rounded-full bg-ink/90 px-4 text-[14px] font-semibold shadow-float ${className}`}>
        <ShieldPlus className="size-4 text-amber" /> Safety
      </button>
      <SafetySheet crawl={crawl} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function SafetySheet({ crawl, open, onClose }: { crawl: CrawlDetailDTO; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const nav = useNavigate();
  const geo = useGeolocation(false);
  const s = crawl.safety;
  const drivers = crawl.members.filter((m) => m.crewRole === 'designated_driver');

  async function shareLocation() {
    const share = async (lat: number, lng: number) => {
      const url = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
      const text = `I’m here (${crawl.title})`;
      try {
        if (navigator.share) await navigator.share({ title: 'My location', text, url });
        else {
          await navigator.clipboard.writeText(`${text}: ${url}`);
          toast({ title: 'Location link copied' });
        }
      } catch {
        /* cancelled */
      }
    };
    if (geo.position) return share(geo.position.lat, geo.position.lng);
    navigator.geolocation?.getCurrentPosition(
      (p) => share(p.coords.latitude, p.coords.longitude),
      () => toast({ title: 'Couldn’t get your location', body: 'Check location permission for Crawl.' }),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  const row = (href: string, icon: React.ReactNode, title: string, sub: string, strong = false) => (
    <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer" className={`flex items-center gap-3 rounded-2xl px-4 py-3.5 ${strong ? 'bg-alert text-white' : 'bg-raised'}`}>
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${strong ? 'bg-white/15' : 'bg-ink text-amber'}`}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[16px] font-semibold">{title}</span>
        <span className={`block text-[13px] ${strong ? 'text-white/80' : 'text-dim'}`}>{sub}</span>
      </span>
    </a>
  );

  return (
    <Sheet open={open} onClose={onClose} title="Get home safe">
      <div className="space-y-2 pb-3">
        {s ? (
          <>
            {row(`tel:${s.emergency}`, <Siren className="size-5" />, `Call ${s.emergency}`, 'Emergency: police, fire, ambulance', true)}
            {row(`tel:${s.crisisLine.phone}`, <HeartHandshake className="size-5" />, s.crisisLine.label, 'Call or text, 24/7')}
            <p className="pt-3 text-[13px] font-semibold uppercase tracking-wider text-dim">Rides</p>
            {drivers.map((d) => (
              <div key={d.user.id} className="flex items-center gap-3 rounded-2xl bg-raised px-4 py-3">
                <Avatar user={d.user} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold">{d.user.displayName}</p>
                  <CrewBadge role="designated_driver" />
                </div>
              </div>
            ))}
            {crawl.permissions.isMember ? (
              <button
                onClick={() => {
                  onClose();
                  nav(`/crawls/${crawl.id}?tab=people`);
                }}
                className="flex w-full items-center gap-3 rounded-2xl bg-raised px-4 py-3.5 text-left"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-amber">
                  <Car className="size-5" />
                </span>
                <span>
                  <span className="block text-[16px] font-semibold">Ride board</span>
                  <span className="block text-[13px] text-dim">Seats with this crawl’s Designated Drivers</span>
                </span>
              </button>
            ) : null}
            {s.rideApps.map((r) => row(r.url, <Car className="size-5" />, r.name, 'Open the app to request a ride'))}
            {s.cabs.map((c) => row(`tel:${c.phone}`, <Phone className="size-5" />, c.name, fmtPhone(c.phone)))}
          </>
        ) : null}
        <p className="pt-3 text-[13px] font-semibold uppercase tracking-wider text-dim">Let someone know</p>
        <button onClick={shareLocation} className="flex w-full items-center gap-3 rounded-2xl bg-raised px-4 py-3.5 text-left">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-amber">
            <Share2 className="size-5" />
          </span>
          <span>
            <span className="block text-[16px] font-semibold">Share my location</span>
            <span className="block text-[13px] text-dim">Send a map link to anyone, from any app</span>
          </span>
        </button>
        <p className="pt-3 text-[13px] leading-relaxed text-dim">Pace yourself: water between stops, food early, and never drive after drinking.</p>
      </div>
    </Sheet>
  );
}

/** After the crawl: “I’m home” for members, plus who has checked in for the organizer. */
export function HomeSafeCard({ crawl }: { crawl: CrawlDetailDTO }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const mine = crawl.members.find((m) => m.user.id === me?.id);
  const going = crawl.members.filter((m) => m.rsvp === 'going');
  const home = going.filter((m) => m.homeSafeAt);
  const m = useMutation({
    mutationFn: () => api.homeSafe(crawl.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['crawl', crawl.id] });
      toast({ title: 'Glad you made it', body: 'The crew can see you’re home.' });
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  if (!mine) return null;
  return (
    <section aria-label="Home safe" className="rounded-3xl border border-line bg-surface p-4">
      {mine.homeSafeAt ? (
        <p className="flex items-center gap-2 text-[16px] font-semibold">
          <Check className="size-5 text-live" strokeWidth={3} /> You’re home safe · {fmtTime(mine.homeSafeAt, crawl.timezone)}
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <House className="size-7 shrink-0 text-amber" />
          <div className="min-w-0 flex-1">
            <p className="text-[17px] font-semibold">Home safe?</p>
            <p className="text-[14px] text-dim">Let the crew know you made it.</p>
          </div>
          <Button loading={m.isPending} onClick={() => m.mutate()}>
            I’m home
          </Button>
        </div>
      )}
      {crawl.permissions.canRunLive && going.length ? (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-[13px] font-semibold text-dim">
            {home.length} of {going.length} home
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {going
              .filter((g) => !g.homeSafeAt)
              .map((g) => (
                <span key={g.user.id} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line pl-1 pr-3 text-[13px]">
                  <Avatar user={g.user} size={24} /> {g.user.displayName.split(' ')[0]}
                </span>
              ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
