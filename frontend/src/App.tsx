import { ChatPage } from "@/features/chat/ChatPage";
import { AuthGate } from "@/features/auth/AuthGate";

export default function App() {
  return <AuthGate>{({ user, logout, busy, error }) => (
    <ChatPage key={user.id} email={user.email} onLogout={logout} signingOut={busy} authError={error} />
  )}</AuthGate>;
}
