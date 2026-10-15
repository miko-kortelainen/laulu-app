import { initializePaddle, type Paddle, type PaddleEventData } from "@paddle/paddle-js";
import { authenticatedFetch } from "@/lib/api";

export type BillingInterval = "month" | "year";

export interface Billing {
  plan: "starter" | "pro" | "ultra" | null;
  status: string | null;
  paidAccess: boolean;
  periodEnd: string | null;
  billingInterval: BillingInterval | null;
  transactionId: string | null;
  scheduledChange: { action: string; effectiveAt: string; plan?: string } | null;
}

export async function getBilling(signal?: AbortSignal): Promise<Billing> {
  const response = await authenticatedFetch("/api/billing", { signal });
  if (!response.ok) throw new Error("could not load your subscription. try again.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("paidAccess" in data) || typeof data.paidAccess !== "boolean" ||
      !("plan" in data) || (data.plan !== null && !["starter", "pro", "ultra"].includes(String(data.plan))) ||
      !("status" in data) || (data.status !== null && typeof data.status !== "string") ||
      !("billingInterval" in data) || (data.billingInterval !== null && data.billingInterval !== "month" && data.billingInterval !== "year") ||
      !("periodEnd" in data) || (data.periodEnd !== null && (typeof data.periodEnd !== "string" || !Number.isFinite(Date.parse(data.periodEnd)))) ||
      !("transactionId" in data) || (data.transactionId !== null && (typeof data.transactionId !== "string" || !/^txn_[a-z0-9]{26}$/.test(data.transactionId)))) {
    throw new Error("invalid subscription response.");
  }
  const change = "scheduledChange" in data ? data.scheduledChange : undefined;
  if (change !== null && (!change || typeof change !== "object" || !("action" in change) || typeof change.action !== "string" ||
      !("effectiveAt" in change) || typeof change.effectiveAt !== "string" || !Number.isFinite(Date.parse(change.effectiveAt)) ||
      ("plan" in change && (typeof change.plan !== "string" || !["starter", "pro", "ultra"].includes(change.plan))))) {
    throw new Error("invalid subscription response.");
  }
  return data as Billing;
}

export interface PlanChangePreview {
  plan: string;
  billingInterval: BillingInterval;
  subscriptionUpdatedAt: string;
  effectiveAt: string | null;
  chargeNow: string;
  recurringTotal: string;
  nextTotal: string;
  nextBilledAt: string;
}

