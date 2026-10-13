import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { Navigate, useLocation, useMatch } from "react-router";
import { AuthPage } from "./AuthPage";
import { PrivacyPage } from "./PrivacyPage";
import { TermsGate } from "./TermsGate";
import { TermsPage } from "./TermsPage";
import { useAuth } from "./useAuth";

interface AuthGateProps {
  publicPage?: ReactNode;
  children: (props: { user: User; logout: () => Promise<void>; busy: boolean; error?: string }) => ReactNode;
}

export function AuthGate({ children, publicPage }: AuthGateProps) {
  const auth = useAuth();
  const location = useLocation();
  const loginRoute = useMatch("/login");
  const createAccountRoute = useMatch("/create-account");
  const privacyRoute = useMatch("/privacy");
  const termsRoute = useMatch("/terms");
  if (privacyRoute && (!auth.session || auth.view === "update")) return <PrivacyPage />;
  if (termsRoute && (!auth.session || auth.view === "update")) return <TermsPage />;
  if (publicPage && !auth.loading && (!auth.session || auth.view === "update")) return publicPage;
  if (auth.loading) return <main className="flex min-h-dvh items-center justify-center"><p role="status">restoring your session...</p></main>;
  if (auth.view === "update") return <AuthPage {...auth} />;
  if (!auth.session) {
    if (!loginRoute && !createAccountRoute) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
    return <AuthPage {...auth} />;
  }
  if (createAccountRoute) return <Navigate to="/" replace />;
  if (loginRoute) {
    const state = location.state as { from?: unknown } | null;
    const from = typeof state?.from === "string" && state.from.startsWith("/") && !state.from.startsWith("//") ? state.from : "/";
    return <Navigate to={from} replace />;
  }
  return (
    <TermsGate userId={auth.session.user.id} logout={auth.logout} logoutBusy={auth.busy} logoutError={auth.error}>
      {children({ user: auth.session.user, logout: auth.logout, busy: auth.busy, error: auth.error })}
    </TermsGate>
  );
}
