import { useAudioDownload } from "@/lib/use-audio-download";
import { cn } from "@/lib/utils";

export function AudioDownload({ url, name, children, icon = false, disabled = false }: {
  url: string; name: string; children: string; icon?: boolean; disabled?: boolean;
}) {
  const { download, busy, error } = useAudioDownload(url, name);
  return <>
    <button type="button" disabled={busy || disabled} onClick={() => void download()} title={icon ? children : undefined}
      className={cn("text-zinc-300 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50",
        icon ? "inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 py-2 hover:bg-white/5" : "min-h-8 text-xs underline underline-offset-4")}>
      {icon && (busy ? (
        <span aria-hidden="true" className="size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" className="size-4">
          <path d="M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4" />
        </svg>
      ))}
      <span className={icon ? "sr-only" : undefined}>{busy ? "downloading..." : children}</span>
    </button>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </>;
}