async function subscriptionRequest(action: "preview" | "change" | "cancel", body: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  const response = await authenticatedFetch(`/api/billing/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    const data: unknown = await response.json().catch(() => null);
    throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error : "could not update your subscription. check its status before retrying.");
  }
  return response;
}

export async function previewPlanChange(plan: string, billingInterval: BillingInterval, signal: AbortSignal): Promise<PlanChangePreview> {
  const response = await subscriptionRequest("preview", { plan, billingInterval }, signal);
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("invalid plan change preview.");
  const preview = data as Record<string, unknown>;
  if (preview.plan !== plan || preview.billingInterval !== billingInterval ||
      !["chargeNow", "recurringTotal", "nextTotal"].every(field => typeof preview[field] === "string" && preview[field].trim()) ||
      !["subscriptionUpdatedAt", "nextBilledAt"].every(field => typeof preview[field] === "string" && Number.isFinite(Date.parse(preview[field]))) ||
      (preview.effectiveAt !== null && (typeof preview.effectiveAt !== "string" || !Number.isFinite(Date.parse(preview.effectiveAt))))) {
    throw new Error("invalid plan change preview.");
  }
  return data as PlanChangePreview;
}

export async function changeSubscription(preview: PlanChangePreview, signal: AbortSignal): Promise<void> {
  await subscriptionRequest("change", { plan: preview.plan, billingInterval: preview.billingInterval, subscriptionUpdatedAt: preview.subscriptionUpdatedAt }, signal);
}

export async function cancelSubscription(signal: AbortSignal): Promise<void> {
  await subscriptionRequest("cancel", {}, signal);
}

export async function createCheckout(plan: string, billingInterval: BillingInterval, signal: AbortSignal): Promise<string> {
  const response = await authenticatedFetch("/api/billing/checkout", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ plan, billingInterval }), signal,
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error : "checkout could not start. try again.");
  if (!data || typeof data !== "object" || !("transactionId" in data) || typeof data.transactionId !== "string" ||
      !/^txn_[a-z0-9]{26}$/.test(data.transactionId)) throw new Error("invalid checkout response.");
  return data.transactionId;
}

export const paidPlans = [
  { name: "starter", description: "for occasional song ideas", priceIds: { month: import.meta.env.VITE_PADDLE_STARTER_PRICE_ID, year: import.meta.env.VITE_PADDLE_STARTER_ANNUAL_PRICE_ID } },
  { name: "pro", description: "for a regular creative practice", priceIds: { month: import.meta.env.VITE_PADDLE_PRO_PRICE_ID, year: import.meta.env.VITE_PADDLE_PRO_ANNUAL_PRICE_ID } },
  { name: "ultra", description: "for the most usage", priceIds: { month: import.meta.env.VITE_PADDLE_ULTRA_PRICE_ID, year: import.meta.env.VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID } },
] as const;

export interface PlanLimits {
  plan: "free" | "starter" | "pro" | "ultra";
  chat_daily: number;
  analysis_daily: number;
  songs_daily: number | null;
  songs_monthly: number | null;
  lyrics_daily: number | null;
  lyrics_monthly: number | null;
  storage_bytes: number;
}

export async function getPlanLimits(signal: AbortSignal): Promise<PlanLimits[]> {
  const response = await fetch("/api/plans", { signal });
  if (!response.ok) throw new Error("could not load plan allowances. try again.");
  const data: unknown = await response.json();
  const names = ["free", "starter", "pro", "ultra"];
  if (!Array.isArray(data) || data.length !== names.length || !data.every((value: unknown) => {
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return names.includes(String(row.plan)) &&
      ["chat_daily", "analysis_daily", "storage_bytes", row.plan === "free" ? "songs_daily" : "songs_monthly", row.plan === "free" ? "lyrics_daily" : "lyrics_monthly"].every(field =>
        typeof row[field] === "number" && Number.isSafeInteger(row[field]) && row[field] >= 0) &&
      row[row.plan === "free" ? "songs_monthly" : "songs_daily"] === null &&
      row[row.plan === "free" ? "lyrics_monthly" : "lyrics_daily"] === null;
  }) || !names.every(name => data.filter((row: PlanLimits) => row.plan === name).length === 1)) {
    throw new Error("invalid plan allowances.");
  }
  return data as PlanLimits[];
}

export async function loadPricing(onEvent: (event: PaddleEventData) => void): Promise<{ paddle: Paddle; prices: Record<string, string> }> {
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN;
  const pricesToLoad = paidPlans.flatMap(plan => (["month", "year"] as const)
    .filter(interval => interval === "month" || plan.priceIds[interval])
    .map(interval => ({ priceId: plan.priceIds[interval], interval })));
  if (typeof token !== "string" || !token.startsWith("test_") ||
      pricesToLoad.some(plan => typeof plan.priceId !== "string" || !/^pri_[a-z0-9]{26}$/.test(plan.priceId))) {
    throw new Error("sandbox checkout is not configured yet.");
  }

  const paddle = await initializePaddle({ token, environment: "sandbox", eventCallback: onEvent }).catch(() => {
    throw new Error("checkout could not load. reload the page and try again.");
  });
  if (!paddle?.Initialized) throw new Error("checkout could not load. reload the page and try again.");

  const preview = await paddle.PricePreview({ currencyCode: "USD", items: pricesToLoad.map(plan => ({ priceId: plan.priceId, quantity: 1 })) }).catch(() => {
    throw new Error("prices could not load. try again.");
  });
  const prices: Record<string, string> = {};
  for (const plan of pricesToLoad) {
    const item = preview.data?.details?.lineItems?.find(line => line.price.id === plan.priceId);
    if (!item || item.price.status !== "active" || item.product.status !== "active" ||
        item.price.billingCycle?.interval !== plan.interval || item.price.billingCycle.frequency !== 1 ||
        item.price.trialPeriod || typeof item.formattedTotals.total !== "string" || !item.formattedTotals.total.trim()) {
      throw new Error("prices are unavailable. try again.");
    }
    prices[plan.priceId] = item.formattedTotals.total;
  }
  return { paddle, prices };
}
