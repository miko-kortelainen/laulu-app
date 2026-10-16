import { authenticatedFetch } from "./api";

const TERMS_VERSION = "2026-10-13";

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

export async function hasAcceptedTerms(signal?: AbortSignal): Promise<boolean> {
  const response = await authenticatedFetch("/api/terms", { signal });
  if (!response.ok) throw new Error("could not check terms acceptance. try again.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("accepted" in data) || typeof data.accepted !== "boolean" ||
      !("version" in data) || typeof data.version !== "string") {
    throw new Error("invalid terms acceptance response. try again.");
  }
  if (data.version !== TERMS_VERSION) throw new Error("terms version changed. reload the page and accept the current terms.");
  return data.accepted;
}

export async function recordTermsAcceptance(signal?: AbortSignal): Promise<void> {
  const response = await authenticatedFetch("/api/terms", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: TERMS_VERSION }), signal,
  });
  if (response.status === 400) throw new Error("terms version changed. reload the page and accept the current terms.");
  if (response.status !== 204) throw new Error("could not record terms acceptance. try again.");
}
