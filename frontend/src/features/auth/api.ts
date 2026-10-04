import { supabase } from "@/lib/supabase";

export type AuthView = "login" | "register" | "reset" | "update";

export async function submitAuth(view: AuthView, email: string, password: string): Promise<void> {
  if (!supabase) throw new Error("authentication is not configured.");
  const redirectTo = `${window.location.origin}/`;
  const result = view === "login"
    ? await supabase.auth.signInWithPassword({ email, password })
    : view === "register"
      ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } })
      : view === "reset"
        ? await supabase.auth.resetPasswordForEmail(email, { redirectTo })
        : await supabase.auth.updateUser({ password });
  if (result.error) throw result.error;
}

export async function resendConfirmation(email: string): Promise<void> {
  if (!supabase) throw new Error("authentication is not configured.");
  const { error } = await supabase.auth.resend({
    type: "signup", email, options: { emailRedirectTo: `${window.location.origin}/` },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  if (!supabase) throw new Error("authentication is not configured.");
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw error;
}
