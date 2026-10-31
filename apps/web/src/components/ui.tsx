import { ChevronLeft, Loader2, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UserDTO } from '@crawl/core';
import { initials } from '../lib/format';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary: 'bg-amber text-amber-ink hover:bg-amber-hi shadow-float',
  secondary: 'bg-raised text-fg border border-line-strong hover:bg-[#25252a]',
  ghost: 'text-fg hover:bg-raised',
  danger: 'bg-alert text-white hover:brightness-110',
};
const sizes: Record<Size, string> = {
  sm: 'h-9 px-3.5 text-sm gap-1.5',
  md: 'h-11 px-5 text-[15px] gap-2',
  lg: 'h-14 px-6 text-[17px] gap-2.5',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center rounded-full font-semibold transition active:scale-[0.98] disabled:opacity-45 disabled:pointer-events-none ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

export function IconButton({ className = '', label, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={`inline-flex size-11 items-center justify-center rounded-full bg-raised text-fg border border-line hover:bg-[#25252a] active:scale-95 transition disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

/** Filter / toggle chip. Active = solid amber; inactive = neutral surface. */
export function Chip({ active, icon, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; icon?: ReactNode }) {
  return (
    <button
      {...rest}
      aria-pressed={active}
      className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-medium transition active:scale-[0.97] ${
        active ? 'bg-amber text-amber-ink' : 'bg-surface text-fg border border-line hover:border-line-strong'
      } ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

/** Static tag. Neutral surface with optional amber icon — no tinted fills. */
export function Tag({ icon, children, strong }: { icon?: ReactNode; children: ReactNode; strong?: boolean }) {
  return (
    <span className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ${strong ? 'bg-amber text-amber-ink' : 'bg-raised text-fg border border-line'}`}>
      {icon}
      {children}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" className="grid gap-1 rounded-full bg-surface border border-line p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`inline-flex items-center justify-center gap-1.5 rounded-full font-semibold transition ${size === 'sm' ? 'h-8 text-[13px]' : 'h-10 text-[14px]'} ${
            value === o.value ? 'bg-fg text-ink' : 'text-dim hover:text-fg'
          }`}
        >
          {o.icon}
          <span className="truncate">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Avatar({ user, size = 36, ring }: { user: Pick<UserDTO, 'displayName' | 'avatarUrl'>; size?: number; ring?: boolean }) {
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.34) };
  const cls = `inline-flex shrink-0 items-center justify-center rounded-full font-semibold overflow-hidden ${ring ? 'ring-2 ring-ink' : ''}`;
  if (user.avatarUrl) return <img src={user.avatarUrl} alt="" className={cls} style={style} />;
  // Deterministic neutral tone per name keeps the roster readable without a rainbow.
  const tones = ['#3a3530', '#2f3438', '#38302f', '#30362f', '#35303a', '#3a3a3a'];
  const tone = tones[[...user.displayName].reduce((a, ch) => a + ch.charCodeAt(0), 0) % tones.length];
  return (
    <span className={`${cls} text-fg`} style={{ ...style, background: tone }} aria-hidden>
      {initials(user.displayName)}
    </span>
  );
}

export function AvatarStack({ users, extra, size = 40 }: { users: UserDTO[]; extra?: number; size?: number }) {
  return (
    <div className="flex items-center">
      {users.map((u, i) => (
        <span key={u.id} style={{ marginLeft: i ? -size * 0.2 : 0 }}>
          <Avatar user={u} size={size} ring />
        </span>
      ))}
      {extra && extra > 0 ? (
        <span
          className="inline-flex items-center justify-center rounded-full bg-raised border border-line-strong text-[13px] font-semibold ring-2 ring-ink"
          style={{ width: size, height: size, marginLeft: -size * 0.2 }}
        >
          +{extra}
        </span>
      ) : null}
    </div>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return <Loader2 className={`size-5 animate-spin text-dim ${className}`} aria-label="Loading" />;
}

export function PageSpinner() {
  return (
    <div className="flex h-full min-h-[50vh] items-center justify-center">
      <Spinner className="size-7" />
    </div>
  );
}

export function Empty({ icon, title, body, action }: { icon: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-8 py-14 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-raised text-amber border border-line">{icon}</div>
      <p className="font-display text-xl font-semibold">{title}</p>
      {body ? <p className="mt-2 max-w-xs text-[15px] text-dim">{body}</p> : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function TopBar({ title, back = true, right, transparent }: { title?: ReactNode; back?: boolean | string; right?: ReactNode; transparent?: boolean }) {
  const nav = useNavigate();
  return (
    <header className={`sticky top-0 z-30 flex h-16 items-center gap-3 px-4 ${transparent ? '' : 'bg-ink/90 backdrop-blur border-b border-line'}`} style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      {back ? (
        <IconButton label="Back" onClick={() => (typeof back === 'string' ? nav(back) : window.history.length > 1 ? nav(-1) : nav('/'))}>
          <ChevronLeft className="size-5" />
        </IconButton>
      ) : null}
      <div className="min-w-0 flex-1 truncate text-[17px] font-semibold">{title}</div>
      {right}
    </header>
  );
}

export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal>
      <button aria-label="Close" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="sheet-in relative max-h-[88vh] w-full max-w-[520px] overflow-y-auto rounded-t-[28px] bg-surface border-t border-line pb-[max(20px,env(safe-area-inset-bottom))]">
        <div className="sticky top-0 z-10 flex items-center justify-between bg-surface px-5 pb-2 pt-3">
          <div className="absolute left-1/2 top-2 h-1 w-10 -translate-x-1/2 rounded-full bg-line-strong" />
          <div className="pt-3 font-display text-[22px] font-semibold">{title}</div>
          <IconButton label="Close" onClick={onClose} className="mt-2 size-9">
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="px-5 pb-2">{children}</div>
      </div>
    </div>
  );
}

export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between">
      <h2 className="font-display text-[22px] font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[13px] font-semibold uppercase tracking-wider text-dim">{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-[13px] text-faint">{hint}</span> : null}
    </label>
  );
}

export const inputCls =
  'w-full h-12 rounded-2xl bg-raised border border-line px-4 text-[16px] text-fg placeholder:text-faint outline-none focus:border-amber transition';

// ---------------------------------------------------------------------------------------------
// Toasts

interface Toast {
  id: number;
  title: string;
  body?: string;
}
const ToastCtx = createContext<(t: Omit<Toast, 'id'>) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((x) => [...x.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-[60] mx-auto flex max-w-[520px] flex-col gap-2 p-3" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }} aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="sheet-in pointer-events-auto rounded-2xl bg-fg px-4 py-3 text-ink shadow-float">
            <p className="text-[15px] font-semibold">{t.title}</p>
            {t.body ? <p className="mt-0.5 text-[14px] text-[#45423d]">{t.body}</p> : null}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong';
}
