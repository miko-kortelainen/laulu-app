import { useEffect, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { authCallback, supabase } from "@/lib/supabase";
import { setApiUser } from "@/lib/api";
import { resendConfirmation, signOut, submitAuth, type AuthView } from "./api";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "authentication failed. try again.";
}

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [view, setView] = useState<AuthView>(authCallback.recovery ? "update" : "login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(authCallback.error);
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string>();
  const [captchaReset, setCaptchaReset] = useState(0);
  const captchaRequired = Boolean(import.meta.env.VITE_TURNSTILE_SITE_KEY) && view !== "update";
  const pending = useRef(false);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (!active) return;
      setApiUser(nextSession?.user.id);
      setSession(nextSession);
      setLoading(false);
      if (event === "INITIAL_SESSION" && !nextSession && authCallback.recovery) {
        setView("login");
        setError(authCallback.error ?? "this password reset link is invalid or expired. request a new link.");
      }
      if (event === "PASSWORD_RECOVERY") setView("update");
      if (event === "SIGNED_OUT") {
        setView("login");
        setPassword("");
        setNotice(undefined);
      }
    });
    if (authCallback.error) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    function expired() {
      setApiUser(undefined);
      setSession(null);
      setView("login");
      setError("your session expired. log in again.");
    }
    function authRedirect() {
      const callback = new URLSearchParams(window.location.hash.slice(1));
      // Supabase processes an implicit email callback during client initialization.
      if (callback.has("access_token") || callback.has("error")) window.location.reload();
    }
    window.addEventListener("session-expired", expired);
    window.addEventListener("hashchange", authRedirect);
    return () => {
      active = false;
      subscription.unsubscribe();
      window.removeEventListener("session-expired", expired);
      window.removeEventListener("hashchange", authRedirect);
      setApiUser(undefined);
    };
  }, []);

  function changeView(nextView: AuthView): void {
    if (pending.current) return;
    setView(nextView);
    setPassword("");
    setError(undefined);
    setNotice(undefined);
    setCaptchaToken(undefined);
  }

  async function perform(action: () => Promise<void>, success?: () => void): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const failure = await action().catch((cause: unknown) => new Error(errorMessage(cause)));
    if (failure) setError(failure.message);
    else success?.();
    setCaptchaToken(undefined);
    setCaptchaReset((previous) => previous + 1);
    pending.current = false;
    setBusy(false);
  }

  function submit(): Promise<void> {
    return perform(() => submitAuth(view, email.trim(), password, captchaToken), () => {
      setPassword("");
      if (view === "register") setNotice("check your email to confirm your account before logging in.");
      if (view === "reset") setNotice("if an account exists, you will receive a password reset email.");
      if (view === "update") {
        setView("login");
        setNotice("your password is updated.");
      }
    });
  }

  return {
    session, loading, view, email, password, error, notice, busy, captchaRequired, captchaToken, captchaReset, setCaptchaToken,
    configured: Boolean(supabase), setEmail, setPassword, changeView, submit,
    resend: () => perform(() => resendConfirmation(email.trim(), captchaToken), () => setNotice("check your email for a confirmation link.")),
    logout: () => perform(signOut),
  };
}
