import type { User } from "@supabase/supabase-js";
import { Link } from "react-router";
import { LauluWordmark } from "@/components/ui/LauluWordmark";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/date";
import { paidPlans, type PlanLimits } from "./api";
import { usePricing } from "./usePricing";

const buttonClass = "inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm font-medium hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-50";
const linkClass = "inline-flex min-h-11 items-center rounded-lg underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300";

function Allowances({ limits }: { limits?: PlanLimits }) {
  if (!limits) return <li>allowances unavailable</li>;
  const storage = limits.storage_bytes / 1024 / 1024;
  return <>
    <li><strong className="font-semibold text-zinc-100">{limits.songs_monthly} songs</strong> per month</li>
    <li>{limits.chat_daily} chat messages per day</li>
    <li>{limits.lyrics_monthly} lyric requests per month</li>
    <li>{limits.analysis_daily} audio analyses per day</li>
    <li>{storage >= 1024 ? `${storage / 1024} GiB` : `${storage} MiB`} for your song library</li>
  </>;
}

export function PricingPage({ user }: { user?: User }) {
  const pricing = usePricing(user);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-1 py-8 sm:py-12">
      <div className="mx-auto max-w-6xl space-y-10 px-4 sm:px-6">
        {!user && <header className="flex flex-wrap items-center justify-between gap-4">
          <Link to="/" aria-label="laulu home" className="rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-zinc-300">
            <LauluWordmark className="w-30 sm:w-34" />
          </Link>
          <Link to="/login" state={{ from: "/pricing" }} className={linkClass}>log in</Link>
        </header>}

        <section aria-labelledby="pricing-title" className="space-y-4">
          <p className="text-xs font-medium tracking-widest text-zinc-400">plans</p>
          <h1 id="pricing-title" className="max-w-2xl text-3xl font-semibold tracking-tight sm:text-5xl">more room to make music</h1>
          <p className="max-w-xl text-sm leading-relaxed text-zinc-400">describe a song, work on its lyrics and sound, and hear your ideas take shape.</p>
          <p className="max-w-2xl rounded-lg border border-amber-300/20 bg-amber-300/5 px-4 py-3 text-sm text-amber-200">
            sandbox · checkout uses test payments. your plan activates after payment is confirmed.
          </p>
        </section>

        <div role="group" aria-label="billing frequency" className="mx-auto grid w-fit grid-cols-2 gap-1 rounded-lg border border-white/15 p-1">
          {(["month", "year"] as const).map(interval => <button key={interval} type="button"
            aria-pressed={pricing.billingInterval === interval}
            disabled={Boolean(pricing.selectedPlan) || pricing.syncing || pricing.managing || Boolean(pricing.pendingAction) || pricing.updatePending}
            onClick={() => pricing.setBillingInterval(interval)}
            className={cn(buttonClass, "min-h-6 w-auto border-transparent py-0", pricing.billingInterval === interval && "bg-white/10")}>
            {interval === "month" ? "monthly" : "yearly"}
          </button>)}
        </div>

        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <section aria-labelledby="plan-free" className="flex flex-col rounded-xl border border-white/10 bg-zinc-900/60 p-6">
            <p className="mb-4 text-xs text-zinc-400">try laulu</p>
            <h2 id="plan-free" className="text-lg font-semibold">free</h2>
            <p className="mt-1 text-sm text-zinc-400">get started with the free beta</p>
            <p className="mt-6 text-4xl font-semibold tabular-nums">$0</p>
            <p className="mt-2 text-xs text-zinc-400">no payment required</p>
            <ul className="my-8 flex-1 space-y-3 text-sm text-zinc-300">
              <Allowances limits={pricing.limits?.find(plan => plan.plan === "free")} />
            </ul>
            <Link to={user ? "/" : "/create-account"} className={buttonClass}>{user ? "open studio" : "create free account"}</Link>
          </section>

          {paidPlans.map(plan => {
            const featured = plan.name === "pro";
            const price = pricing.prices?.[plan.priceIds[pricing.billingInterval]];
            const savings = pricing.annualSavings?.[plan.name];
            const hasSubscription = Boolean(pricing.billing?.status && pricing.billing.status !== "canceled");
            const currentPlan = pricing.billing?.plan === plan.name && pricing.billing.paidAccess && pricing.billing.billingInterval === pricing.billingInterval;
            return (
              <section key={plan.name} aria-labelledby={`plan-${plan.name}`} className={cn(
                "flex flex-col rounded-xl border bg-zinc-900/60 p-6",
                featured ? "pricing-gradient-border border-transparent" : "border-white/10",
              )}>
                <p className={cn("mb-4 text-xs", featured ? "text-amber-200" : "text-zinc-400")}>{featured ? "recommended" : pricing.billingInterval === "year" ? "yearly plan" : "monthly plan"}</p>
                <h2 id={`plan-${plan.name}`} className="text-lg font-semibold">{plan.name}</h2>
                <p className="mt-1 text-sm text-zinc-400">{plan.description}</p>
                <p className="mt-6 break-words text-4xl font-semibold tabular-nums">{price ?? (pricing.loading ? "…" : "unavailable")}</p>
                <p className="mt-2 text-xs text-zinc-400">
                  {pricing.billingInterval === "year" ? "billed yearly" : "billed monthly"}
                  {savings !== undefined && savings > 0 &&
                    <span aria-hidden={pricing.billingInterval !== "year"} className={cn("ml-2 inline-block rounded-full bg-green-400/10 px-2 py-0.5 font-medium text-green-300", pricing.billingInterval !== "year" && "invisible")}>save {savings}%</span>}
                </p>
                <ul className="my-8 flex-1 space-y-3 text-sm text-zinc-300">
                  <Allowances limits={pricing.limits?.find(limits => limits.plan === plan.name)} />
                </ul>
                {user ? <button type="button" disabled={pricing.loading || !pricing.limitsReady || pricing.billingLoading || !pricing.billing || !price || Boolean(pricing.selectedPlan) || pricing.syncing || pricing.managing || Boolean(pricing.pendingAction) || pricing.updatePending || currentPlan ||
                    (hasSubscription && (pricing.billing?.status !== "active" || pricing.billing.billingInterval !== pricing.billingInterval || Boolean(pricing.billing.scheduledChange)))}
                  onClick={() => void pricing.choosePlan(plan)} className={buttonClass}>
                  {pricing.selectedPlan === plan.name ? hasSubscription ? "loading preview…" : "opening checkout…"
                    : currentPlan ? "current plan" : hasSubscription ? `change to ${plan.name}` : `choose ${plan.name}`}
                </button> : <Link to="/login" state={{ from: "/pricing" }} className={buttonClass}>
                  {`log in to choose ${plan.name}`}
                </Link>}
              </section>
            );
          })}
        </div>

        {pricing.pendingAction && <section aria-labelledby="subscription-confirm-title" className="max-w-xl space-y-4 rounded-xl border border-white/15 bg-zinc-900/60 p-6">
          <h2 id="subscription-confirm-title" className="text-lg font-semibold">
            {pricing.pendingAction === "cancel" ? "cancel your subscription?" : `change to ${pricing.pendingAction.preview.plan}?`}
          </h2>
          {pricing.pendingAction === "cancel" ? <p className="text-sm text-zinc-300">
            {pricing.billing?.status === "paused" ? "your paused subscription will end immediately."
              : `your subscription will end ${pricing.billing?.periodEnd ? `on ${formatDate(pricing.billing.periodEnd)}` : "at the next renewal"}. you keep access until then, and it will not renew.`}
          </p> : <div className="space-y-2 text-sm text-zinc-300">
            <p>{pricing.pendingAction.preview.effectiveAt
              ? `${pricing.pendingAction.preview.plan} starts on ${formatDate(pricing.pendingAction.preview.effectiveAt)}. you keep your current allowances until then. no charge or credit today.`
              : `your new plan starts after payment is confirmed. estimated charge today: ${pricing.pendingAction.preview.chargeNow}.`}</p>
            <p>next payment: {pricing.pendingAction.preview.nextTotal} on {formatDate(pricing.pendingAction.preview.nextBilledAt)}. then {pricing.pendingAction.preview.recurringTotal} per {pricing.pendingAction.preview.billingInterval}.</p>
          </div>}
          <div className="flex flex-wrap gap-3">
            <button type="button" autoFocus aria-describedby="subscription-confirm-title" className={cn(buttonClass, "w-auto")} disabled={pricing.managing || pricing.syncing} onClick={() => void pricing.confirmAction()}>
              {pricing.managing ? "updating subscription…" : pricing.pendingAction === "cancel" ? "confirm cancellation" : "confirm plan change"}
            </button>
            <button type="button" className={cn(buttonClass, "w-auto")} disabled={pricing.managing || pricing.syncing} onClick={pricing.dismissAction}>keep current plan</button>
          </div>
        </section>}

        <div className="space-y-3 text-sm">
          <p role="status" className="text-zinc-300">{pricing.loading ? "loading prices…" : pricing.notice}</p>
          {pricing.billing?.status && pricing.billing.status !== "canceled" && pricing.billing.billingInterval !== pricing.billingInterval &&
            <p className="text-zinc-400">select your current billing frequency to change tiers. billing frequency changes are not available here.</p>}
          {user && pricing.billing?.status && pricing.billing.status !== "canceled" && pricing.billing.scheduledChange?.action !== "cancel" &&
            <button type="button" className={linkClass} onClick={pricing.requestCancellation}
              disabled={pricing.billingLoading || pricing.managing || pricing.syncing || Boolean(pricing.selectedPlan) || Boolean(pricing.pendingAction) || pricing.updatePending}>
              cancel subscription
            </button>}
          {pricing.error && <div className="space-y-2">
            <p role="alert" className="text-red-300">{pricing.error}</p>
            {pricing.pendingTransaction ? <button type="button" onClick={() => void pricing.confirmSubscription()} disabled={pricing.syncing || pricing.managing} className={linkClass}>check subscription</button>
              : <button type="button" onClick={pricing.retry} disabled={pricing.loading || pricing.billingLoading || pricing.managing} className={linkClass}>retry</button>}
          </div>}
        </div>

        <footer className="flex flex-wrap gap-x-6 text-xs text-zinc-400">
          <Link to="/" className={linkClass}>back to studio</Link>
          <Link to="/privacy" className={linkClass}>privacy</Link>
          <Link to="/terms" className={linkClass}>terms</Link>
        </footer>
      </div>
    </main>
  );
}
