import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, CircleHelp, MoreHorizontal, Navigation, X } from 'lucide-react';
import { useState } from 'react';
import { CREW_ROLES, type CrawlDetailDTO, type CrewRole, type MemberDTO, type Rsvp } from '@crawl/core';
import { CREW_META, CrewBadge, RoleBadge, RsvpStatus } from '../components/domain';
import { Avatar, Button, Segmented, Sheet, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export function RsvpToggle({ crawl }: { crawl: CrawlDetailDTO }) {
  const qc = useQueryClient();
  const toast = useToast();
  const mine = crawl.myMembership;
  const m = useMutation({
    mutationFn: (rsvp: Rsvp) => api.updateMyMembership(crawl.id, { rsvp }),
    onMutate: (rsvp) => qc.setQueryData<CrawlDetailDTO>(['crawl', crawl.id], (old) => (old && old.myMembership ? { ...old, myMembership: { ...old.myMembership, rsvp } } : old)),
    onSettled: () => qc.invalidateQueries({ queryKey: ['crawl', crawl.id] }),
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  if (!mine) return null;
  return (
    <div>
      <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-dim">Your RSVP</p>
      <Segmented<Rsvp>
        value={mine.rsvp}
        onChange={(v) => m.mutate(v)}
        options={[
          { value: 'going', label: 'Going', icon: <Check className="size-4" strokeWidth={2.5} /> },
          { value: 'maybe', label: 'Maybe', icon: <CircleHelp className="size-4" /> },
          { value: 'declined', label: "Can't make it", icon: <X className="size-4" /> },
        ]}
      />
    </div>
  );
}

export function People({ crawl }: { crawl: CrawlDetailDTO }) {
  const { me } = useAuth();
  const [editing, setEditing] = useState<MemberDTO | null>(null);
  const counts = { going: 0, maybe: 0, declined: 0 } as Record<Rsvp, number>;
  for (const m of crawl.members) counts[m.rsvp]++;
  const crew = crawl.members.filter((m) => m.crewRole);
  const isLive = crawl.status === 'live';
  const leaderId = crawl.live?.leaderUserId;

  return (
    <div className="space-y-6">
      <RsvpToggle crawl={crawl} />

      <div className="grid grid-cols-3 gap-2 text-center">
        {(['going', 'maybe', 'declined'] as Rsvp[]).map((r) => (
          <div key={r} className="rounded-2xl bg-surface border border-line py-3">
            <p className="text-[24px] font-semibold tabular">{counts[r]}</p>
            <p className="text-[12px] font-semibold uppercase tracking-wider text-dim">{r === 'declined' ? "Can't" : r}</p>
          </div>
        ))}
      </div>

      {crew.length ? (
        <div>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-dim">Crew</p>
          <div className="flex flex-wrap gap-2">
            {crew.map((m) => {
              const { Icon, label } = CREW_META[m.crewRole!];
              return (
                <span key={m.user.id} className="inline-flex h-10 items-center gap-2 rounded-full bg-surface border border-line pl-1 pr-3.5 text-[14px]">
                  <Avatar user={m.user} size={32} />
                  <span className="font-semibold">{m.user.displayName.split(' ')[0]}</span>
                  <span className="inline-flex items-center gap-1 text-dim">
                    <Icon className="size-4 text-amber" /> {label}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      ) : null}

      <ul className="divide-y divide-line" aria-label="Attendees">
        {crawl.members.map((m) => (
          <li key={m.user.id} className="flex items-center gap-3 py-3">
            <Avatar user={m.user} size={44} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 truncate text-[16px] font-semibold">
                {m.user.displayName}
                {m.user.id === me?.id ? <span className="text-[13px] font-normal text-dim">(you)</span> : null}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <RsvpStatus rsvp={m.rsvp} />
                <RoleBadge role={m.role} />
                {m.crewRole ? <CrewBadge role={m.crewRole} /> : null}
                {isLive && leaderId === m.user.id ? (
                  <span className="inline-flex h-6 items-center gap-1 rounded-full border border-line-strong px-2 text-[12px] font-semibold">
                    <Navigation className="size-3 text-amber" /> Leading
                  </span>
                ) : null}
                {m.checkInCount ? <span className="text-[12px] text-dim">· {m.checkInCount} check-in{m.checkInCount > 1 ? 's' : ''}</span> : null}
              </div>
            </div>
            {crawl.permissions.canManageMembers && m.role !== 'organizer' ? (
              <button aria-label={`Manage ${m.user.displayName}`} onClick={() => setEditing(m)} className="flex size-10 items-center justify-center rounded-full border border-line">
                <MoreHorizontal className="size-5" />
              </button>
            ) : crawl.permissions.canManageMembers && isLive && leaderId !== m.user.id ? (
              <button aria-label={`Manage ${m.user.displayName}`} onClick={() => setEditing(m)} className="flex size-10 items-center justify-center rounded-full border border-line">
                <MoreHorizontal className="size-5" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      <MemberSheet crawl={crawl} member={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function MemberSheet({ crawl, member, onClose }: { crawl: CrawlDetailDTO; member: MemberDTO | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const done = () => {
    qc.invalidateQueries({ queryKey: ['crawl', crawl.id] });
    onClose();
  };
  const onError = (e: unknown) => toast({ title: errorMessage(e) });
  const update = useMutation({ mutationFn: (b: { role?: 'co_host' | 'participant'; crewRole?: CrewRole | null }) => api.updateMember(crawl.id, member!.user.id, b), onSuccess: done, onError });
  const remove = useMutation({ mutationFn: () => api.removeMember(crawl.id, member!.user.id), onSuccess: done, onError });
  const leader = useMutation({ mutationFn: () => api.setLeader(crawl.id, member!.user.id), onSuccess: () => (toast({ title: `${member!.user.displayName} is now leading`, body: 'Their phone’s location now drives the group position.' }), done()), onError });
  if (!member) return null;
  return (
    <Sheet open onClose={onClose} title={member.user.displayName}>
      <div className="space-y-6 pb-2">
        <div>
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-dim">Crew role</p>
          <div className="grid gap-2">
            {CREW_ROLES.map((r) => {
              const { Icon } = CREW_META[r.id];
              const holder = crawl.members.find((m) => m.crewRole === r.id && m.user.id !== member.user.id);
              const active = member.crewRole === r.id;
              return (
                <button
                  key={r.id}
                  onClick={() => update.mutate({ crewRole: active ? null : r.id })}
                  className={`flex h-14 items-center gap-3 rounded-2xl px-4 text-left ${active ? 'bg-fg text-ink' : 'bg-raised'}`}
                  aria-pressed={active}
                >
                  <Icon className={`size-5 ${active ? '' : 'text-amber'}`} />
                  <span className="flex-1 text-[16px] font-semibold">{r.label}</span>
                  <span className={`text-[13px] ${active ? 'text-[#4a4741]' : 'text-dim'}`}>{active ? 'Assigned · tap to clear' : holder ? `Replaces ${holder.user.displayName.split(' ')[0]}` : ''}</span>
                </button>
              );
            })}
          </div>
        </div>
        {member.role !== 'organizer' ? (
          <div>
            <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-dim">Permissions</p>
            <Segmented
              value={member.role}
              onChange={(role) => update.mutate({ role: role as 'co_host' | 'participant' })}
              options={[
                { value: 'participant', label: 'Participant' },
                { value: 'co_host', label: 'Co-host' },
              ]}
            />
            <p className="mt-2 text-[13px] text-faint">Co-hosts can edit stops, run the live crawl, invite people and moderate photos.</p>
          </div>
        ) : null}
        <div className="flex flex-col gap-2">
          {crawl.status === 'live' && crawl.live?.leaderUserId !== member.user.id ? (
            <Button variant="secondary" loading={leader.isPending} onClick={() => leader.mutate()}>
              <Navigation className="size-4" /> Make group leader
            </Button>
          ) : null}
          {member.role !== 'organizer' ? (
            <Button variant="ghost" className="text-dim" loading={remove.isPending} onClick={() => confirm(`Remove ${member.user.displayName} from the crawl?`) && remove.mutate()}>
              Remove from crawl
            </Button>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
