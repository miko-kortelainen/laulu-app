import { supabase } from "./supabase";

export const TERMS_VERSION = "2026-10-12";

const pendingKey = "terms-acceptance-pending";

export function markTermsAcceptancePending(): void {
  try { sessionStorage.setItem(pendingKey, TERMS_VERSION); } catch { /* the gate asks again without storage */ }
}

export function hasTermsAcceptancePending(): boolean {
  try { return sessionStorage.getItem(pendingKey) === TERMS_VERSION; } catch { return false; }
}

export function clearTermsAcceptancePending(): void {
  try { sessionStorage.removeItem(pendingKey); } catch { /* nothing to clear */ }
}

export async function hasAcceptedTerms(userId: string, signal?: AbortSignal): Promise<boolean> {
  if (!supabase) throw new Error("authentication is not configured.");
  let query = supabase.from("terms_acceptances").select("version")
    .eq("user_id", userId).eq("version", TERMS_VERSION);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error("could not check terms acceptance. try again.");
  return data !== null;
}

export async function recordTermsAcceptance(userId: string): Promise<void> {
  if (!supabase) throw new Error("authentication is not configured.");
  const { error } = await supabase.from("terms_acceptances")
    .insert({ user_id: userId, version: TERMS_VERSION });
  // A duplicate means another tab already recorded this version.
  if (error && error.code !== "23505") throw new Error("could not record terms acceptance. try again.");
}
