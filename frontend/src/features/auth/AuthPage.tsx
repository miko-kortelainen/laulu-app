import { Link } from "react-router";
import type { useAuth } from "./useAuth";
import { Turnstile } from "./Turnstile";

type AuthPageProps = ReturnType<typeof useAuth>;
const inputClass = "mt-2 w-full rounded-lg border border-white/15 bg-zinc-900 px-3 py-2.5 text-base text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 disabled:opacity-50";
const buttonClass = "min-h-11 rounded-lg border border-white/15 px-4 py-2 text-sm font-medium hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300 disabled:cursor-not-allowed disabled:opacity-50";
const labels = { login: "log in", register: "create account", reset: "reset password", update: "save new password" };

export function AuthPage({ view, email, password, error, notice, busy, configured, setEmail, setPassword, changeView, submit, resend, logout, session,
  captchaRequired, captchaToken, captchaReset, setCaptchaToken }: AuthPageProps) {
  const verificationPending = captchaRequired && !captchaToken;
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md items-center px-5 py-10">
      <section className="w-full space-y-6 rounded-xl border border-white/10 bg-zinc-900/70 p-6" aria-labelledby="auth-title">
        <div>
          <p className="mb-2 text-sm text-zinc-400">Nemotron Copilot</p>
          <h1 id="auth-title" className="text-2xl font-semibold">{labels[view]}</h1>
          {view === "register" && <p className="mt-2 text-sm text-zinc-400">confirm your email to start using the app.</p>}
        </div>
        {!configured && <p role="alert" className="text-sm text-red-300">authentication is not configured. add the Supabase URL and publishable key to the frontend environment.</p>}
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }} aria-busy={busy}>
          {view !== "update" && (
            <label className="block text-sm" htmlFor="auth-email">
              email
              <input id="auth-email" name="email" type="email" autoComplete="email" required value={email}
                disabled={busy || !configured} onChange={(event) => setEmail(event.currentTarget.value)} className={inputClass} />
            </label>
          )}
          {view !== "reset" && (
            <div>
              <label className="block text-sm" htmlFor="auth-password">
                {view === "update" ? "new password" : "password"}
                <input id="auth-password" name="password" type="password" required minLength={view === "login" ? undefined : 8}
                  autoComplete={view === "login" ? "current-password" : "new-password"} value={password}
                  aria-describedby={view === "login" ? undefined : "password-requirements"}
                  disabled={busy || !configured} onChange={(event) => setPassword(event.currentTarget.value)} className={inputClass} />
              </label>
              {view !== "login" && <p id="password-requirements" className="mt-2 text-xs text-zinc-400">use at least 8 characters.</p>}
            </div>
          )}
          {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
          <p role="status" className="text-sm text-zinc-300">{notice}</p>
          {captchaRequired && <Turnstile key={`${view}-${captchaReset}`} onToken={setCaptchaToken} />}
          <button type="submit" disabled={busy || !configured || verificationPending} className={`${buttonClass} w-full bg-zinc-700/70`}>
            {busy ? "please wait..." : labels[view]}
          </button>
        </form>
        <div className="flex flex-wrap gap-2">
          {view === "login" && <>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => changeView("register")}>register</button>
            <button type="button" className={buttonClass} disabled={busy} onClick={() => changeView("reset")}>forgot password?</button>
          </>}
          {view !== "login" && view !== "update" && <button type="button" className={buttonClass} disabled={busy} onClick={() => changeView("login")}>back to login</button>}
          {view === "register" && notice && <button type="button" className={buttonClass} disabled={busy || !configured || !email.trim() || verificationPending} onClick={() => void resend()}>resend confirmation</button>}
          {view === "update" && session && <button type="button" className={buttonClass} disabled={busy} onClick={() => void logout()}>log out</button>}
        </div>
        <p className="text-xs text-zinc-400">
          <Link to="/privacy" className="inline-flex min-h-11 items-center rounded underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-300">privacy and beta limits</Link>
        </p>
      </section>
    </main>
  );
}
