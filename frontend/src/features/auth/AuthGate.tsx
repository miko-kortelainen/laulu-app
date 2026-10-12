import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { Navigate, useLocation, useMatch } from "react-router";
import { AuthPage } from "./AuthPage";
import { PrivacyPage } from "./PrivacyPage";
import { useAuth } from "./useAuth";

interface AuthGateProps {
  children: (props: { user: User; logout: () => Promise<void>; busy: boolean; error?: string }) => ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const auth = useAuth();
  const location = useLocation();
  const loginRoute = useMatch("/login");
  const createAccountRoute = useMatch("/create-account");
  const privacyRoute = useMatch("/privacy");
  if (privacyRoute && (!auth.session || auth.view === "update")) return <PrivacyPage />;
  if (auth.loading) return <main className="flex min-h-dvh items-center justify-center"><p role="status">restoring your session...</p></main>;
  if (auth.view === "update") return <AuthPage {...auth} />;
  if (!auth.session) {
    if (!loginRoute && !createAccountRoute) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
    return <AuthPage {...auth} />;
  }
  if (loginRoute || createAccountRoute) {
    const state = location.state as { from?: unknown } | null;
    const from = typeof state?.from === "string" && state.from.startsWith("/") && !state.from.startsWith("//") ? state.from : "/";
    return <Navigate to={from} replace />;
  }
  return children({ user: auth.session.user, logout: auth.logout, busy: auth.busy, error: auth.error });
}
