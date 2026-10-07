import { useEffect, useRef, useState } from "react";
import { deleteSavedSong, getSongRecovery, getSongs, retrySongStorage, type SavedSong } from "./api";

export function useSongs() {
  const [songs, setSongs] = useState<SavedSong[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [request, setRequest] = useState(0);
  const [selectedSongId, setSelectedSongId] = useState<string>();
  const [deletingId, setDeletingId] = useState<string>();
  const [deleteError, setDeleteError] = useState<{ id: string; message: string }>();
  const [recoveryIds, setRecoveryIds] = useState<string[]>([]);
  const [savingId, setSavingId] = useState<string>();
  const [saveError, setSaveError] = useState<{ id: string; message: string }>();
  const acting = useRef(false);
  const currentRequest = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    currentRequest.current = controller;
    async function load(): Promise<void> {
      const [result, recovery] = await Promise.all([
        getSongs(controller.signal).catch((cause: unknown) =>
          new Error(cause instanceof Error ? cause.message : "could not load your songs. try again.")),
        getSongRecovery(controller.signal).catch((cause: unknown) =>
          new Error(cause instanceof Error ? cause.message : "could not load unsaved songs. try again.")),
      ]);
      if (controller.signal.aborted) return;
      if (result instanceof Error) setError(result.message);
      else setSongs(result);
      if (recovery instanceof Error) setError(recovery.message);
      else setRecoveryIds(recovery);
      setLoading(false);
    }
    void load();
    return () => controller.abort();
  }, [request]);

  function refresh(): void {
    if (loading || acting.current) return;
    setLoading(true);
    setError(undefined);
    setRequest((previous) => previous + 1);
  }

  function selectSong(id: string): void {
    setSelectedSongId((previous) => previous === id ? undefined : id);
  }

  async function removeSong(id: string): Promise<void> {
    if (loading || acting.current || !window.confirm("delete this song permanently? this cannot be undone.")) return;
    const signal = currentRequest.current!.signal;
    acting.current = true;
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
    acting.current = false;
    setDeletingId(undefined);
  }

  async function saveSong(id: string): Promise<void> {
    if (loading || acting.current) return;
    const signal = currentRequest.current!.signal;
    acting.current = true;
    setSavingId(id);
    setSaveError(undefined);
    const result = await retrySongStorage(id, signal).catch((cause: unknown) =>
      new Error(cause instanceof Error ? cause.message : "could not save the song. try saving again."));
    if (signal.aborted) return;
    if (result instanceof Error) setSaveError({ id, message: result.message });
    else {
      setRecoveryIds((previous) => previous.filter((songId) => songId !== id));
      setSongs((previous) => [result, ...(previous ?? []).filter((song) => song.id !== id)]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 100));
    }
    acting.current = false;
    setSavingId(undefined);
  }

  return { songs, loading, error, refresh, selectedSongId, selectSong, deletingId, deleteError, removeSong,
    recoveryIds, savingId, saveError, saveSong };
}
