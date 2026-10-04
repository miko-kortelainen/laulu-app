import { useRef, useState } from "react";
import { downloadAudio } from "./api";

export function useAudioDownload(url: string, name: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);

  async function download(): Promise<void> {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    await downloadAudio(url, name).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "could not download audio. try again.");
    });
    pending.current = false;
    setBusy(false);
  }

  return { download, busy, error };
}
