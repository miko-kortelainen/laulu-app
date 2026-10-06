import { useEffect, useState } from "react";
import { getSongs, type SavedSong } from "./api";

export function useSongs() {
  const [songs, setSongs] = useState<SavedSong[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [request, setRequest] = useState(0);
  const [selectedSongId, setSelectedSongId] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    async function load(): Promise<void> {
      const result = await getSongs(controller.signal).catch((cause: unknown) =>
        new Error(cause instanceof Error ? cause.message : "could not load your songs. try again."));
      if (controller.signal.aborted) return;
      if (result instanceof Error) setError(result.message);
      else setSongs(result);
      setLoading(false);
    }
    void load();
    return () => controller.abort();
  }, [request]);

  function refresh(): void {
    setLoading(true);
    setError(undefined);
    setRequest((previous) => previous + 1);
  }

  function selectSong(id: string): void {
    setSelectedSongId((previous) => previous === id ? undefined : id);
  }

  return { songs, loading, error, refresh, selectedSongId, selectSong };
}
