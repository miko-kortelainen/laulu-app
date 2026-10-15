import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { AudioDownload } from "@/components/ui/audio-download";
import { AudioPlayer } from "@/components/ui/audio-player";
import { MusicPromptFields } from "@/components/MusicPromptFields";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/date";
import { useSongs } from "./useSongs";
import { getSongPrompt } from "./songPrompt";

const buttonClass = "min-h-10 rounded-lg border border-white/10 px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50";
const infoClass = "w-full min-w-0 resize-y rounded-lg border border-white/15 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400";

export function SongsPage() {
  const { songs, loading, error, refresh, selectedSongId, openedSongIds, selectSong, pendingDeleteId, requestDelete, cancelDelete, deletingId, deleteError, removeSong,
    recoveryIds, savingId, saveError, saveSong } = useSongs();
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const busy = loading || deletingId !== undefined || savingId !== undefined;
  const selectedSong = songs?.find((song) => song.id === selectedSongId);
  const pendingDeleteSong = songs?.find((song) => song.id === pendingDeleteId);
  const songPrompt = selectedSong && getSongPrompt(selectedSong);

  useEffect(() => {
    if (pendingDeleteId) deleteDialogRef.current?.showModal();
    else deleteDialogRef.current?.close();
  }, [pendingDeleteId]);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto py-8 lg:flex-row lg:overflow-hidden">
      <section aria-labelledby="songs-title" className="max-h-[60dvh] min-h-0 min-w-0 shrink-0 space-y-6 overflow-y-auto lg:max-h-none lg:flex-1 lg:pr-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 ref={titleRef} id="songs-title" tabIndex={-1} className="text-2xl font-semibold">my songs</h1>
            <p className="mt-1 text-sm text-zinc-400">your latest 100 saved songs, newest first</p>
          </div>
          {error && <button type="button" onClick={refresh} disabled={busy} className={buttonClass}>
            try again
          </button>}
        </div>
        {loading && <p role="status" className="text-sm text-zinc-400">loading your songs...</p>}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        {recoveryIds.length > 0 && (
          <section aria-labelledby="unsaved-songs-title" className="space-y-4">
            <div>
              <h2 id="unsaved-songs-title" className="text-lg font-semibold">unsaved songs</h2>
              <p className="mt-1 text-sm text-zinc-400">retry saving these generated songs. this does not generate them again.</p>
            </div>
            <ul aria-label="unsaved songs" className="space-y-3">
              {recoveryIds.map((id, index) => (
                <li key={id} className="space-y-3 rounded-xl border border-white/10 bg-zinc-900/70 p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm">unsaved song {index + 1}</p>
                    <button type="button" disabled={busy} onClick={() => void saveSong(id)} className={buttonClass}>
                      {savingId === id ? "saving..." : "retry saving"}
                      <span className="sr-only"> unsaved song {index + 1}</span>
                    </button>
                  </div>
                  {saveError?.id === id && <p role="alert" className="text-sm text-red-300">{saveError.message}</p>}
                </li>
              ))}
            </ul>
          </section>
        )}
        {songs?.length === 0 && (
          <p className="text-sm text-zinc-400">no saved songs yet. <Link to="/" className="text-zinc-100 underline underline-offset-4">create a song in chat</Link></p>
        )}
        <ul aria-label="saved songs" className="space-y-4">
          {songs?.map((song) => (
            <li key={song.id} className={cn("space-y-4 rounded-xl border border-white/10 bg-zinc-900/70 p-5",
              selectedSongId === song.id && "border-white/30")}>
              <h2>
                <button type="button" aria-expanded={selectedSongId === song.id} aria-controls={`song-${song.id} song-info`}
                  aria-label={`${selectedSongId === song.id ? "close" : "listen"} ${song.title}`}
                  title={`${selectedSongId === song.id ? "close" : "listen"} ${song.title}`}
                  onClick={() => selectSong(song.id)}
                  className="flex min-h-10 w-full items-center justify-between gap-4 rounded-lg px-3 py-2 text-left hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400">
                  <span className="min-w-0">
                    <span className="block break-words font-medium">{song.title}</span>
                    <span className="mt-1 block break-words text-xs text-zinc-400">
                      <time dateTime={song.createdAt}>{formatDate(song.createdAt, true)}</time> · {song.model}
                    </span>
                  </span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true" className="size-5 shrink-0 text-zinc-400">
                    <path d={selectedSongId === song.id ? "m6 6 12 12M18 6 6 18" : "m9 5 11 7-11 7V5Z"} />
                  </svg>
                </button>
              </h2>
              <div id={`song-${song.id}`} hidden={selectedSongId !== song.id} className="space-y-3">
                {openedSongIds.includes(song.id) && <AudioPlayer src={song.url} label={song.title}
                  active={selectedSongId === song.id} className="w-full" />}
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <button type="button" disabled={busy} onClick={() => requestDelete(song.id)}
                  title={`delete ${song.title}`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 py-2 text-red-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50">
                  {deletingId === song.id ? (
                    <span aria-hidden="true" className="size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden="true" className="size-4">
                      <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
                    </svg>
                  )}
                  <span className="sr-only">{deletingId === song.id ? "deleting..." : "delete"} {song.title}</span>
                </button>
                <AudioDownload url={song.url} name={`song-${song.id}.mp3`} icon disabled={busy}>
                  {`download MP3 ${song.title}`}
                </AudioDownload>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <aside id="song-info" aria-labelledby="song-info-heading"
        className="min-h-0 min-w-0 space-y-4 border-t border-white/10 pt-4 lg:w-[26rem] lg:shrink-0 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:pl-6 lg:pr-2">
        <h2 id="song-info-heading" className="text-sm font-semibold">song details</h2>
        {selectedSong && songPrompt ? <>
          <MusicPromptFields readOnly prompt={songPrompt.prompt} model={selectedSong.model} title={selectedSong.title} />
          {songPrompt.originalPrompt && <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-zinc-400">original prompt</span>
            <textarea name="originalPrompt" readOnly value={songPrompt.originalPrompt} rows={8} className={infoClass} />
          </label>}
        </> : <p className="text-sm text-zinc-400">select a song to view its prompt and lyrics.</p>}
      </aside>
      <dialog ref={deleteDialogRef} aria-labelledby="delete-song-title" aria-describedby="delete-song-description"
        onCancel={(event) => { if (deletingId) event.preventDefault(); }}
        onClose={() => {
          cancelDelete();
          if (document.activeElement === document.body) titleRef.current?.focus();
        }}
        className="m-auto w-[calc(100%-2rem)] max-w-md space-y-4 overflow-y-auto overscroll-contain rounded-xl border border-white/15 bg-zinc-900 p-6 text-zinc-100 backdrop:bg-black/60">
        <h2 id="delete-song-title" className="text-lg font-semibold">delete song?</h2>
        <p id="delete-song-description" className="break-words text-sm text-zinc-400">delete “{pendingDeleteSong?.title}” permanently? this cannot be undone.</p>
        {deleteError && deleteError.id === pendingDeleteId && <p role="alert" className="text-sm text-red-300">{deleteError.message}</p>}
        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" autoFocus disabled={Boolean(deletingId)} onClick={cancelDelete} className={buttonClass}>cancel</button>
          <button type="button" disabled={Boolean(deletingId)} onClick={() => void removeSong()} className={cn(buttonClass, "border-red-300/20 text-red-300")}>
            {deletingId ? "deleting..." : "delete song"}
          </button>
        </div>
      </dialog>
    </main>
  );
}
