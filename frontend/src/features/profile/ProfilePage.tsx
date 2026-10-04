import type { User } from "@supabase/supabase-js";
import { cn } from "@/lib/utils";

function formatDate(value?: string): string {
  if (!value) return "not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "not available" : date.toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
}

export function ProfilePage({ user }: { user: User }) {
  return (
    <main className="min-h-0 flex-1 overflow-y-auto py-8">
      <section aria-labelledby="profile-title" className="mx-auto max-w-lg space-y-6 rounded-xl border border-white/10 bg-zinc-900/70 p-6">
        <h1 id="profile-title" className="text-2xl font-semibold">profile</h1>
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
      </section>
    </main>
  );
}
