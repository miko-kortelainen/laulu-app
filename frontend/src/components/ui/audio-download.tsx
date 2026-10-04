import { useAudioDownload } from "@/lib/use-audio-download";

export function AudioDownload({ url, name, children }: { url: string; name: string; children: string }) {
  const { download, busy, error } = useAudioDownload(url, name);
  return <>
    <button type="button" disabled={busy} onClick={() => void download()}
      className="min-h-8 text-xs text-zinc-300 underline underline-offset-4 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50">
      {busy ? "downloading..." : children}
    </button>
    {error && <p role="alert" className="text-xs text-red-300">{error}</p>}
  </>;
}
