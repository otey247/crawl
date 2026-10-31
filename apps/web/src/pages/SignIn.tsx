import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Mail } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar, Button, Field, PageSpinner, errorMessage, inputCls } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';

export function SignIn() {
  const [params] = useSearchParams();
  const next = params.get('next') ?? '/';
  const nav = useNavigate();
  const { signIn, me } = useAuth();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const devUsers = useQuery({ queryKey: ['dev-users'], queryFn: api.devUsers });
  const magic = useMutation({ mutationFn: () => api.magicLink(email, name || undefined) });
  const dev = useMutation({
    mutationFn: (userId: string) => api.session({ provider: 'dev', userId }),
    onSuccess: (r) => {
      signIn(r.token, r.user);
      nav(next, { replace: true });
    },
  });

  useEffect(() => {
    if (me) nav(next, { replace: true });
  }, [me, nav, next]);

  return (
    <div className="flex min-h-full flex-col px-6 pb-10 pt-[max(48px,env(safe-area-inset-top))]">
      <Link to="/" className="font-display text-[44px] font-bold leading-none text-amber">
        Crawl
      </Link>
      <h1 className="mt-10 font-display text-[34px] font-semibold leading-[1.1] tracking-tight">Plan the night. Bring the crew.</h1>
      <p className="mt-3 text-[16px] text-dim">Sign in to build crawls, RSVP and share the album.</p>

      {magic.data ? (
        <div className="mt-10 rounded-3xl bg-surface border border-line p-6">
          <Mail className="size-7 text-amber" />
          <p className="mt-4 text-[18px] font-semibold">Check your inbox</p>
          <p className="mt-1 text-[15px] text-dim">We sent a sign-in link to {email}. It expires in 15 minutes.</p>
          {magic.data.devLink ? (
            <a href={magic.data.devLink} className="mt-5 inline-flex items-center gap-2 text-[15px] font-semibold text-amber underline-offset-4 hover:underline">
              Open dev sign-in link <ArrowRight className="size-4" />
            </a>
          ) : null}
        </div>
      ) : (
        <form
          className="mt-10 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            magic.mutate();
          }}
        >
          <Field label="Email">
            <input className={inputCls} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </Field>
          <Field label="Your name" hint="Shown to people on your crawls.">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="First and last" autoComplete="name" />
          </Field>
          {magic.error ? <p className="text-[14px] text-alert">{errorMessage(magic.error)}</p> : null}
          <Button type="submit" size="lg" className="w-full" loading={magic.isPending}>
            Email me a sign-in link
          </Button>
        </form>
      )}

      {devUsers.data?.length ? (
        <section className="mt-12">
          <p className="text-[13px] font-semibold uppercase tracking-wider text-dim">Development · sign in as</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            {devUsers.data.slice(0, 8).map((u) => (
              <button
                key={u.id}
                onClick={() => dev.mutate(u.id)}
                disabled={dev.isPending}
                className="flex items-center gap-3 rounded-2xl bg-surface border border-line p-3 text-left hover:border-line-strong"
              >
                <Avatar user={u} size={32} />
                <span className="truncate text-[14px] font-medium">{u.displayName}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function VerifyMagicLink() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { signIn } = useAuth();
  const token = params.get('token');
  const m = useMutation({
    mutationFn: () => api.session({ provider: 'magic_link', token: token! }),
    onSuccess: (r) => {
      signIn(r.token, r.user);
      nav('/', { replace: true });
    },
  });
  useEffect(() => {
    if (token && m.isIdle) m.mutate();
  }, [token, m]);
  if (m.isError || !token)
    return (
      <div className="px-6 pt-24 text-center">
        <p className="font-display text-2xl font-semibold">That link didn’t work</p>
        <p className="mt-2 text-dim">{m.error ? errorMessage(m.error) : 'Missing token.'}</p>
        <Link to="/signin" className="mt-6 inline-block font-semibold text-amber">
          Try again
        </Link>
      </div>
    );
  return <PageSpinner />;
}
