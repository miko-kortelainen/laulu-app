import { AuthGate } from "@/features/auth/AuthGate";
import { PricingPage } from "@/features/pricing/PricingPage";
import { Navigate, useMatch } from "react-router";
import { usePaidTiersEnabled } from "@/lib/feature-flags";
import { AuthenticatedApp } from "./AuthenticatedApp";

export default function App() {
  const pricingRoute = useMatch("/pricing");
  const paidTiersEnabled = usePaidTiersEnabled();
  const publicPricing = paidTiersEnabled === undefined
    ? <main className="flex min-h-dvh items-center justify-center"><p role="status">loading plans...</p></main>
    : paidTiersEnabled ? <PricingPage /> : <Navigate to="/login" replace />;
  return <AuthGate publicPage={pricingRoute ? publicPricing : undefined}>{({ user, logout, busy, error }) => (
    <AuthenticatedApp key={user.id} user={user} onLogout={logout} signingOut={busy} authError={error} />
  )}</AuthGate>;
}
