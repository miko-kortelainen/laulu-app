import { useEffect, useRef, useState } from "react";
import type { Paddle } from "@paddle/paddle-js";
import type { User } from "@supabase/supabase-js";
import { cancelSubscription, changeSubscription, createCheckout, getBilling, getPlanLimits, loadPricing, paidPlans, previewPlanChange, type Billing, type BillingInterval, type PlanChangePreview, type PlanLimits } from "./api";

export function usePricing(user?: User) {
  const [billingInterval, setBillingInterval] = useState<BillingInterval>("month");
  const [pricing, setPricing] = useState<{ paddle: Paddle; prices: Record<string, string> }>();
  const [billing, setBilling] = useState<Billing>();
  const [limits, setLimits] = useState<PlanLimits[]>();
  const [limitsReady, setLimitsReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [billingLoading, setBillingLoading] = useState(Boolean(user));
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedPlan, setSelectedPlan] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [pendingAction, setPendingAction] = useState<{ preview: PlanChangePreview } | "cancel">();
  const [managing, setManaging] = useState(false);
  const managementBusy = useRef(false);
  const billingTarget = useRef<PlanChangePreview | "cancel" | undefined>(undefined);
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
        const target = billingTarget.current;
        const confirmed = target === "cancel"
          ? result.status === "canceled" || result.scheduledChange?.action === "cancel"
          : target ? result.paidAccess && result.billingInterval === target.billingInterval && (target.effectiveAt
            ? (result.scheduledChange?.action === "downgrade" && result.scheduledChange.plan === target.plan) || result.plan === target.plan
            : result.plan === target.plan)
          : result.paidAccess && (!transactionId.current || result.transactionId === transactionId.current);
        if (confirmed) {
          setNotice(target === "cancel" ? result.status === "canceled" ? "your subscription has ended." : "cancellation is scheduled. you keep access until the end of your paid period."
            : target?.effectiveAt ? `${target.plan} starts at your next renewal. your current allowances stay available until then.`
            : `${result.plan} is active. your plan allowances are ready.`);
          billingTarget.current = undefined;
          transactionId.current = undefined;
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
      throw new Error("your subscription update is still pending. retry the subscription check before making another change.");
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
    setPendingAction(undefined);
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
    void getPlanLimits(controller.signal).then(result => {
      if (!controller.signal.aborted) {
        setLimits(result);
        setLimitsReady(true);
      }
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "could not load plan allowances. try again.");
    });
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
    if (!user || !pricing || !billing || !limitsReady || loading || syncing || !pricing.prices[plan.priceIds[billingInterval]] ||
        checkoutOpen.current || subscriptionCheck.current || managementBusy.current || pendingAction || billingTarget.current ||
        (billing.status && billing.status !== "canceled") || !controller || controller.signal.aborted) return;
    setError(undefined);
    setNotice(undefined);
    checkoutOpen.current = true;
    setSelectedPlan(plan.name);
    try {
      transactionId.current = await createCheckout(plan.name, billingInterval, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
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

  async function choosePlan(plan: typeof paidPlans[number]): Promise<void> {
    if (!billing?.status || billing.status === "canceled") return checkout(plan);
    const controller = requests.current;
    if (!user || billing.status !== "active" || billing.billingInterval !== billingInterval || billing.scheduledChange || pendingAction || managementBusy.current ||
        checkoutOpen.current || subscriptionCheck.current || billingTarget.current || !controller || controller.signal.aborted) return;
    managementBusy.current = true;
    setManaging(true);
    setSelectedPlan(plan.name);
    setError(undefined);
    setNotice(undefined);
    try {
      const preview = await previewPlanChange(plan.name, billingInterval, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]));
      controller.signal.throwIfAborted();
      setPendingAction({ preview });
    } catch (cause: unknown) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "could not preview this plan change. try again.");
    } finally {
      managementBusy.current = false;
      if (!controller.signal.aborted) {
        setManaging(false);
        setSelectedPlan(undefined);
      }
    }
  }

  function requestCancellation(): void {
    if (!billing?.status || billing.status === "canceled" || billing.scheduledChange?.action === "cancel" ||
        managementBusy.current || checkoutOpen.current || subscriptionCheck.current || billingTarget.current) return;
    setError(undefined);
    setNotice(undefined);
    setPendingAction("cancel");
  }

  async function confirmAction(): Promise<void> {
    const controller = requests.current;
    if (!pendingAction || managementBusy.current || subscriptionCheck.current || !controller || controller.signal.aborted) return;
    managementBusy.current = true;
    setManaging(true);
    setError(undefined);
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]);
      if (pendingAction === "cancel") await cancelSubscription(signal);
      else await changeSubscription(pendingAction.preview, signal);
      controller.signal.throwIfAborted();
      billingTarget.current = pendingAction === "cancel" ? "cancel" : pendingAction.preview;
      transactionId.current = undefined;
      setPendingAction(undefined);
      await confirmSubscription();
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        setPendingAction(undefined);
        setError(cause instanceof Error ? cause.message : "could not update your subscription. check its status before retrying.");
      }
    } finally {
      managementBusy.current = false;
      if (!controller.signal.aborted) setManaging(false);
    }
  }

  function dismissAction(): void {
    if (!managementBusy.current) setPendingAction(undefined);
  }

  function retry(): void {
    setLoading(true);
    setLimitsReady(false);
    setBillingLoading(Boolean(user));
    setError(undefined);
    setAttempt(previous => previous + 1);
  }

  return { prices: pricing?.prices, billingInterval, setBillingInterval, limits, limitsReady, billing, loading, billingLoading, error, notice, selectedPlan, syncing,
    choosePlan, requestCancellation, pendingAction, managing, confirmAction, dismissAction, retry, confirmSubscription,
    updatePending: Boolean(billingTarget.current), pendingTransaction: Boolean(transactionId.current || billingTarget.current) };
}
