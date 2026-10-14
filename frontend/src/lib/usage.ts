import { authenticatedFetch } from "@/lib/api";

interface Allowance { limit: number; used: number; remaining: number }
export interface Usage {
  resetAt: string;
  generationResetAt: string;
  plan: "free" | "starter" | "pro" | "ultra";
  chat: Allowance;
  analysis: Allowance;
  generation: Allowance;
  lyrics: Allowance;
  storage: Allowance & { reserved: number };
}

export async function getUsage(signal?: AbortSignal): Promise<Usage> {
  const response = await authenticatedFetch("/api/usage", { signal });
  if (!response.ok) throw new Error("could not load allowances. try again.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("resetAt" in data) || typeof data.resetAt !== "string" ||
      !Number.isFinite(Date.parse(data.resetAt))) throw new Error("invalid usage response.");
  if (!("generationResetAt" in data) || typeof data.generationResetAt !== "string" ||
      !Number.isFinite(Date.parse(data.generationResetAt)) || !("plan" in data) ||
      !["free", "starter", "pro", "ultra"].includes(String(data.plan))) throw new Error("invalid usage response.");
  for (const name of ["chat", "analysis", "generation", "lyrics", "storage"] as const) {
    const value = (data as Record<string, unknown>)[name];
    if (!value || typeof value !== "object") throw new Error("invalid usage response.");
    for (const field of name === "storage" ? ["limit", "used", "remaining", "reserved"] : ["limit", "used", "remaining"]) {
      const count = (value as Record<string, unknown>)[field];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("invalid usage response.");
    }
  }
  return data as Usage;
}
