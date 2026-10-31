import { Beer, Camera, Car, Check, CircleHelp, Compass, Crown, Martini, Shield, TreeDeciduous, Wine, X } from 'lucide-react';
import { useState } from 'react';
import type { CrewRole, ImageCreditDTO, MemberRole, Rsvp, SpecialDTO, SpecialState, VenueDTO } from '@crawl/core';
import { RSVP_LABELS } from '@crawl/core';

export function CategoryIcon({ category, className = 'size-5' }: { category: VenueDTO['category']; className?: string }) {
  const Icon = { pub: Beer, bar: Wine, cocktail: Martini, biergarten: TreeDeciduous }[category] ?? Beer;
  return <Icon className={className} />;
}

/**
 * Stylized venue artwork, used until a venue supplies photography: warm interior glow,
 * a run of string lights and the venue's category mark.
 */
export function VenueArt({ name, category, className = '', compact }: { name: string; category: VenueDTO['category']; className?: string; compact?: boolean }) {
  const seed = [...name].reduce((a, c) => a + c.charCodeAt(0), 0);
  const glowX = 30 + (seed % 40);
  return (
    <div
      className={`relative overflow-hidden bg-[#120e09] ${className}`}
      style={{
        backgroundImage: `radial-gradient(120% 80% at ${glowX}% 100%, rgba(246,183,60,.38), rgba(120,60,10,.18) 45%, transparent 70%), linear-gradient(180deg, #0b0b0c 0%, #17110a 100%)`,
      }}
      aria-hidden
    >
      <svg className="absolute inset-x-0 top-0 h-1/3 w-full" viewBox="0 0 100 30" preserveAspectRatio="none">
        <path d={`M0 ${6 + (seed % 5)} Q 50 ${20 + (seed % 6)} 100 ${4 + (seed % 7)}`} stroke="#3a2a14" strokeWidth=".6" fill="none" />
        {Array.from({ length: 9 }, (_, i) => {
          const x = 6 + i * 11;
          const t = x / 100;
          const y = (1 - t) * (1 - t) * (6 + (seed % 5)) + 2 * (1 - t) * t * (20 + (seed % 6)) + t * t * (4 + (seed % 7));
          return <circle key={i} cx={x} cy={y + 1.5} r="1.4" fill="#ffd27a" style={{ filter: 'drop-shadow(0 0 2px #f6b73c)' }} />;
        })}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-amber/90">
        <CategoryIcon category={category} className={compact ? 'size-8' : 'size-12'} />
      </div>
      {!compact ? (
        <div className="absolute inset-x-0 bottom-0 p-3">
          <p className="font-display text-[15px] font-semibold leading-tight text-fg/95 [text-shadow:0_2px_8px_rgba(0,0,0,.8)] line-clamp-2">{name}</p>
        </div>
      ) : null}
    </div>
  );
}

/** Real venue photo when we have one (480 px variant for small tiles), illustrated art otherwise. */
export function VenueImage({
  name,
  category,
  imageUrl,
  className = '',
  compact,
  size = 'full',
}: {
  name: string;
  category: VenueDTO['category'];
  imageUrl: string | null | undefined;
  className?: string;
  compact?: boolean;
  size?: 'full' | 'thumb';
}) {
  const [failed, setFailed] = useState(false);
  if (!imageUrl || failed) return <VenueArt name={name} category={category} className={className} compact={compact} />;
  const src = size === 'thumb' && imageUrl.startsWith('/v1/venue-images/') ? imageUrl.replace(/\.jpg$/, '-480.jpg') : imageUrl;
  return (
    <div className={`relative overflow-hidden bg-raised ${className}`}>
      <img src={src} alt={`${name}`} loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      {!compact ? (
        <>
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/10 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-3">
            <p className="font-display text-[15px] font-semibold leading-tight text-fg [text-shadow:0_2px_8px_rgba(0,0,0,.8)] line-clamp-2">{name}</p>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function PhotoCredit({ credit }: { credit: ImageCreditDTO | null }) {
  if (!credit) return null;
  const text = ['Photo', credit.author ? `by ${credit.author}` : null, credit.license ? `· ${credit.license}` : null].filter(Boolean).join(' ');
  return credit.sourcePage ? (
    <a href={credit.sourcePage} target="_blank" rel="noreferrer" className="text-[11px] text-faint underline-offset-2 hover:underline">
      {text}
    </a>
  ) : (
    <span className="text-[11px] text-faint">{text}</span>
  );
}

export const CREW_META: Record<CrewRole, { label: string; Icon: typeof Car }> = {
  designated_driver: { label: 'Designated Driver', Icon: Car },
  navigator: { label: 'Navigator', Icon: Compass },
  photographer: { label: 'Photographer', Icon: Camera },
};

export function CrewBadge({ role }: { role: CrewRole }) {
  const { label, Icon } = CREW_META[role];
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full bg-fg px-2 text-[12px] font-semibold text-ink">
      <Icon className="size-3.5" strokeWidth={2.5} />
      {label}
    </span>
  );
}

export function RoleBadge({ role }: { role: MemberRole }) {
  if (role === 'participant') return null;
  const Icon = role === 'organizer' ? Crown : Shield;
  return (
    <span className="inline-flex h-6 items-center gap-1 rounded-full border border-line-strong px-2 text-[12px] font-semibold text-fg">
      <Icon className="size-3.5 text-amber" strokeWidth={2.5} />
      {role === 'organizer' ? 'Organizer' : 'Co-host'}
    </span>
  );
}

export function RsvpStatus({ rsvp }: { rsvp: Rsvp }) {
  const Icon = rsvp === 'going' ? Check : rsvp === 'maybe' ? CircleHelp : X;
  return (
    <span className={`inline-flex items-center gap-1 text-[13px] font-medium ${rsvp === 'going' ? 'text-fg' : 'text-dim'}`}>
      <Icon className={`size-4 ${rsvp === 'going' ? 'text-live' : ''}`} strokeWidth={2.5} />
      {RSVP_LABELS[rsvp]}
    </span>
  );
}

export function SourceLabel({ source, confidence }: { source: SpecialDTO['source']; confidence?: number }) {
  const text = source === 'venue' ? 'From the venue' : source === 'organizer' ? 'Added by organizer' : `Crowd-reported${confidence != null ? ` · ${Math.round(confidence * 100)}%` : ''}`;
  return <span className="text-[12px] text-faint">{text}</span>;
}

/** How each special state reads in the itinerary. Emphasis via weight and contrast, not tint. */
export const STATE_COPY: Record<SpecialState, { label: string; tone: 'strong' | 'normal' | 'warn' | 'muted' }> = {
  highlight: { label: 'Live when you arrive', tone: 'strong' },
  on_track: { label: 'On track', tone: 'normal' },
  at_risk: { label: 'Cutting it close', tone: 'warn' },
  projected_miss: { label: 'Will miss it', tone: 'warn' },
  missed: { label: 'Missed', tone: 'muted' },
  caught: { label: 'Caught it', tone: 'normal' },
  unavailable: { label: 'Not running tonight', tone: 'muted' },
};
