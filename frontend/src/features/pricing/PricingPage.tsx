import type { User } from "@supabase/supabase-js";
import { Link } from "react-router";
import { LauluWordmark } from "@/components/ui/LauluWordmark";
import { cn } from "@/lib/utils";
import { paidPlans, type PlanLimits } from "./api";
import { usePricing } from "./usePricing";

const buttonClass = "inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-white/15 px-4 py-2 text-sm font-medium hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-50";
const linkClass = "inline-flex min-h-11 items-center rounded-lg underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300";

function Allowances({ limits }: { limits?: PlanLimits }) {
  if (!limits) return <li>allowances unavailable</li>;
  const storage = limits.storage_bytes / 1024 / 1024;
  return <>
    <li><strong className="font-semibold text-zinc-100">{limits.plan === "free" ? limits.songs_daily : limits.songs_monthly} songs</strong> {limits.plan === "free" ? "per UTC day" : "per billing month"}</li>
    <li>{limits.chat_daily} chat messages per UTC day</li>
    <li>{limits.plan === "free" ? limits.lyrics_daily : limits.lyrics_monthly} lyric requests {limits.plan === "free" ? "per UTC day" : "per billing month"}</li>
    <li>{limits.analysis_daily} audio analyses per UTC day</li>
    <li>{storage >= 1024 ? `${storage / 1024} GiB` : `${storage} MiB`} of saved-song storage</li>
    <li>save and download your songs</li>
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
            const price = pricing.prices?.[plan.priceId];
            return (
              <section key={plan.name} aria-labelledby={`plan-${plan.name}`} className={cn(
                "flex flex-col rounded-xl border bg-zinc-900/60 p-6",
                featured ? "border-amber-200/50 bg-amber-200/[0.04]" : "border-white/10",
              )}>
                <p className={cn("mb-4 text-xs", featured ? "text-amber-200" : "text-zinc-400")}>{featured ? "recommended" : "monthly plan"}</p>
                <h2 id={`plan-${plan.name}`} className="text-lg font-semibold">{plan.name}</h2>
                <p className="mt-1 text-sm text-zinc-400">{plan.description}</p>
                <p className="mt-6 break-words text-4xl font-semibold tabular-nums">{price ?? (pricing.loading ? "…" : "unavailable")}</p>
                <p className="mt-2 text-xs text-zinc-400">per month · billed monthly</p>
                <ul className="my-8 flex-1 space-y-3 text-sm text-zinc-300">
                  <Allowances limits={pricing.limits?.find(limits => limits.plan === plan.name)} />
                </ul>
                {user ? <button type="button" disabled={pricing.loading || !pricing.limitsReady || pricing.billingLoading || !pricing.billing || !price || Boolean(pricing.selectedPlan) || pricing.syncing || Boolean(pricing.billing.status && pricing.billing.status !== "canceled")}
                  onClick={() => void pricing.checkout(plan)} className={cn(buttonClass, featured && "border-transparent bg-amber-200 text-zinc-950 hover:bg-amber-100")}>
                  {pricing.selectedPlan === plan.name ? "opening checkout…" : pricing.billing?.plan === plan.name && pricing.billing.paidAccess ? "current plan" : `choose ${plan.name}`}
                </button> : <Link to="/login" state={{ from: "/pricing" }} className={cn(buttonClass, featured && "border-transparent bg-amber-200 text-zinc-950 hover:bg-amber-100")}>
                  {`log in to choose ${plan.name}`}
                </Link>}
              </section>
            );
          })}
        </div>

        <div className="space-y-3 text-sm">
          <p role="status" className="text-zinc-300">{pricing.loading ? "loading local prices…" : pricing.notice}</p>
          {pricing.billing?.status && <p className="text-zinc-300">
            {pricing.billing.plan ?? "subscription"} · {pricing.billing.status}
            {!pricing.billing.paidAccess && " · free allowance applies"}
            {pricing.billing.scheduledChange && ` · ${pricing.billing.scheduledChange.action} scheduled for ${new Date(pricing.billing.scheduledChange.effectiveAt).toLocaleString()}`}
          </p>}
          {pricing.error && <div className="space-y-2">
            <p role="alert" className="text-red-300">{pricing.error}</p>
            {pricing.pendingTransaction ? <button type="button" onClick={() => void pricing.confirmSubscription()} disabled={pricing.syncing} className={linkClass}>check subscription</button>
              : <button type="button" onClick={pricing.retry} disabled={pricing.loading || pricing.billingLoading} className={linkClass}>retry</button>}
          </div>}
          <p className="max-w-2xl text-xs leading-relaxed text-zinc-400">prices include applicable tax for your detected location. checkout confirms the total for your billing address. each generated version counts as one song.</p>
          <p className="max-w-2xl text-xs leading-relaxed text-zinc-400">unused songs and lyric requests do not roll over. chat and audio analysis reset at midnight UTC. shared daily limits apply to all plans.</p>
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
