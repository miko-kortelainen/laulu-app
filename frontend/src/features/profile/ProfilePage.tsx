import type { User } from "@supabase/supabase-js";
import { cn } from "@/lib/utils";
import type { Usage } from "@/lib/usage";

interface ProfilePageProps {
  user: User;
  onLogout: () => Promise<void>;
  signingOut: boolean;
  authError?: string;
  usage?: Usage;
  usageError?: string;
  loading: boolean;
  refreshUsage: () => Promise<void>;
}

function formatDate(value?: string): string {
  if (!value) return "not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "not available" : date.toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
}

export function ProfilePage({ user, onLogout, signingOut, authError, usage, usageError, loading, refreshUsage }: ProfilePageProps) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto py-8">
      <section aria-labelledby="profile-title" className="mx-auto max-w-lg space-y-6 rounded-xl border border-white/10 bg-zinc-900/70 p-6">
        <h1 id="profile-title" className="text-2xl font-semibold">my profile</h1>
        <dl className="space-y-5 text-sm">
          {[
            ["email", user.email ?? "not available"],
            ["email status", user.email_confirmed_at ? "confirmed" : "not confirmed"],
            ["member since", formatDate(user.created_at)],
            ["last sign-in", formatDate(user.last_sign_in_at)],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-zinc-400">{label}</dt>
              <dd className={cn("mt-1", label === "email" && "break-all")}>{value}</dd>
            </div>
          ))}
        </dl>
        <section aria-labelledby="allowances-heading" className="space-y-2 border-t border-white/10 pt-4 text-xs text-zinc-400">
          <h2 id="allowances-heading" className="font-medium text-zinc-300">daily allowances</h2>
          {usage ? <>
            <dl className="space-y-1 tabular-nums">
              {([
                ["chat messages", usage.chat], ["songs", usage.generation], ["audio analyses", usage.analysis],
              ] as const).map(([label, allowance]) => (
                <div key={label} className="flex justify-between gap-3">
                  <dt>{label}</dt><dd>{allowance.remaining} / {allowance.limit} remaining</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3"><dt>saved-song space</dt><dd>{Math.floor(usage.storage.remaining / 1024 / 1024)} MiB remaining</dd></div>
            </dl>
            <p>resets <time dateTime={usage.resetAt}>{new Date(usage.resetAt).toLocaleString()}</time></p>
            <p>pending songs reserve allowance. shared daily limits also apply.</p>
          </> : !usageError && <p>loading allowances...</p>}
          {usageError && <div className="space-y-1">
            <p role="alert" className="text-red-400">{usageError} {usage && "shown allowances may be out of date."}</p>
            <button type="button" disabled={loading} onClick={() => void refreshUsage()}
              className="rounded underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50">retry allowances</button>
          </div>}
        </section>
        <button type="button" disabled={signingOut} onClick={() => void onLogout()}
          className="min-h-11 rounded-lg border border-white/10 px-3 py-1.5 text-xs hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50">
          {signingOut ? "logging out..." : "log out"}
        </button>
        {authError && <p role="alert" className="text-xs text-red-300">{authError}</p>}
      </section>
    </main>
  );
}
