import { Link } from "react-router";
import { LauluWordmark } from "@/components/ui/LauluWordmark";
import type { useAuth } from "./useAuth";
import { Turnstile } from "./Turnstile";

type AuthPageProps = ReturnType<typeof useAuth>;
const inputClass = "mt-1 w-full bg-transparent px-0 text-base text-zinc-100 placeholder:text-zinc-500 focus-visible:outline-none disabled:opacity-50";
const fieldClass = "block px-3 py-2 text-sm text-zinc-300 focus-within:bg-white/[0.04] focus-within:shadow-[inset_0_0_0_1px_rgb(255_255_255/0.45)]";
const buttonClass = "inline-flex min-h-11 items-center justify-center rounded-sm border border-white/15 px-3 py-2 text-center text-sm font-medium hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50";
const labels = { login: "log in", register: "create account", reset: "reset password", update: "save new password" };

export function AuthPage({ view, email, password, error, notice, busy, configured, setEmail, setPassword, changeView, submit, resend, logout, session,
  captchaRequired, captchaToken, captchaReset, setCaptchaToken, termsAccepted, setTermsAccepted }: AuthPageProps) {
  const verificationPending = captchaRequired && !captchaToken;
  return (
    <main className="relative flex min-h-dvh w-full flex-col items-center justify-center gap-8 overflow-hidden px-5 py-10">
      <LauluWordmark className="relative w-full max-w-md" />

      <section className="relative w-full max-w-md overflow-hidden rounded-md border border-white/10 bg-zinc-950/85 shadow-xl shadow-black/30" aria-label={labels[view]}>
        <form className="px-6 pt-8 sm:px-8" onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={busy}>
          {!configured && <p role="alert" className="mb-6 text-sm text-red-300">authentication is not configured. add the Supabase URL and publishable key to the frontend environment.</p>}
          <div className="divide-y divide-white/10 overflow-hidden rounded-sm border border-white/12 bg-zinc-900/80 focus-within:border-white/25">
            {view !== "update" && (
              <label className={fieldClass} htmlFor="auth-email">
                email
                <input id="auth-email" name="email" type="email" autoComplete="email" required value={email}
                  disabled={busy || !configured} onChange={(event) => setEmail(event.currentTarget.value)} className={inputClass} />
              </label>
            )}
            {view !== "reset" && (
              <div>
                <label className={fieldClass} htmlFor="auth-password">
                  {view === "update" ? "new password" : "password"}
                  <input id="auth-password" name="password" type="password" required minLength={view === "login" ? undefined : 8}
                    autoComplete={view === "login" ? "current-password" : "new-password"} value={password}
                    aria-describedby={view === "update" ? "password-requirements" : undefined}
                    disabled={busy || !configured} onChange={(event) => setPassword(event.currentTarget.value)} className={inputClass} />
                </label>
                {view === "update" && <p id="password-requirements" className="border-t border-white/10 px-4 py-2 text-xs text-zinc-400">use at least 8 characters.</p>}
              </div>
            )}
          </div>

          {view === "register" && (
            <div className="mt-2 flex min-h-8 items-center gap-3 text-sm text-zinc-300">
              <input id="auth-terms" name="termsAccepted" type="checkbox" required checked={termsAccepted}
                disabled={busy || !configured} onChange={(event) => setTermsAccepted(event.currentTarget.checked)}
                className="size-5 shrink-0 accent-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300" />
              <label htmlFor="auth-terms" className="py-1">
                i accept the <Link to="/terms" target="_blank" rel="noopener noreferrer"
                  className="underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">terms of service<span className="sr-only"> (opens in a new tab)</span></Link>
              </label>
            </div>
          )}

          {view === "login" && <button type="button" disabled={busy} onClick={() => changeView("reset")}
            className="flex min-h-8 w-fit items-center text-xs text-zinc-400 underline underline-offset-4 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 disabled:cursor-not-allowed disabled:opacity-50">forgot password?</button>}

          {error && <p role="alert" className="mt-4 text-sm text-red-300">{error}</p>}
          <p role="status" className="mt-4 text-sm text-zinc-300 empty:mt-0">{notice}</p>
          {captchaRequired && <div className="mt-2"><Turnstile key={`${view}-${captchaReset}`} onToken={setCaptchaToken} /></div>}
          <button type="submit" disabled={busy || !configured || verificationPending} className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-sm bg-white px-4 py-2.5 text-center text-sm font-semibold text-black hover:bg-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? "please wait..." : labels[view]}
          </button>
        </form>

        <div className="mt-6 border-t border-white/10 bg-white/[0.03] px-6 py-6 sm:px-8">
          <div className="grid gap-3 sm:auto-cols-fr sm:grid-flow-col">
            {view === "login" && <Link to="/create-account" className={buttonClass} aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); else changeView("login"); }}>create account</Link>}
            {view !== "login" && view !== "update" && <Link to="/login" className={buttonClass} aria-disabled={busy} onClick={(event) => { if (busy) event.preventDefault(); else changeView("login"); }}>back to login</Link>}
            {view === "register" && notice && <button type="button" className={buttonClass} disabled={busy || !configured || !email.trim() || verificationPending} onClick={() => void resend()}>resend confirmation</button>}
            {view === "update" && session && <button type="button" className={buttonClass} disabled={busy} onClick={() => void logout()}>log out</button>}
          </div>
          <p className="mt-3 flex flex-wrap items-center justify-center gap-x-4 text-center text-xs text-zinc-400">
            <Link to="/privacy" className="inline-flex min-h-11 items-center justify-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">privacy and beta limits</Link>
            <Link to="/terms" className="inline-flex min-h-11 items-center justify-center rounded-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">terms of service</Link>
          </p>
        </div>
      </section>
    </main>
  );
}
