import { useEffect, useRef, useState } from "react";
import { deleteSavedSong, getSongs, type SavedSong } from "./api";

export function useSongs() {
  const [songs, setSongs] = useState<SavedSong[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [request, setRequest] = useState(0);
  const [selectedSongId, setSelectedSongId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [deleteError, setDeleteError] = useState<{ id: string; message: string }>();
  const deleting = useRef(false);
  const currentRequest = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    currentRequest.current = controller;
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
    if (loading || deleting.current) return;
    setLoading(true);
    setError(undefined);
    setRequest((previous) => previous + 1);
  }

  function selectSong(id: string): void {
    setSelectedSongId((previous) => previous === id ? undefined : id);
  }

  async function removeSong(id: string): Promise<void> {
    if (loading || deleting.current || !window.confirm("delete this song permanently? this cannot be undone.")) return;
    const signal = currentRequest.current!.signal;
    deleting.current = true;
    setDeletingId(id);
    setDeleteError(undefined);
    const failure = await deleteSavedSong(id, signal).catch((cause: unknown) =>
      new Error(cause instanceof Error ? cause.message : "could not delete the song. try deleting again."));
    if (signal.aborted) return;
    if (failure) setDeleteError({ id, message: failure.message });
    else {
      setSongs((previous) => previous?.filter((song) => song.id !== id));
      setSelectedSongId((previous) => previous === id ? undefined : previous);
    }
    deleting.current = false;
    setDeletingId(undefined);
  }

  return { songs, loading, error, refresh, selectedSongId, selectSong, deletingId, deleteError, removeSong };
}
