import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { MeDTO } from '@crawl/core';
import { api, tokenStore } from './api';
import { resetSocket } from './socket';

interface AuthState {
  me: MeDTO | null;
  loading: boolean;
  signIn: (token: string, me: MeDTO) => void;
  signOut: () => void;
  refresh: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [token, setToken] = useState(() => tokenStore.get());
  const meQuery = useQuery({ queryKey: ['me', token], queryFn: api.me, enabled: !!token, retry: false, staleTime: 60_000 });

  const signIn = useCallback(
    (t: string, me: MeDTO) => {
      tokenStore.set(t);
      resetSocket();
      qc.clear();
      qc.setQueryData(['me', t], me);
      setToken(t);
    },
    [qc],
  );
  const signOut = useCallback(() => {
    tokenStore.set(null);
    resetSocket();
    qc.clear();
    setToken(null);
  }, [qc]);

  const value = useMemo<AuthState>(
    () => ({
      me: token && !meQuery.isError ? (meQuery.data ?? null) : null,
      loading: !!token && meQuery.isLoading,
      signIn,
      signOut,
      refresh: () => meQuery.refetch(),
    }),
    [token, meQuery.data, meQuery.isLoading, meQuery.isError, signIn, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside provider');
  return ctx;
}
