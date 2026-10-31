import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Link2, Send, Share2, UserPlus } from 'lucide-react';
import { useState } from 'react';
import type { CrawlDetailDTO, UserDTO } from '@crawl/core';
import { Avatar, Button, Segmented, errorMessage, inputCls, useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmtRelative } from '../lib/format';

export function InvitePanel({ crawl }: { crawl: CrawlDetailDTO }) {
  const qc = useQueryClient();
  const toast = useToast();
  const invites = useQuery({ queryKey: ['invites', crawl.id], queryFn: () => api.invites(crawl.id), enabled: crawl.permissions.canInvite });
  const [limit, setLimit] = useState<'none' | '10' | '25'>('none');
  const [expiry, setExpiry] = useState<'none' | '24' | '168'>('none');
  const create = useMutation({
    mutationFn: () => api.createInvite(crawl.id, { maxUses: limit === 'none' ? null : Number(limit), expiresInHours: expiry === 'none' ? null : Number(expiry) }),
    onSuccess: async (inv) => {
      qc.invalidateQueries({ queryKey: ['invites', crawl.id] });
      await share(inv.url);
    },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.revokeInvite(crawl.id, id), onSuccess: () => qc.invalidateQueries({ queryKey: ['invites', crawl.id] }) });

  async function share(url: string) {
    const text = `Join “${crawl.title}” on Crawl`;
    if (navigator.share) {
      try {
        await navigator.share({ title: crawl.title, text, url });
        return;
      } catch {
        /* cancelled or unsupported → fall through to copy */
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Invite link copied' });
    } catch {
      toast({ title: 'Copy this link', body: url });
    }
  }

  const active = (invites.data ?? []).filter((i) => !i.revokedAt);

  return (
    <div className="space-y-6">
      <section>
        <p className="font-display text-[20px] font-semibold">Invite link</p>
        <p className="mt-1 text-[14px] text-dim">
          {crawl.visibility === 'private' ? 'This crawl is invite-only. Anyone with a link can join until you revoke it.' : 'Public crawls can be joined from Explore, but a link is the fastest way to get your crew in.'}
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-dim">Uses</span>
            <Segmented size="sm" value={limit} onChange={setLimit} options={[{ value: 'none', label: '∞' }, { value: '10', label: '10' }, { value: '25', label: '25' }]} />
          </div>
          <div>
            <span className="mb-1.5 block text-[12px] font-semibold uppercase tracking-wider text-dim">Expires</span>
            <Segmented size="sm" value={expiry} onChange={setExpiry} options={[{ value: 'none', label: 'Never' }, { value: '24', label: '1 day' }, { value: '168', label: '1 wk' }]} />
          </div>
        </div>
        <Button className="mt-3 w-full" loading={create.isPending} onClick={() => create.mutate()}>
          <Share2 className="size-4" /> Create & share link
        </Button>
        <div className="mt-3 space-y-2">
          {active.map((inv) => (
            <div key={inv.id} className="flex items-center gap-3 rounded-2xl bg-raised px-4 py-3">
              <Link2 className="size-4 shrink-0 text-dim" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] font-medium">{inv.url.replace(/^https?:\/\//, '')}</p>
                <p className="text-[12px] text-dim">
                  {inv.uses}
                  {inv.maxUses ? `/${inv.maxUses}` : ''} joined · {inv.expiresAt ? `expires ${fmtRelative(inv.expiresAt)}` : 'no expiry'}
                </p>
              </div>
              <button aria-label="Copy link" className="p-2 text-fg" onClick={() => share(inv.url)}>
                <Copy className="size-4" />
              </button>
              <button className="text-[13px] font-semibold text-dim hover:text-fg" onClick={() => revoke.mutate(inv.id)}>
                Revoke
              </button>
            </div>
          ))}
        </div>
      </section>
      <DirectInvite crawl={crawl} />
    </div>
  );
}

function DirectInvite({ crawl }: { crawl: CrawlDetailDTO }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<UserDTO[]>([]);
  const results = useQuery({ queryKey: ['user-search', q], queryFn: () => api.searchUsers(q), enabled: q.length > 1 });
  const memberIds = new Set(crawl.members.map((m) => m.user.id));
  const send = useMutation({
    mutationFn: () => api.inviteUsers(crawl.id, picked.map((u) => u.id)),
    onSuccess: (r) => {
      toast({ title: r.invited ? `Invited ${r.invited} ${r.invited === 1 ? 'person' : 'people'}` : 'Already invited' });
      setPicked([]);
      setQ('');
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  return (
    <section>
      <p className="font-display text-[20px] font-semibold">Invite people on Crawl</p>
      <input className={`${inputCls} mt-3`} placeholder="Search by name or exact email" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-2 space-y-1">
        {results.data
          ?.filter((u) => !memberIds.has(u.id) && !picked.some((p) => p.id === u.id))
          .map((u) => (
            <button key={u.id} className="flex w-full items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-raised" onClick={() => setPicked((p) => [...p, u])}>
              <Avatar user={u} size={34} />
              <span className="flex-1 text-[15px]">{u.displayName}</span>
              <UserPlus className="size-4 text-dim" />
            </button>
          ))}
      </div>
      {picked.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {picked.map((u) => (
            <button key={u.id} onClick={() => setPicked((p) => p.filter((x) => x.id !== u.id))} className="inline-flex h-9 items-center gap-2 rounded-full bg-fg pl-1 pr-3 text-[14px] font-medium text-ink">
              <Avatar user={u} size={28} /> {u.displayName} ×
            </button>
          ))}
        </div>
      ) : null}
      <Button variant="secondary" className="mt-3 w-full" disabled={!picked.length} loading={send.isPending} onClick={() => send.mutate()}>
        <Send className="size-4" /> Send invites
      </Button>
    </section>
  );
}
