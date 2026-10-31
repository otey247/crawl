import { CloudOff } from 'lucide-react';
import { useOutbox } from '../lib/outbox';
import { useOnline } from '../lib/offline';

export function OfflineBanner() {
  const online = useOnline();
  const pending = useOutbox().length;
  if (online && !pending) return null;
  return (
    <div role="status" className="sticky top-0 z-[45] flex items-center gap-2 bg-fg px-4 py-2 text-[13px] font-semibold text-ink" style={{ paddingTop: 'max(8px, env(safe-area-inset-top))' }}>
      <CloudOff className="size-4 shrink-0" />
      {online ? `Syncing ${pending} saved ${pending === 1 ? 'change' : 'changes'}…` : `You’re offline. Showing your saved crawl${pending ? ` · ${pending} change${pending === 1 ? '' : 's'} will send when you reconnect` : ''}.`}
    </div>
  );
}
