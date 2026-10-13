import { useEffect, useRef, useState } from "react";
import type { Paddle } from "@paddle/paddle-js";
import type { User } from "@supabase/supabase-js";
import { loadPricing, paidPlans } from "./api";

export function usePricing(user?: User) {
  const [pricing, setPricing] = useState<{ paddle: Paddle; prices: Record<string, string> }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedPlan, setSelectedPlan] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const checkoutOpen = useRef(false);

  useEffect(() => {
    let active = true;
    let paddle: Paddle | undefined;

    async function load() {
      const result = await loadPricing(event => {
        if (!active) return;
        if (event.name === "checkout.closed" || event.name === "checkout.completed" ||
            event.name === "checkout.error" || event.name === "checkout.failed") {
          checkoutOpen.current = false;
          setSelectedPlan(undefined);
        }
        if (event.name === "checkout.completed") {
          setError(undefined);
          setNotice("sandbox checkout completed. your beta allowances are unchanged.");
        }
        if (event.name === "checkout.error" || event.name === "checkout.failed") {
          setError("checkout could not open. try again.");
        }
        if (event.name === "checkout.payment.error" || event.name === "checkout.payment.failed") {
          setError("payment failed. try another test card in checkout.");
        }
      }).catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "prices could not load. try again.");
          setLoading(false);
        }
      });
      if (!result || !active) return;
      paddle = result.paddle;
      setPricing(result);
      setLoading(false);
    }
    void load();

    return () => {
      active = false;
      if (checkoutOpen.current) paddle?.Checkout.close();
      checkoutOpen.current = false;
    };
  }, [attempt]);

  function checkout(plan: typeof paidPlans[number]): void {
    if (!user || !pricing || loading || !pricing.prices[plan.priceId] || checkoutOpen.current) return;
    setError(undefined);
    setNotice(undefined);
    checkoutOpen.current = true;
    setSelectedPlan(plan.name);
    try {
      pricing.paddle.Checkout.open({
        items: [{ priceId: plan.priceId, quantity: 1 }],
        ...(user.email && { customer: { email: user.email } }),
        settings: { displayMode: "overlay", variant: "one-page", theme: "dark", allowLogout: false },
      });
    } catch {
      checkoutOpen.current = false;
      setSelectedPlan(undefined);
      setError("checkout could not open. try again.");
    }
  }

  function retry(): void {
    setLoading(true);
    setError(undefined);
    setAttempt(previous => previous + 1);
  }

  return { prices: pricing?.prices, loading, error, notice, selectedPlan, checkout, retry };
}
