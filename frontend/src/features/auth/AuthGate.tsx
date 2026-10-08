import type { ReactNode } from "react";
import type { User } from "@supabase/supabase-js";
import { useMatch } from "react-router";
import { AuthPage } from "./AuthPage";
import { PrivacyPage } from "./PrivacyPage";
import { useAuth } from "./useAuth";

interface AuthGateProps {
  children: (props: { user: User; logout: () => Promise<void>; busy: boolean; error?: string }) => ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const auth = useAuth();
  const privacyRoute = useMatch("/privacy");
  if (privacyRoute && (!auth.session || auth.view === "update")) return <PrivacyPage />;
  if (auth.loading) return <main className="flex min-h-dvh items-center justify-center"><p role="status">restoring your session...</p></main>;
  if (!auth.session || auth.view === "update") return <AuthPage {...auth} />;
  return children({ user: auth.session.user, logout: auth.logout, busy: auth.busy, error: auth.error });
}
