import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { apiFetch, apiOrigin } from '../api/transport';
import { isNative, NativeAuth } from '../platform/native';
import { App as NativeApp } from '@capacitor/app';
import { useI18n } from '../i18n/context';
import { discardAnswers, getOutboxState, resumeAnswers, waitForAnswers } from '../utils/answerOutbox';

export interface AuthUser { email: string; name?: string; picture?: string }
export type AuthStatus = 'loading' | 'authed' | 'anon' | 'unavailable';
interface AuthContextValue {
  status: AuthStatus; user: AuthUser | null; authEnabled: boolean; error: string | null;
  login: () => void; logout: () => Promise<void>; retry: () => void; resumeEpoch: number;
}
interface MeResponse { authEnabled: boolean; authenticated: boolean; user: AuthUser | null }
const AuthContext = createContext<AuthContextValue | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumeEpoch, setResumeEpoch] = useState(0);
  const lastIdentity = useRef<string | null>(null);
  const busy = useRef(false); const loginBusy = useRef(false);
  const mounted = useRef(false);
  const refresh = useCallback(async (foreground = false) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const response = await apiFetch('/api/auth/me', { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('Authentication unavailable');
      const data = await response.json() as MeResponse;
      if (!mounted.current) return;
      const email = data.user?.email?.toLowerCase() ?? null;
      if (data.authenticated && getOutboxState().pending && lastIdentity.current && lastIdentity.current !== email) {
        setError('account'); setStatus('anon'); return;
      }
      setAuthEnabled(data.authEnabled); setUser(data.user); setError(null);
      setStatus(data.authenticated ? 'authed' : 'anon');
      if (data.authenticated) {
        lastIdentity.current = email;
        resumeAnswers();
        if (foreground && await waitForAnswers(15_000) === 'synced' && mounted.current) setResumeEpoch(v => v + 1);
      }
    } catch { if (mounted.current) { setError('network'); setStatus('unavailable'); } }
    finally { busy.current = false; }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    return () => { mounted.current = false; };
  }, [refresh]);
  useEffect(() => {
    const expired = () => { setAuthEnabled(true); setUser(null); setStatus('anon'); };
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
  }, []);
  useEffect(() => {
    if (!isNative()) return;
    let active = true;
    const listener = NativeApp.addListener('appStateChange', ({ isActive }) => {
      if (active && isActive && !loginBusy.current) void refresh(true);
    });
    return () => { active = false; void listener.then(handle => handle.remove()); };
  }, [refresh]);
  const login = useCallback(() => {
    if (!isNative()) { window.location.href = '/api/auth/login'; return; }
    if (loginBusy.current) return;
    loginBusy.current = true; setError(null);
    void NativeAuth.login({ apiOrigin: apiOrigin() }).then(() => refresh(true))
      .catch(() => { if (mounted.current) setError('login'); })
      .finally(() => { loginBusy.current = false; });
  }, [refresh]);
  const logout = useCallback(async () => {
    if (getOutboxState().pending && !window.confirm(t('discardPendingLogout'))) return;
    if (getOutboxState().pending) {
      try { discardAnswers(); } catch { window.alert(t('syncLogoutWait')); return; }
    }
    let confirmed = false;
    try { confirmed = (await apiFetch(isNative() ? '/api/auth/mobile/logout' : '/api/auth/logout', { method: 'POST', signal: AbortSignal.timeout(15_000) })).ok; }
    catch { /* Local logout is still possible; the UI reports unconfirmed server revocation. */ }
    if (isNative()) await NativeAuth.clear({ apiOrigin: apiOrigin() });
    lastIdentity.current = null; setUser(null); setStatus('anon'); setError(confirmed ? null : 'logout');
  }, [t]);
  const value = useMemo<AuthContextValue>(() => ({ status, user, authEnabled, error, login, logout,
    retry: () => { void refresh(true); }, resumeEpoch }), [status, user, authEnabled, error, login, logout, refresh, resumeEpoch]);
  return <AuthContext value={value}>{children}</AuthContext>;
}
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext); if (!value) throw new Error('useAuth must be used within an AuthProvider'); return value;
}
