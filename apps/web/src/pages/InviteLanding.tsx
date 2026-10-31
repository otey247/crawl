import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarDays, MapPin, Users } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { VenueArt } from '../components/domain';
import { Avatar, Button, Empty, PageSpinner, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtWhen } from '../lib/format';

/** Read-only invite landing page; deep-links into the app once signed in. */
export function InviteLanding() {
  const { token } = useParams<{ token: string }>();
  const nav = useNavigate();
  const { me } = useAuth();
  const preview = useQuery({ queryKey: ['invite', token], queryFn: () => api.invitePreview(token!), retry: false });
  const accept = useMutation({ mutationFn: () => api.acceptInvite(token!), onSuccess: (c) => nav(`/crawls/${c.id}`, { replace: true }) });
  if (preview.isLoading) return <PageSpinner />;
  if (!preview.data) return <Empty icon={<Users className="size-6" />} title="Invite not found" body="Ask the organizer for a new link." />;
  const { crawl, valid, reason } = preview.data;
  return (
    <div className="flex min-h-full flex-col px-5 pb-10" style={{ paddingTop: 'max(28px, env(safe-area-inset-top))' }}>
      <p className="font-display text-[32px] font-bold text-amber">Crawl</p>
      <VenueArt name={crawl.firstStop?.name ?? crawl.title} category="pub" className="mt-6 h-48 rounded-3xl" />
      <p className="mt-6 text-[13px] font-semibold uppercase tracking-[0.14em] text-dim">You’re invited</p>
      <h1 className="mt-1 font-display text-[34px] font-bold leading-tight">{crawl.title}</h1>
      <div className="mt-4 space-y-2 text-[16px]">
        <p className="flex items-center gap-2">
          <CalendarDays className="size-5 text-dim" /> {fmtWhen(crawl.startAt, crawl.timezone)}
        </p>
        {crawl.firstStop ? (
          <p className="flex items-center gap-2">
            <MapPin className="size-5 text-dim" /> Starts at {crawl.firstStop.name} · {crawl.stopCount} stops
          </p>
        ) : null}
        <p className="flex items-center gap-2">
          <Avatar user={crawl.organizer} size={24} /> {crawl.organizer.displayName} · {crawl.goingCount} going
        </p>
      </div>
      <div className="mt-auto pt-10">
        {!valid ? (
          <p className="rounded-2xl border border-line p-4 text-[15px]">{reason}</p>
        ) : me ? (
          <>
            <Button size="lg" className="w-full" loading={accept.isPending} onClick={() => accept.mutate()}>
              Join the crawl
            </Button>
            {accept.error ? <p className="mt-3 text-center text-[14px] text-alert">{errorMessage(accept.error)}</p> : null}
          </>
        ) : (
          <Button size="lg" className="w-full" onClick={() => nav(`/signin?next=${encodeURIComponent(`/i/${token}`)}`)}>
            Sign in to join
          </Button>
        )}
      </div>
    </div>
  );
}
