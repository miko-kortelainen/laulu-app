import type { User } from "@supabase/supabase-js";
import { Navigate, NavLink, Route, Routes } from "react-router";
import { ChatPage } from "@/features/chat/ChatPage";
import { useChat } from "@/features/chat/useChat";
import { ProfilePage } from "@/features/profile/ProfilePage";

interface AuthenticatedAppProps {
  user: User;
  onLogout: () => Promise<void>;
  signingOut: boolean;
  authError?: string;
}

const linkClass = "rounded-lg px-3 py-2 text-sm hover:bg-white/10 aria-[current=page]:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400";

export function AuthenticatedApp({ user, onLogout, signingOut, authError }: AuthenticatedAppProps) {
  const chat = useChat();

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-7xl flex-col px-4 py-4 font-sans text-zinc-100 sm:px-6 sm:py-6 lg:h-dvh">
      <header className="flex flex-none flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
        <div className="min-w-0">
          <p className="text-lg font-semibold tracking-tight">Nemotron Copilot</p>
          <p className="text-xs text-zinc-400">Powered by Nebius Token Factory & Strands Agents SDK</p>
        </div>
        <div className="min-w-0">
          <p className="max-w-48 truncate text-xs text-zinc-400 sm:ml-auto sm:text-right">{user.email}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <nav aria-label="main navigation" className="flex gap-1">
              <NavLink to="/" end className={linkClass}>
                chat
              </NavLink>
              <NavLink to="/profile" className={linkClass}>
                profile
              </NavLink>
            </nav>
            <button type="button" disabled={signingOut} onClick={() => void onLogout()}
              className="min-h-10 rounded-lg border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50">
              {signingOut ? "logging out..." : "log out"}
            </button>
          </div>
          {authError && <p role="alert" className="mt-2 text-xs text-red-300">{authError}</p>}
        </div>
      </header>
      <Routes>
        <Route path="/" element={<ChatPage chat={chat} />} />
        <Route path="/profile" element={<ProfilePage user={user} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
