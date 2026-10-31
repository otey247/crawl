import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, MessageCircle } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useRef, useState } from 'react';
import type { CrawlDetailDTO, MessageDTO } from '@crawl/core';
import { CrewBadge } from '../components/domain';
import { Avatar, Empty, Spinner, errorMessage, useToast } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { enqueue, isNetworkError, useOutbox, type OutboxItem } from '../lib/outbox';
import { getSocket } from '../lib/socket';

type Page = { items: MessageDTO[]; hasMore: boolean };

/** Group chat for a crawl. Realtime via the crawl channel; HTTP fallback when the socket is down. */
export function Chat({ crawl }: { crawl: CrawlDetailDTO }) {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['messages', crawl.id];
  const messages = useQuery({ queryKey: key, queryFn: () => api.messages(crawl.id), refetchInterval: 30_000 });
  const [text, setText] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  const crew = new Map(crawl.members.map((m) => [m.user.id, m.crewRole]));

  const send = useMutation({
    mutationFn: (body: string) =>
      new Promise<MessageDTO>((resolve, reject) => {
        const s = getSocket();
        if (s?.connected) {
          s.timeout(5000).emit('chat.send', { crawlId: crawl.id, body }, (err: Error | null, res: { ok: boolean; message?: MessageDTO; error?: string }) => {
            if (err) api.sendMessage(crawl.id, body).then(resolve, reject);
            else if (res.ok && res.message) resolve(res.message);
            else reject(new Error(res.error ?? 'Not sent'));
          });
        } else api.sendMessage(crawl.id, body).then(resolve, reject);
      }),
    onSuccess: (m) => qc.setQueryData<Page>(key, (old) => (old ? (old.items.some((x) => x.id === m.id) ? old : { ...old, items: [...old.items, m] }) : old)),
    onError: (e, body) => {
      if (isNetworkError(e)) {
        enqueue({ kind: 'chat', crawlId: crawl.id, body });
        return;
      }
      setText(body);
      toast({ title: 'Message not sent', body: errorMessage(e) });
    },
  });

  const loadOlder = useMutation({
    mutationFn: () => api.messages(crawl.id, messages.data?.items[0]?.createdAt),
    onSuccess: (older) => qc.setQueryData<Page>(key, (old) => (old ? { items: [...older.items, ...old.items], hasMore: older.hasMore } : old)),
  });

  const count = messages.data?.items.length ?? 0;
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  const items = messages.data?.items ?? [];
  const pending = useOutbox().filter((o): o is Extract<OutboxItem, { kind: 'chat' }> => o.kind === 'chat' && o.crawlId === crawl.id);
  return (
    <div className="flex flex-col">
      {messages.isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <Empty icon={<MessageCircle className="size-6" />} title="Say hi to the crew" body="Coordinate meetups, rides and who’s holding the table." />
      ) : (
        <div className="space-y-1 pb-4">
          {messages.data?.hasMore ? (
            <button className="mx-auto mb-2 block text-[13px] font-semibold text-dim" onClick={() => loadOlder.mutate()}>
              {loadOlder.isPending ? 'Loading…' : 'Load earlier messages'}
            </button>
          ) : null}
          {items.map((m, i) => {
            if (m.kind === 'system')
              return (
                <p key={m.id} className="py-2 text-center text-[13px] text-dim">
                  {m.body}
                </p>
              );
            const mine = m.user?.id === me?.id;
            const prev = items[i - 1];
            const grouped = prev && prev.kind === 'text' && prev.user?.id === m.user?.id && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < 5 * 60_000;
            const role = m.user ? crew.get(m.user.id) : null;
            return (
              <div key={m.id} className={`flex items-end gap-2 ${mine ? 'flex-row-reverse' : ''} ${grouped ? '' : 'pt-2'}`}>
                <span className="w-8 shrink-0">{!mine && !grouped && m.user ? <Avatar user={m.user} size={32} /> : null}</span>
                <div className={`max-w-[78%] ${mine ? 'items-end' : 'items-start'} flex flex-col`}>
                  {!mine && !grouped ? (
                    <p className="mb-1 flex items-center gap-1.5 px-1 text-[12px] font-semibold text-dim">
                      {m.user?.displayName}
                      {role ? <CrewBadge role={role} /> : null}
                    </p>
                  ) : null}
                  <div className={`rounded-[20px] px-4 py-2.5 text-[15px] leading-snug ${mine ? 'bg-amber text-amber-ink' : 'bg-raised text-fg'}`}>{m.body}</div>
                  {!grouped || i === items.length - 1 ? <p className="mt-0.5 px-1 text-[11px] text-faint">{DateTime.fromISO(m.createdAt).toFormat('h:mm a')}</p> : null}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {pending.map((p) => (
        <div key={p.id} className="flex flex-row-reverse items-end gap-2 pt-1">
          <span className="w-8 shrink-0" />
          <div className="flex max-w-[78%] flex-col items-end">
            <div className="rounded-[20px] border border-dashed border-amber px-4 py-2.5 text-[15px] leading-snug text-fg">{p.body}</div>
            <p className="mt-0.5 px-1 text-[11px] text-faint">Waiting for signal</p>
          </div>
        </div>
      ))}
      <div ref={bottom} />
      <form
        className="sticky bottom-0 -mx-4 flex items-center gap-2 border-t border-line bg-ink px-4 py-3"
        style={{ paddingBottom: 'max(12px, env(safe-area-inset-bottom))' }}
        onSubmit={(e) => {
          e.preventDefault();
          const body = text.trim();
          if (!body) return;
          setText('');
          if (!navigator.onLine) enqueue({ kind: 'chat', crawlId: crawl.id, body });
          else send.mutate(body);
        }}
      >
        <input
          aria-label="Message"
          className="h-12 min-w-0 flex-1 rounded-full border border-line bg-raised px-5 text-[16px] outline-none placeholder:text-faint focus:border-amber"
          placeholder="Message the crawl"
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button aria-label="Send" disabled={!text.trim()} className="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber text-amber-ink disabled:opacity-40">
          <ArrowUp className="size-5" strokeWidth={2.5} />
        </button>
      </form>
    </div>
  );
}
