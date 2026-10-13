import { AuthGate } from "@/features/auth/AuthGate";
import { PricingPage } from "@/features/pricing/PricingPage";
import { useMatch } from "react-router";
import { AuthenticatedApp } from "./AuthenticatedApp";

export default function App() {
  const pricingRoute = useMatch("/pricing");
  return <AuthGate publicPage={pricingRoute ? <PricingPage /> : undefined}>{({ user, logout, busy, error }) => (
    <AuthenticatedApp key={user.id} user={user} onLogout={logout} signingOut={busy} authError={error} />
  )}</AuthGate>;
}
