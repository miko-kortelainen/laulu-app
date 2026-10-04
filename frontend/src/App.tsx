import { AuthGate } from "@/features/auth/AuthGate";
import { AuthenticatedApp } from "./AuthenticatedApp";

export default function App() {
  return <AuthGate>{({ user, logout, busy, error }) => (
    <AuthenticatedApp key={user.id} user={user} onLogout={logout} signingOut={busy} authError={error} />
  )}</AuthGate>;
}
