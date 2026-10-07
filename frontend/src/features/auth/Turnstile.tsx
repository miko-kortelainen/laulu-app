import { useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render(container: HTMLElement, options: {
    sitekey: string;
    theme: "dark";
    size: "compact";
    callback(token: string): void;
    "expired-callback"(): void;
    "error-callback"(): void;
  }): string;
  remove(id: string): void;
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

export function Turnstile({ onToken }: { onToken: (token: string | undefined) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let widgetId: string | undefined;
    let active = true;
    let script = document.querySelector<HTMLScriptElement>("#turnstile-script");
    function fail(): void {
      if (!active) return;
      onToken(undefined);
      setError("verification could not finish. try again.");
      if (!window.turnstile) script?.remove();
    }
    function render(): void {
      if (!active || !container.current || !window.turnstile) return;
      widgetId = window.turnstile.render(container.current, {
        sitekey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
        theme: "dark", size: "compact",
        callback: (token) => { if (active) { setError(undefined); onToken(token); } },
        "expired-callback": () => { if (active) onToken(undefined); },
        "error-callback": fail,
      });
    }
    if (window.turnstile) render();
    else {
      if (!script) {
        script = document.createElement("script");
        script.id = "turnstile-script";
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        document.head.append(script);
      }
      script.addEventListener("load", render);
      script.addEventListener("error", fail);
    }
    const timeout = window.setTimeout(() => { if (widgetId === undefined) fail(); }, 15_000);
    return () => {
      active = false;
      window.clearTimeout(timeout);
      script?.removeEventListener("load", render);
      script?.removeEventListener("error", fail);
      if (widgetId !== undefined) window.turnstile?.remove(widgetId);
    };
  }, [attempt, onToken]);

  return (
    <div className="space-y-2">
      <div ref={container} className="flex justify-center" aria-label="human verification" />
      {error && <>
        <p role="alert" className="text-sm text-red-300">{error}</p>
        <button type="button" onClick={() => { setError(undefined); setAttempt((previous) => previous + 1); }}
          className="min-h-11 text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2">
          retry verification
        </button>
      </>}
    </div>
  );
}
