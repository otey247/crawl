import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Avatar, Button, Segmented, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Profile section: follow counts, people you've crawled with, and who sees your activity. */
export function FriendsSection() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const follows = useQuery({ queryKey: ['follows'], queryFn: api.myFollows });
  const suggestions = useQuery({ queryKey: ['follow-suggestions'], queryFn: api.followSuggestions });
  const follow = useMutation({
    mutationFn: api.follow,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['follows'] });
      qc.invalidateQueries({ queryKey: ['follow-suggestions'] });
      qc.invalidateQueries({ queryKey: ['friends-crawls'] });
    },
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  const visibility = useMutation({
    mutationFn: (v: 'followers' | 'nobody') => api.updateMe({ activityVisibility: v }),
    onSuccess: () => refresh(),
    onError: (e) => toast({ title: errorMessage(e) }),
  });
  if (!me) return null;
  const f = follows.data;
  return (
    <section className="mt-10 border-t border-line pt-6" aria-label="Friends">
      <h2 className="font-display text-[24px] font-semibold">Friends</h2>
      <p className="mt-1 text-[14px] text-dim tabular">
        {f?.following.length ?? 0} following · {f?.followers.length ?? 0} followers
      </p>
      {f?.following.length ? (
        <div className="no-scrollbar -mx-4 mt-3 flex gap-3 overflow-x-auto px-4">
          {f.following.map((u) => (
            <Link key={u.id} to={`/u/${u.id}`} className="flex w-16 shrink-0 flex-col items-center gap-1">
              <Avatar user={u} size={52} />
              <span className="w-full truncate text-center text-[12px]">{u.displayName.split(' ')[0]}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {suggestions.data?.length ? (
        <div className="mt-5">
          <p className="text-[13px] font-bold uppercase tracking-[0.14em] text-dim">People you’ve crawled with</p>
          <ul className="mt-2 space-y-1">
            {suggestions.data.slice(0, 5).map((u) => (
              <li key={u.id} className="flex items-center gap-3 py-1.5">
                <Link to={`/u/${u.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <Avatar user={u} size={40} />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold">{u.displayName}</span>
                    <span className="block text-[13px] text-dim">
                      {u.crawlsTogether} crawl{u.crawlsTogether === 1 ? '' : 's'} together
                    </span>
                  </span>
                </Link>
                <Button size="sm" variant="secondary" loading={follow.isPending && follow.variables === u.id} onClick={() => follow.mutate(u.id)}>
                  <UserPlus className="size-4" /> Follow
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-5">
        <p className="mb-2 text-[13px] font-bold uppercase tracking-[0.14em] text-dim">Who sees the public crawls you join</p>
        <Segmented
          size="sm"
          value={me.activityVisibility}
          onChange={(v) => visibility.mutate(v)}
          options={[
            { value: 'followers', label: 'My followers' },
            { value: 'nobody', label: 'No one' },
          ]}
        />
        <p className="mt-2 text-[12px] text-faint">Private crawls are never shown to followers.</p>
      </div>
    </section>
  );
}
