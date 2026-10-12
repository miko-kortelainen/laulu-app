import type { User } from "@supabase/supabase-js";
import { useEffect, useRef, useState } from "react";
import { Navigate, NavLink, Route, Routes } from "react-router";
import { LauluWordmark } from "@/components/ui/LauluWordmark";
import { ChatPage } from "@/features/chat/ChatPage";
import { useChat } from "@/features/chat/useChat";
import { ProfilePage } from "@/features/profile/ProfilePage";
import { SongsPage } from "@/features/songs/SongsPage";
import { PrivacyPage } from "@/features/auth/PrivacyPage";
import { cn } from "@/lib/utils";

interface AuthenticatedAppProps {
  user: User;
  onLogout: () => Promise<void>;
  signingOut: boolean;
  authError?: string;
}

const linkClass = "flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-white/10 aria-[current=page]:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400";

export function AuthenticatedApp({ user, onLogout, signingOut, authError }: AuthenticatedAppProps) {
  const chat = useChat(user.id);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const drawerRef = useRef<HTMLDialogElement>(null);

  function closeNavigation() {
    drawerRef.current?.close();
  }

  useEffect(() => {
    if (!navigationOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const wideScreen = window.matchMedia("(min-width: 80rem)");
    const closeOnWideScreen = () => {
      if (wideScreen.matches) drawerRef.current?.close();
    };
    wideScreen.addEventListener("change", closeOnWideScreen);
    closeOnWideScreen();

    return () => {
      document.body.style.overflow = previousOverflow;
      wideScreen.removeEventListener("change", closeOnWideScreen);
    };
  }, [navigationOpen]);

  const navigation = (
    <nav aria-label="main navigation" className="flex flex-1 flex-col gap-1">
      <NavLink to="/" end className={linkClass} onClick={closeNavigation}>
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 15a3 3 0 0 1-3 3H7l-4 3V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z" />
        </svg>
        chat
      </NavLink>
      <NavLink to="/songs" className={linkClass} onClick={closeNavigation}>
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </svg>
        my songs
      </NavLink>
      <NavLink to="/profile" className={cn(linkClass, "mt-auto")} onClick={closeNavigation}>
        <svg viewBox="0 0 24 24" className="size-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
        </svg>
        my profile
      </NavLink>
    </nav>
  );

  return (
    <div className="w-full px-4 font-sans text-zinc-100 sm:px-6">
      <a href="#app-content" className="sr-only focus:not-sr-only focus:absolute focus:z-10 focus:rounded-lg focus:bg-zinc-900 focus:p-3">skip to content</a>
      <div className="flex min-h-dvh flex-col gap-6 py-4 sm:py-6 lg:h-dvh xl:flex-row">
        <header className="flex flex-none flex-col gap-6 xl:w-48 xl:border-r xl:border-white/10 xl:pr-6">
          <div className="relative flex min-h-11 items-center justify-center xl:min-h-0">
            <button type="button" aria-label="menu" aria-expanded={navigationOpen} aria-controls="app-navigation"
              onClick={() => { drawerRef.current?.showModal(); setNavigationOpen(true); }}
              className="absolute left-0 flex size-11 items-center justify-center rounded-lg border border-white/10 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 xl:hidden">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <LauluWordmark className="w-30 shrink-0 sm:w-34" />
          </div>
          <div id="app-desktop-navigation" className="hidden flex-1 flex-col gap-4 xl:flex">
            {navigation}
          </div>
          <dialog ref={drawerRef} id="app-navigation" aria-label="navigation" onClose={() => setNavigationOpen(false)}
            onClick={(event) => { if (event.target === event.currentTarget) closeNavigation(); }}
            className="navigation-drawer m-0 h-dvh max-h-none w-64 max-w-[85vw] overflow-y-auto overscroll-contain border-r border-white/10 bg-zinc-950 p-0 text-zinc-100 backdrop:bg-black/60">
            <div className="flex min-h-full flex-col gap-6 p-4">
              <div className="flex items-center justify-between gap-4">
                <p className="text-sm font-medium">menu</p>
                <button type="button" aria-label="close menu" onClick={closeNavigation}
                  className="flex size-11 items-center justify-center rounded-lg hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400">
                  <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                    <path d="m6 6 12 12M18 6 6 18" />
                  </svg>
                </button>
              </div>
              {navigation}
            </div>
          </dialog>
        </header>
        <div id="app-content" tabIndex={-1} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Routes>
            <Route path="/" element={<ChatPage chat={chat} />} />
            <Route path="/songs" element={<SongsPage />} />
            <Route path="/profile" element={
              <ProfilePage user={user} onLogout={onLogout} signingOut={signingOut} authError={authError}
                usage={chat.usage} usageError={chat.usageError} loading={chat.loading} refreshUsage={chat.refreshUsage} />
            } />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </div>
      <footer className="flex justify-end border-t border-white/10 py-2 text-zinc-400">
        <NavLink to="/privacy" className="inline-flex min-h-11 items-center rounded-lg px-3 text-xs underline underline-offset-4 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400">
          privacy
        </NavLink>
      </footer>
    </div>
  );
}
