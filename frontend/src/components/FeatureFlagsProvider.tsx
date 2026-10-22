import { useEffect, useState, type ReactNode } from "react";
import { getPaidTiersEnabled, PaidTiersContext } from "@/lib/feature-flags";

export function FeatureFlagsProvider({ children }: { children: ReactNode }) {
  const [paidTiersEnabled, setPaidTiersEnabled] = useState<boolean>();

  useEffect(() => {
    const controller = new AbortController();

    async function refresh(): Promise<void> {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      const enabled = await getPaidTiersEnabled(signal).catch(() => false);
      if (!controller.signal.aborted) setPaidTiersEnabled(enabled);
    }

    void refresh();
    const interval = window.setInterval(() => void refresh(), 60_000);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  return <PaidTiersContext value={paidTiersEnabled}>{children}</PaidTiersContext>;
}
