import { createContext, useContext } from "react";

export const PaidTiersContext = createContext<boolean | undefined>(undefined);

export function usePaidTiersEnabled(): boolean | undefined {
  return useContext(PaidTiersContext);
}

export async function getPaidTiersEnabled(signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/features", { signal, cache: "no-store" });
  if (!response.ok) throw new Error("could not load feature flags.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("paidTiersEnabled" in data) || typeof data.paidTiersEnabled !== "boolean") {
    throw new Error("invalid feature flags.");
  }
  return data.paidTiersEnabled;
}
