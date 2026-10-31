import { BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, useToast } from '../components/ui';
import { enablePush, pushState, type PushState } from '../lib/push';

const DISMISS_KEY = 'crawl.pushPromptDismissed';

/** Ask for notification permission in context (on a crawl the person is part of), not on launch. */
export function PushPrompt() {
  const toast = useToast();
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    pushState().then(setState).catch(() => setState('unsupported'));
  }, []);
  if (dismissed || state !== 'off') return null;
  return (
    <section className="flex items-center gap-3 rounded-3xl border border-line bg-surface p-4">
      <BellRing className="size-6 shrink-0 text-amber" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold">Get crawl alerts</p>
        <p className="text-[13px] text-dim">Start reminders, when the group moves, specials you’re about to miss.</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Button
          size="sm"
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const s = await enablePush();
              setState(s);
              if (s === 'on') toast({ title: 'Alerts on' });
              if (s === 'denied') toast({ title: 'Notifications are blocked', body: 'Allow them for Crawl in your browser settings.' });
            } catch {
              toast({ title: 'Couldn’t turn on alerts' });
            } finally {
              setBusy(false);
            }
          }}
        >
          Turn on
        </Button>
        <button
          className="text-[12px] text-dim"
          onClick={() => {
            setDismissed(true);
            try {
              localStorage.setItem(DISMISS_KEY, '1');
            } catch {
              /* ignore */
            }
          }}
        >
          Not now
        </button>
      </div>
    </section>
  );
}
