import { useMutation, useQuery } from '@tanstack/react-query';
import { Bell, Check, LogOut, MapPinned, Pencil } from 'lucide-react';
import { DateTime } from 'luxon';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CategoryIcon } from '../components/domain';
import { Avatar, Button, Empty, Spinner, inputCls } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push';

export function Profile() {
  const { me, signOut, refresh } = useAuth();
  const history = useQuery({ queryKey: ['history'], queryFn: api.history });
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me?.displayName ?? '');
  const save = useMutation({ mutationFn: () => api.updateMe(name), onSuccess: () => (refresh(), setEditing(false)) });
  if (!me) return null;
  const h = history.data;

  return (
    <div className="px-4" style={{ paddingTop: 'max(20px, env(safe-area-inset-top))' }}>
      <div className="flex items-center gap-4">
        <Avatar user={me} size={64} />
        <div className="min-w-0 flex-1">
          {editing ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <input className={`${inputCls} h-11`} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={60} />
              <Button size="sm" className="h-11" loading={save.isPending}>
                Save
              </Button>
            </form>
          ) : (
            <>
              <h1 className="truncate font-display text-[28px] font-bold leading-tight">{me.displayName}</h1>
              <p className="truncate text-[14px] text-dim">{me.email}</p>
            </>
          )}
        </div>
        {!editing ? (
          <button aria-label="Edit name" className="flex size-10 items-center justify-center rounded-full border border-line" onClick={() => (setName(me.displayName), setEditing(true))}>
            <Pencil className="size-4" />
          </button>
        ) : null}
      </div>

      <div className="mt-6 grid grid-cols-3 gap-2 text-center">
        {[
          ['Check-ins', h?.totalVenues ?? 0],
          ['Bars', h?.uniqueVenues ?? 0],
          ['Crawls', h?.crawls.length ?? 0],
        ].map(([label, n]) => (
          <div key={label} className="rounded-2xl border border-line bg-surface py-4">
            <p className="font-display text-[28px] font-bold tabular">{n}</p>
            <p className="text-[12px] font-semibold uppercase tracking-wider text-dim">{label}</p>
          </div>
        ))}
      </div>

      <section className="mt-8" aria-label="Visited history">
        <h2 className="font-display text-[24px] font-semibold">Visited History</h2>
        <p className="mt-1 text-[14px] text-dim">Bars you checked into, saved when each crawl ends.</p>
        {history.isLoading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : !h?.crawls.length ? (
          <Empty icon={<MapPinned className="size-6" />} title="No completed crawls yet" body="Check in at each stop during a live crawl. They’ll show up here once it wraps." />
        ) : (
          <div className="mt-4 space-y-5">
            {h.crawls.map((c) => (
              <article key={c.crawl.id} className="rounded-3xl border border-line bg-surface p-4">
                <Link to={`/crawls/${c.crawl.id}`} className="block">
                  <p className="text-[12px] font-semibold uppercase tracking-wider text-dim">{DateTime.fromISO(c.crawl.startAt, { zone: c.crawl.timezone }).toFormat('cccc, LLL d, yyyy')}</p>
                  <p className="font-display text-[20px] font-semibold">{c.crawl.title}</p>
                </Link>
                <ol className="mt-3 space-y-2">
                  {c.venues.map((v) => (
                    <li key={v.stopId} className="flex items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-fg text-ink">
                        <Check className="size-4" strokeWidth={3} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5 truncate text-[15px] font-semibold">
                          <CategoryIcon category={v.category} className="size-4 text-amber" /> {v.name}
                        </span>
                        <span className="block truncate text-[13px] text-dim">{v.address ?? ''}</span>
                      </span>
                      <span className="shrink-0 text-[13px] text-dim tabular">{DateTime.fromISO(v.checkedInAt, { zone: c.crawl.timezone }).toFormat('h:mm a')}</span>
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        )}
      </section>

      <NotificationsSetting />

      <section className="mt-6 space-y-2 border-t border-line pt-6 pb-4">
        <p className="text-[13px] text-dim">Drink responsibly. Plan your ride home, and use the Designated Driver role to keep track of who’s driving.</p>
        <Button variant="secondary" className="mt-3 w-full" onClick={signOut}>
          <LogOut className="size-4" /> Sign out
        </Button>
      </section>
    </div>
  );
}

function NotificationsSetting() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    pushState().then(setState).catch(() => setState('unsupported'));
  }, []);
  const sub =
    state === 'on'
      ? 'Reminders, live alerts and home-safe check-ins on this device.'
      : state === 'denied'
        ? 'Blocked in your browser settings. Allow notifications for Crawl to turn them on.'
        : state === 'unsupported'
          ? 'This browser doesn’t support push. On iPhone, add Crawl to your Home Screen first.'
          : 'Get start reminders, “group is leaving” and specials alerts.';
  return (
    <section className="mt-10 flex items-center gap-3 border-t border-line pt-6">
      <Bell className="size-6 shrink-0 text-amber" />
      <div className="min-w-0 flex-1">
        <p className="text-[16px] font-semibold">Notifications</p>
        <p className="text-[13px] text-dim">{sub}</p>
      </div>
      {state === 'on' || state === 'off' ? (
        <Button
          size="sm"
          variant={state === 'on' ? 'secondary' : 'primary'}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (state === 'on') {
                await disablePush();
                setState('off');
              } else setState(await enablePush());
            } finally {
              setBusy(false);
            }
          }}
        >
          {state === 'on' ? 'Turn off' : 'Turn on'}
        </Button>
      ) : null}
    </section>
  );
}
