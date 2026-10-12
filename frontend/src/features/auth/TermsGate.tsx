import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { clearTermsAcceptancePending, hasAcceptedTerms, hasTermsAcceptancePending, recordTermsAcceptance } from "@/lib/terms";

export function TermsGate({ userId, children }: { userId: string; children: ReactNode }) {
  const { pathname } = useLocation();
  const [status, setStatus] = useState<"checking" | "accepted" | "required" | "failed">("checking");
  const [error, setError] = useState<string>();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function check(): Promise<void> {
      const accepted = await hasAcceptedTerms(userId, controller.signal).catch((cause: unknown) =>
        cause instanceof Error ? cause : new Error("could not check terms acceptance. try again."));
      if (controller.signal.aborted) return;
      if (accepted instanceof Error) {
        setError(accepted.message);
        setStatus("failed");
        return;
      }
      if (accepted) {
        clearTermsAcceptancePending();
        setStatus("accepted");
        return;
      }
      if (!hasTermsAcceptancePending()) {
        setStatus("required");
        return;
      }
      // Registration already collected acceptance; record it now that a session exists.
      const recorded = await recordTermsAcceptance(userId).catch((cause: unknown) =>
        cause instanceof Error ? cause : new Error("could not record terms acceptance. try again."));
      if (controller.signal.aborted) return;
      if (recorded instanceof Error) {
        setError(recorded.message);
        setStatus("required");
        return;
      }
      clearTermsAcceptancePending();
      setStatus("accepted");
    }
    void check();
    return () => controller.abort();
  }, [userId, attempt]);

  if (pathname === "/terms" || pathname === "/privacy") return children;
  if (status === "accepted") return children;
  if (status === "checking") {
    return <main className="flex min-h-dvh items-center justify-center"><p role="status">checking terms acceptance...</p></main>;
  }
  if (status === "failed") {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md items-center px-5 py-10">
        <section className="w-full space-y-4" aria-labelledby="terms-gate-title">
          <h1 id="terms-gate-title" className="text-2xl font-semibold">terms of service</h1>
          <p role="alert" className="text-sm text-red-300">{error}</p>
          <button type="button" onClick={() => { setError(undefined); setStatus("checking"); setAttempt((value) => value + 1); }}
            className="inline-flex min-h-11 items-center justify-center rounded-sm border border-white/15 px-3 py-2 text-sm font-medium hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">
            try again
          </button>
        </section>
      </main>
    );
  }

  async function accept(): Promise<void> {
    if (!checked || busy) return;
    setBusy(true);
    setError(undefined);
    const recorded = await recordTermsAcceptance(userId).catch((cause: unknown) =>
      cause instanceof Error ? cause : new Error("could not record terms acceptance. try again."));
    setBusy(false);
    if (recorded instanceof Error) {
      setError(recorded.message);
      return;
    }
    clearTermsAcceptancePending();
    setStatus("accepted");
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md items-center px-5 py-10">
      <section className="w-full space-y-6" aria-labelledby="terms-gate-title">
        <div>
          <h1 id="terms-gate-title" className="text-2xl font-semibold">terms of service</h1>
          <p className="mt-2 text-sm text-zinc-400">accept the terms of service to continue to laulu. your acceptance is recorded with the terms version and time.</p>
        </div>
        <div className="flex min-h-8 items-center gap-3 text-sm text-zinc-300">
          <input id="terms-acceptance" name="termsAcceptance" type="checkbox" required checked={checked} disabled={busy}
            onChange={(event) => setChecked(event.currentTarget.checked)}
            className="size-5 shrink-0 accent-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300" />
          <label htmlFor="terms-acceptance" className="py-1">
            i accept the <Link to="/terms" className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">terms of service</Link>
          </label>
        </div>
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        <button type="button" disabled={!checked || busy} onClick={() => void accept()}
          className="inline-flex min-h-11 w-full items-center justify-center rounded-sm bg-white px-4 py-2.5 text-sm font-semibold text-black hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? "please wait..." : "accept and continue"}
        </button>
      </section>
    </main>
  );
}
