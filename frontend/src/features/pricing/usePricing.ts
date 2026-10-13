import { useEffect, useRef, useState } from "react";
import type { Paddle } from "@paddle/paddle-js";
import type { User } from "@supabase/supabase-js";
import { createCheckout, getBilling, loadPricing, paidPlans, type Billing } from "./api";

export function usePricing(user?: User) {
  const [pricing, setPricing] = useState<{ paddle: Paddle; prices: Record<string, string> }>();
  const [billing, setBilling] = useState<Billing>();
  const [loading, setLoading] = useState(true);
  const [billingLoading, setBillingLoading] = useState(Boolean(user));
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedPlan, setSelectedPlan] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const checkoutOpen = useRef(false);
  const transactionId = useRef<string | undefined>(undefined);
  const requests = useRef<AbortController | undefined>(undefined);
  const subscriptionCheck = useRef(false);

  async function refreshBilling(signal: AbortSignal): Promise<Billing> {
    const result = await getBilling(signal);
    signal.throwIfAborted();
    setBilling(result);
    setBillingLoading(false);
    return result;
  }

  async function confirmSubscription(): Promise<void> {
    const controller = requests.current;
    if (!controller || controller.signal.aborted || subscriptionCheck.current) return;
    subscriptionCheck.current = true;
    setSyncing(true);
    setError(undefined);
    setNotice("checking your subscription…");
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await refreshBilling(signal);
        if (result.paidAccess && (!transactionId.current || result.transactionId === transactionId.current)) {
          setNotice(`${result.plan} is active. your monthly song allowance is ready.`);
          window.dispatchEvent(new Event("billing-updated"));
          return;
        }
        await new Promise<void>((resolve) => {
          const timer = window.setTimeout(finish, 1500);
          function finish() {
            window.clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            resolve();
          }
          signal.addEventListener("abort", finish, { once: true });
        });
        signal.throwIfAborted();
      }
      throw new Error("subscription activation is still pending. retry the subscription check; do not pay again.");
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "could not confirm your subscription. try again.");
    } finally {
      subscriptionCheck.current = false;
      if (!controller.signal.aborted) setSyncing(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    let paddle: Paddle | undefined;

    async function load() {
      const result = await loadPricing(event => {
        if (controller.signal.aborted) return;
        if (event.name === "checkout.closed" || event.name === "checkout.completed" ||
            event.name === "checkout.error" || event.name === "checkout.failed") {
          checkoutOpen.current = false;
          setSelectedPlan(undefined);
        }
        if (event.name === "checkout.completed" && transactionId.current) void confirmSubscription();
        if (event.name === "checkout.error" || event.name === "checkout.failed") setError("checkout could not open. try again.");
        if (event.name === "checkout.payment.error" || event.name === "checkout.payment.failed") {
          setError("payment failed. try another test card in checkout.");
        }
      }).catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "prices could not load. try again.");
          setLoading(false);
        }
      });
      if (!result || controller.signal.aborted) return;
      paddle = result.paddle;
      setPricing(result);
      setLoading(false);
    }
    void load();
    if (user) void refreshBilling(controller.signal).catch(() => {
      if (!controller.signal.aborted) {
        setError("could not load your subscription. retry before starting checkout.");
        setBillingLoading(false);
      }
    });

    return () => {
      controller.abort();
      if (checkoutOpen.current) paddle?.Checkout.close();
      checkoutOpen.current = false;
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- helpers use this effect's abort signal and current transaction ref.
  }, [attempt, user?.id]);

  async function checkout(plan: typeof paidPlans[number]): Promise<void> {
    const controller = requests.current;
    if (!user || !pricing || !billing || loading || syncing || !pricing.prices[plan.priceId] ||
        checkoutOpen.current || subscriptionCheck.current || !controller || controller.signal.aborted) return;
    setError(undefined);
    setNotice(undefined);
    checkoutOpen.current = true;
    setSelectedPlan(plan.name);
    try {
      transactionId.current = await createCheckout(plan.name, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      controller.signal.throwIfAborted();
      pricing.paddle.Checkout.open({
        transactionId: transactionId.current,
        ...(user.email && { customer: { email: user.email } }),
        settings: { displayMode: "overlay", variant: "one-page", theme: "dark", allowLogout: false },
      });
    } catch (cause: unknown) {
      if (controller.signal.aborted) return;
      checkoutOpen.current = false;
      setSelectedPlan(undefined);
      setError(cause instanceof Error ? cause.message : "checkout could not open. try again.");
    }
  }

  function retry(): void {
    setLoading(true);
    setBillingLoading(Boolean(user));
    setError(undefined);
    setAttempt(previous => previous + 1);
  }

  return { prices: pricing?.prices, billing, loading, billingLoading, error, notice, selectedPlan, syncing,
    checkout, retry, confirmSubscription, pendingTransaction: Boolean(transactionId.current) };
}
