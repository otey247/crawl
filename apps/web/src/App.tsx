import { useQuery } from '@tanstack/react-query';
import { Bell, Map as MapIcon, Plus, User, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { PageSpinner, useToast } from './components/ui';
import { api } from './lib/api';
import { useAuth } from './lib/auth';
import { useNotificationStream } from './lib/socket';
import { AgeGate } from './pages/AgeGate';
import { CrawlPage } from './pages/CrawlPage';
import { CreateCrawl } from './pages/CreateCrawl';
import { Explore } from './pages/Explore';
import { InviteLanding } from './pages/InviteLanding';
import { Invites } from './pages/Invites';
import { MyCrawls } from './pages/MyCrawls';
import { PlanCrawl } from './pages/PlanCrawl';
import { Profile } from './pages/Profile';
import { SignIn, VerifyMagicLink } from './pages/SignIn';

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <PageSpinner />;
  if (!me) return <Navigate to={`/signin?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (!me.ageVerified) return <AgeGate />;
  return <>{children}</>;
}

function BottomNav() {
  const nav = useNavigate();
  const { me } = useAuth();
  const notifs = useQuery({ queryKey: ['notifications'], queryFn: api.notifications, enabled: !!me, refetchInterval: 60_000 });
  const unread = notifs.data?.unread ?? 0;
  const item = (to: string, label: string, icon: ReactNode, badge?: boolean) => (
    <NavLink to={to} end className={({ isActive }) => `relative flex flex-1 flex-col items-center gap-1 pt-2 text-[12px] font-medium ${isActive ? 'text-amber' : 'text-dim'}`}>
      <span className="relative">
        {icon}
        {badge ? <span className="absolute -right-1 -top-0.5 size-2.5 rounded-full bg-alert ring-2 ring-ink" aria-label="Unread" /> : null}
      </span>
      {label}
    </NavLink>
  );
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-[520px] border-t border-line bg-ink/95 backdrop-blur" style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}>
      <div className="flex h-16 items-start">
        {item('/', 'Explore', <MapIcon className="size-6" />)}
        {item('/my-crawls', 'My Crawls', <Users className="size-6" />)}
        <div className="flex flex-1 justify-center">
          <button aria-label="Create crawl" onClick={() => nav('/crawls/new')} className="-mt-4 flex size-[60px] items-center justify-center rounded-full bg-amber text-amber-ink shadow-float ring-4 ring-ink active:scale-95 transition">
            <Plus className="size-7" strokeWidth={2.5} />
          </button>
        </div>
        {item('/invites', 'Invites', <Bell className="size-6" />, unread > 0)}
        {item('/profile', 'Profile', <User className="size-6" />)}
      </div>
    </nav>
  );
}

function WithNav({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="pb-[92px]">{children}</div>
      <BottomNav />
    </>
  );
}

export function App() {
  const toast = useToast();
  const { me } = useAuth();
  useNotificationStream(me ? (title, body) => toast({ title, body }) : undefined);
  return (
    <div className="mx-auto min-h-full max-w-[520px] bg-ink sm:border-x sm:border-line">
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route path="/auth/verify" element={<VerifyMagicLink />} />
        <Route path="/i/:token" element={<InviteLanding />} />
        <Route path="/" element={<WithNav><Explore /></WithNav>} />
        <Route path="/my-crawls" element={<RequireAuth><WithNav><MyCrawls /></WithNav></RequireAuth>} />
        <Route path="/invites" element={<RequireAuth><WithNav><Invites /></WithNav></RequireAuth>} />
        <Route path="/profile" element={<RequireAuth><WithNav><Profile /></WithNav></RequireAuth>} />
        <Route path="/crawls/new" element={<RequireAuth><CreateCrawl /></RequireAuth>} />
        <Route path="/crawls/:id/plan" element={<RequireAuth><PlanCrawl /></RequireAuth>} />
        <Route path="/crawls/:id" element={<CrawlPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
