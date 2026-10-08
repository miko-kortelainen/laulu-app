import { supabase } from "@/lib/supabase";
import { authenticatedFetch } from "@/lib/api";

export type AuthView = "login" | "register" | "reset" | "update";

export async function submitAuth(view: AuthView, email: string, password: string, captchaToken?: string): Promise<void> {
  if (!supabase) throw new Error("authentication is not configured.");
  if (import.meta.env.VITE_TURNSTILE_SITE_KEY && view !== "update" && !captchaToken) {
    throw new Error("complete human verification to continue.");
  }
  const redirectTo = `${window.location.origin}/`;
  const result = view === "login"
    ? await supabase.auth.signInWithPassword({ email, password, options: { captchaToken } })
    : view === "register"
      ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo, captchaToken } })
      : view === "reset"
        ? await supabase.auth.resetPasswordForEmail(email, { redirectTo, captchaToken })
        : await supabase.auth.updateUser({ password });
  if (result.error) throw result.error;
}

export async function resendConfirmation(email: string, captchaToken?: string): Promise<void> {
  if (!supabase) throw new Error("authentication is not configured.");
  if (import.meta.env.VITE_TURNSTILE_SITE_KEY && !captchaToken) throw new Error("complete human verification to continue.");
  const { error } = await supabase.auth.resend({
    type: "signup", email, options: { emailRedirectTo: `${window.location.origin}/`, captchaToken },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (!supabase) throw new Error("authentication is not configured.");
  const response = await authenticatedFetch("/api/session/end", { method: "POST" });
  if (response.status !== 204) throw new Error("could not delete session uploads. try logging out again.");
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw error;
}
