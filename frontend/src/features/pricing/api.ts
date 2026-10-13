import { initializePaddle, type Paddle, type PaddleEventData } from "@paddle/paddle-js";

export const paidPlans = [
  { name: "starter", songs: 30, description: "for occasional song ideas", priceId: import.meta.env.VITE_PADDLE_STARTER_PRICE_ID },
  { name: "pro", songs: 80, description: "for a regular creative practice", priceId: import.meta.env.VITE_PADDLE_PRO_PRICE_ID },
  { name: "ultra", songs: 180, description: "for more versions and experiments", priceId: import.meta.env.VITE_PADDLE_ULTRA_PRICE_ID },
] as const;

export async function loadPricing(onEvent: (event: PaddleEventData) => void): Promise<{ paddle: Paddle; prices: Record<string, string> }> {
  const token = import.meta.env.VITE_PADDLE_CLIENT_TOKEN;
  if (typeof token !== "string" || !token.startsWith("test_") ||
      paidPlans.some(plan => typeof plan.priceId !== "string" || !/^pri_[a-z0-9]{26}$/.test(plan.priceId))) {
    throw new Error("sandbox checkout is not configured yet.");
  }

  const paddle = await initializePaddle({ token, environment: "sandbox", eventCallback: onEvent }).catch(() => {
    throw new Error("checkout could not load. reload the page and try again.");
  });
  if (!paddle?.Initialized) throw new Error("checkout could not load. reload the page and try again.");

  const preview = await paddle.PricePreview({ items: paidPlans.map(plan => ({ priceId: plan.priceId, quantity: 1 })) }).catch(() => {
    throw new Error("prices could not load. try again.");
  });
  const prices: Record<string, string> = {};
  for (const plan of paidPlans) {
    const item = preview.data?.details?.lineItems?.find(line => line.price.id === plan.priceId);
    if (!item || item.price.status !== "active" || item.product.status !== "active" ||
        item.price.billingCycle?.interval !== "month" || item.price.billingCycle.frequency !== 1 ||
        item.price.trialPeriod || typeof item.formattedTotals.total !== "string" || !item.formattedTotals.total.trim()) {
      throw new Error("monthly prices are unavailable. try again.");
    }
    prices[plan.priceId] = item.formattedTotals.total;
  }
  return { paddle, prices };
}
