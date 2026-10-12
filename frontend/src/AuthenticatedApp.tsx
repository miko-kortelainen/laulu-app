import type { User } from "@supabase/supabase-js";
import { Navigate, NavLink, Route, Routes } from "react-router";
import { LauluWordmark } from "@/components/ui/LauluWordmark";
import { ChatPage } from "@/features/chat/ChatPage";
import { useChat } from "@/features/chat/useChat";
import { ProfilePage } from "@/features/profile/ProfilePage";
import { SongsPage } from "@/features/songs/SongsPage";
import { PrivacyPage } from "@/features/auth/PrivacyPage";

interface AuthenticatedAppProps {
  user: User;
  onLogout: () => Promise<void>;
  signingOut: boolean;
  authError?: string;
}

const linkClass = "rounded-lg px-3 py-2 text-sm hover:bg-white/10 aria-[current=page]:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400";

export function AuthenticatedApp({ user, onLogout, signingOut, authError }: AuthenticatedAppProps) {
  const chat = useChat(user.id);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 font-sans text-zinc-100 sm:px-6">
      <div className="flex min-h-dvh flex-col py-4 sm:py-6 lg:h-dvh">
        <header className="flex flex-none flex-wrap items-center justify-between gap-4 border-b border-white/10 pb-4">
          <LauluWordmark className="w-28 shrink-0 sm:w-32" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <nav aria-label="main navigation" className="flex gap-1">
                <NavLink to="/" end className={linkClass}>
                  chat
                </NavLink>
                <NavLink to="/songs" className={linkClass}>
                  my songs
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
          <Route path="/songs" element={<SongsPage />} />
          <Route path="/profile" element={<ProfilePage user={user} />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <footer className="flex justify-end border-t border-white/10 py-2 text-zinc-400">
        <NavLink to="/privacy" className="inline-flex min-h-11 items-center rounded-lg px-3 text-xs underline underline-offset-4 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400">
          privacy
        </NavLink>
      </footer>
    </div>
  );
}
