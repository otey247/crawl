import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Bell, CheckCheck, Flag, Mail, MapPin, Route, Sparkles, UserCheck, Zap } from 'lucide-react';
import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { NotificationDTO } from '@crawl/core';
import { Button, Empty, PageSpinner } from '../components/ui';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';
import { CrawlRow } from './MyCrawls';

const ICON: Record<string, React.ReactNode> = {
  invite: <Mail className="size-5" />,
  'route.proposed': <Route className="size-5" />,
  'route.approved': <Route className="size-5" />,
  'special.highlight': <Zap className="size-5" />,
  'special.at_risk': <AlertTriangle className="size-5" />,
  'special.missed': <AlertTriangle className="size-5" />,
  'stop.arrived': <MapPin className="size-5" />,
  'crawl.live': <Sparkles className="size-5" />,
  'crawl.ended': <Flag className="size-5" />,
  role: <UserCheck className="size-5" />,
};

export function Invites() {
  const qc = useQueryClient();
  const nav = useNavigate();
  const invites = useQuery({ queryKey: ['my-invites'], queryFn: api.myInvites });
  const notifs = useQuery({ queryKey: ['notifications'], queryFn: api.notifications });
  const read = useMutation({ mutationFn: (ids?: string[]) => api.markRead(ids), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const join = useMutation({ mutationFn: (id: string) => api.join(id), onSuccess: (c) => (qc.invalidateQueries({ queryKey: ['my-invites'] }), nav(`/crawls/${c.id}`)) });

  // Mark as read a moment after viewing.
  const unread = notifs.data?.unread ?? 0;
  useEffect(() => {
    if (!unread) return;
    const t = setTimeout(() => read.mutate(undefined), 2500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread]);

  if (invites.isLoading || notifs.isLoading) return <PageSpinner />;
  const items = notifs.data?.items ?? [];
  return (
    <div className="px-4" style={{ paddingTop: 'max(20px, env(safe-area-inset-top))' }}>
      <div className="flex items-center justify-between">
        <h1 className="font-display text-[34px] font-bold">Invites</h1>
        {unread ? (
          <button className="inline-flex items-center gap-1.5 text-[14px] font-semibold text-dim" onClick={() => read.mutate(undefined)}>
            <CheckCheck className="size-4" /> Mark all read
          </button>
        ) : null}
      </div>

      {invites.data?.length ? (
        <section className="mt-6">
          <h2 className="mb-3 text-[13px] font-bold uppercase tracking-[0.14em] text-dim">Waiting on you</h2>
          <div className="space-y-3">
            {invites.data.map((inv) => (
              <div key={inv.crawl.id}>
                <CrawlRow crawl={inv.crawl} right={<span />} />
                <div className="mt-2 flex items-center gap-2 pl-2">
                  <p className="flex-1 text-[13px] text-dim">From {inv.invitedBy}</p>
                  <Button size="sm" variant="secondary" onClick={() => nav(`/crawls/${inv.crawl.id}`)}>
                    Details
                  </Button>
                  <Button size="sm" loading={join.isPending && join.variables === inv.crawl.id} onClick={() => join.mutate(inv.crawl.id)}>
                    Join
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-1 text-[13px] font-bold uppercase tracking-[0.14em] text-dim">Activity</h2>
        {items.length === 0 ? (
          <Empty icon={<Bell className="size-6" />} title="All quiet" body="Invites, route updates and specials alerts land here." />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((n) => (
              <NotificationRow key={n.id} n={n} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function NotificationRow({ n }: { n: NotificationDTO }) {
  const content = (
    <div className="flex gap-3 py-3.5">
      <span className={`flex size-10 shrink-0 items-center justify-center rounded-full ${n.kind === 'special.highlight' ? 'bg-amber text-amber-ink' : 'bg-raised text-fg border border-line'}`}>{ICON[n.kind] ?? <Bell className="size-5" />}</span>
      <div className="min-w-0 flex-1">
        <p className={`text-[15px] ${n.readAt ? 'font-medium' : 'font-semibold'}`}>{n.title}</p>
        <p className="text-[14px] text-dim">{n.body}</p>
        <p className="mt-0.5 text-[12px] text-faint">{fmtRelative(n.createdAt)}</p>
      </div>
      {!n.readAt ? <span className="mt-2 size-2.5 shrink-0 rounded-full bg-amber" aria-label="Unread" /> : null}
    </div>
  );
  return <li>{n.crawlId ? <Link to={`/crawls/${n.crawlId}`}>{content}</Link> : content}</li>;
}
