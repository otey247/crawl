import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EyeOff, UserCheck, UserPlus, Users } from 'lucide-react';
import { useParams } from 'react-router-dom';
import { Avatar, Button, Empty, PageSpinner, TopBar, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { CrawlRow } from './MyCrawls';

/** Someone's public side: follow them, see public crawls they're going to. */
export function UserProfile() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const profile = useQuery({ queryKey: ['profile', id], queryFn: () => api.profile(id!) });
  const toggle = useMutation({
    mutationFn: () => (profile.data!.isFollowing ? api.unfollow(id!) : api.follow(id!)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile', id] });
      qc.invalidateQueries({ queryKey: ['friends-crawls'] });
      qc.invalidateQueries({ queryKey: ['follows'] });
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  if (profile.isLoading) return <PageSpinner />;
  const p = profile.data;
  if (!p) return <Empty icon={<Users className="size-6" />} title="Person not found" />;
  return (
    <div className="min-h-full pb-12">
      <TopBar title="" />
      <div className="px-4 pt-2">
        <div className="flex items-center gap-4">
          <Avatar user={p.user} size={72} />
          <div className="min-w-0 flex-1">
            <h1 className="truncate font-display text-[28px] font-bold leading-tight">{p.user.displayName}</h1>
            <p className="text-[14px] text-dim tabular">
              {p.followers} follower{p.followers === 1 ? '' : 's'} · {p.following} following
              {p.crawlsTogether && !p.isMe ? ` · ${p.crawlsTogether} crawl${p.crawlsTogether === 1 ? '' : 's'} together` : ''}
            </p>
          </div>
        </div>
        {!p.isMe ? (
          <Button className="mt-5 w-full" variant={p.isFollowing ? 'secondary' : 'primary'} loading={toggle.isPending} onClick={() => toggle.mutate()}>
            {p.isFollowing ? (
              <>
                <UserCheck className="size-4" /> Following
              </>
            ) : (
              <>
                <UserPlus className="size-4" /> Follow
              </>
            )}
          </Button>
        ) : null}
        <section className="mt-8">
          <h2 className="font-display text-[22px] font-semibold">Going to</h2>
          {p.activityHidden ? (
            <p className="mt-3 flex items-center gap-2 text-[14px] text-dim">
              <EyeOff className="size-4" /> {p.user.displayName.split(' ')[0]} keeps their crawls private.
            </p>
          ) : p.upcoming.length ? (
            <div className="mt-3 space-y-3">
              {p.upcoming.map((c) => (
                <CrawlRow key={c.id} crawl={c} />
              ))}
            </div>
          ) : (
            <p className="mt-3 text-[14px] text-dim">No upcoming public crawls.</p>
          )}
          <p className="mt-3 text-[12px] text-faint">Only public crawls show here. Private crawls are never shared.</p>
        </section>
      </div>
    </div>
  );
}
