import { createContext, useContext, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export interface AuthUser {
  email: string;
  name?: string;
  picture?: string;
}

export type AuthStatus = "loading" | "authed" | "anon";

interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** False when the backend has no OAuth config — the gate then stays out of the way. */
  authEnabled: boolean;
  login: () => void;
  logout: () => Promise<void>;
}

interface MeResponse {
  authEnabled: boolean;
  authenticated: boolean;
  user: AuthUser | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authEnabled, setAuthEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/auth/me", { credentials: "include" })
      .then((res) => (res.ok ? (res.json() as Promise<MeResponse>) : Promise.reject(res.status)))
      .then((data) => {
        if (cancelled) return;
        setAuthEnabled(data.authEnabled);
        setUser(data.user);
        setStatus(data.authenticated ? "authed" : "anon");
      })
      .catch(() => {
        if (cancelled) return;
        // Deliberately fail OPEN here. This gate is UX, not security — the backend
        // hook is what actually protects the API, and a client that wrongly lets
        // you through just gets 401s on every call. Failing closed instead would
        // show a login wall on an unreachable/older backend that has no /me route.
        setAuthEnabled(false);
        setUser(null);
        setStatus("authed");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // client.ts fires this when any API call comes back 401, so a session that
  // expires mid-use returns to the login screen instead of silently emptying lists.
  useEffect(() => {
    const onExpired = () => {
      setAuthEnabled(true);
      setUser(null);
      setStatus("anon");
    };
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, []);

  const login = useCallback(() => {
    window.location.href = "/api/auth/login";
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    } catch {
      // Clearing local state matters more than the round-trip succeeding.
    }
    setUser(null);
    setStatus("anon");
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, authEnabled, login, logout }),
    [status, user, authEnabled, login, logout],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
