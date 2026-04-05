import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, getToken, setToken } from './api';

type User = { id: number; username: string; role: string };

type AuthState = {
  user: User | null;
  mustChangePassword: boolean;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshMe: () => Promise<void>;
  setSession: (token: string, user: User, mustChangePassword: boolean) => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [mustChangePassword, setMust] = useState(false);
  const [loading, setLoading] = useState(!!getToken());

  const refreshMe = useCallback(async () => {
    const t = getToken();
    if (!t) {
      setUser(null);
      setMust(false);
      setLoading(false);
      return;
    }
    try {
      const r = await api<{ user: User; mustChangePassword: boolean }>('/api/auth/me');
      setUser(r.user);
      setMust(!!r.mustChangePassword);
    } catch {
      setUser(null);
      setMust(false);
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  useEffect(() => {
    const onLogout = () => {
      setUser(null);
      setMust(false);
    };
    window.addEventListener('auth:logout', onLogout);
    return () => window.removeEventListener('auth:logout', onLogout);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api<{ token: string; user: User; mustChangePassword: boolean }>(
      '/api/auth/login',
      { method: 'POST', json: { username, password } },
    );
    setToken(r.token);
    setUser(r.user);
    setMust(!!r.mustChangePassword);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    setMust(false);
  }, []);

  const setSession = useCallback((token: string, u: User, m: boolean) => {
    setToken(token);
    setUser(u);
    setMust(m);
  }, []);

  const value = useMemo(
    () => ({
      user,
      mustChangePassword,
      loading,
      login,
      logout,
      refreshMe,
      setSession,
    }),
    [user, mustChangePassword, loading, login, logout, refreshMe, setSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
