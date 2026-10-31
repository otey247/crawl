import { useMutation } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button, errorMessage } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export function AgeGate() {
  const { refresh, signOut } = useAuth();
  const [checked, setChecked] = useState(false);
  const m = useMutation({ mutationFn: api.verifyAge, onSuccess: () => refresh() });
  return (
    <div className="flex min-h-full flex-col justify-center px-6 py-16">
      <ShieldCheck className="size-10 text-amber" />
      <h1 className="mt-6 font-display text-[32px] font-semibold leading-tight">Are you 21 or older?</h1>
      <p className="mt-3 text-[16px] text-dim">Crawl is for adults of legal drinking age in the US. Please drink responsibly and plan your ride home.</p>
      <label className="mt-8 flex items-start gap-3 rounded-2xl bg-surface border border-line p-4">
        <input type="checkbox" className="mt-1 size-5 accent-[#f6b73c]" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
        <span className="text-[15px]">I confirm I am 21 or older.</span>
      </label>
      {m.error ? <p className="mt-3 text-[14px] text-alert">{errorMessage(m.error)}</p> : null}
      <Button size="lg" className="mt-6 w-full" disabled={!checked} loading={m.isPending} onClick={() => m.mutate()}>
        Continue
      </Button>
      <button className="mt-4 text-[15px] text-dim" onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}
