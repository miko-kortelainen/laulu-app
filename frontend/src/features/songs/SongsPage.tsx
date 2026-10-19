import { useEffect, useId, useRef } from "react";
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
  const { songs, visibleSongs, activeTab, selectTab, favouritingId, favouriteError, toggleFavourite,
    loading, loadingMore, hasMore, pageError, loadMore, error, refresh,
    selectedSongId, selectSong, pendingDeleteId, requestDelete, cancelDelete, deletingId, deleteError, removeSong,
    recoveryIds, savingId, saveError, saveSong } = useSongs();
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const favouriteGradientId = useId();
  const actionPending = loadingMore || deletingId !== undefined || savingId !== undefined || favouritingId !== undefined;
  const busy = loading || actionPending;
  const selectedSong = visibleSongs?.find((song) => song.id === selectedSongId);
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
            <p className="mt-1 text-sm text-zinc-400">your saved songs, newest first</p>
          </div>
          {error && <button type="button" onClick={refresh} disabled={busy} className={buttonClass}>
            try again
          </button>}
        </div>
        <div role="tablist" aria-label="song filters" className="flex gap-4 border-b border-white/10"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
            const next = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs[1] : tabs.find((tab) => tab.getAttribute("aria-selected") === "false");
            next?.focus();
            next?.click();
          }}>
          {(["all songs", "favourites"] as const).map((tab) => (
            <button key={tab} id={tab === "all songs" ? "all-songs-tab" : "favourites-tab"} type="button" role="tab"
              aria-selected={activeTab === tab} aria-controls="songs-panel" tabIndex={activeTab === tab ? 0 : -1}
              disabled={actionPending} onClick={() => selectTab(tab)}
              className="min-h-11 border-b-2 border-transparent px-3 py-2 text-sm text-zinc-400 aria-selected:border-zinc-100 aria-selected:text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50">
              {tab}
            </button>
          ))}
        </div>
        {loading && <p role="status" className="text-sm text-zinc-400">loading your songs...</p>}
        {error && <p role="alert" className="text-sm text-red-300">{error}</p>}
        {activeTab === "all songs" && recoveryIds.length > 0 && (
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
        <div id="songs-panel" role="tabpanel" aria-labelledby={activeTab === "all songs" ? "all-songs-tab" : "favourites-tab"} tabIndex={0}
          className="space-y-4 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400">
          {!loading && visibleSongs?.length === 0 && (activeTab === "favourites" ? (
            <p className="text-sm text-zinc-400">no favourites yet. use the heart to add a song.</p>
          ) : (
            <p className="text-sm text-zinc-400">no saved songs yet. <Link to="/" className="text-zinc-100 underline underline-offset-4">create a song in chat</Link></p>
          ))}
          <ul aria-label="saved songs" className="space-y-4">
            {visibleSongs?.map((song) => (
              <li key={song.id} data-selected={selectedSongId === song.id}
                className={cn("song-gradient-border relative space-y-4 rounded-xl border bg-white/10 p-5",
                "bg-linear-to-b from-white/2 to-black/8 shadow-[inset_0_1px_0_rgb(255_255_255/0.03),inset_0_-8px_16px_-8px_rgb(0_0_0/0.2)]",
                selectedSongId === song.id ? "border-transparent" : "border-white/10")}>
                <div className="flex items-start gap-3">
                  <h2 className="min-w-0 flex-1">
                    <button type="button" aria-pressed={selectedSongId === song.id} aria-controls="song-info"
                      aria-label={`song details: ${song.title}`} title="song details"
                      onClick={() => selectSong(song.id)}
                      className="flex min-h-10 w-full cursor-pointer items-center justify-between gap-4 rounded-lg text-left after:absolute after:inset-0 after:rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400">
                      <span className="min-w-0">
                        <span className="block break-words font-medium">{song.title}</span>
                        <span className="mt-1 block break-words text-xs text-zinc-400">
                          <time dateTime={song.createdAt}>{formatDate(song.createdAt, true)}</time> · {song.model}
                        </span>
                      </span>
                    </button>
                  </h2>
                  <div className="flex w-36 shrink-0 flex-wrap items-start justify-end gap-1 [&>button]:relative [&>button]:z-10 [&>p]:order-last [&>p]:basis-full">
                    <button type="button" aria-label={`favourite ${song.title}`} aria-pressed={song.isFavourite}
                      aria-busy={favouritingId === song.id} disabled={busy} onClick={() => void toggleFavourite(song.id)}
                      title={song.isFavourite ? "remove from favourites" : "add to favourites"}
                      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 py-2 text-zinc-400 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50">
                      {favouritingId === song.id ? (
                        <span aria-hidden="true" className="size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />
                      ) : (
                        <svg viewBox="0 0 24 24" fill={song.isFavourite ? `url(#${favouriteGradientId}-${song.id})` : "none"}
                          stroke={song.isFavourite ? `url(#${favouriteGradientId}-${song.id})` : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                          aria-hidden="true" className="size-4">
                          <defs>
                            <linearGradient id={`${favouriteGradientId}-${song.id}`} x1="0%" y1="0%" x2="100%" y2="0%">
                              <stop offset="0%" stopColor="#f87171" />
                              <stop offset="33%" stopColor="#fb923c" />
                              <stop offset="67%" stopColor="#fde047" />
                              <stop offset="100%" stopColor="#4ade80" />
                            </linearGradient>
                          </defs>
                          <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78Z" />
                        </svg>
                      )}
                    </button>
                    <AudioDownload url={song.url} name={`song-${song.id}.mp3`} icon disabled={busy}>
                      {`download MP3 ${song.title}`}
                    </AudioDownload>
                    <button type="button" disabled={busy} onClick={() => requestDelete(song.id)}
                      title={`delete ${song.title}`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 py-2 text-[#f87171] hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50">
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
                  </div>
                </div>
                <AudioPlayer src={song.url} label={song.title} className="relative z-10 w-full rounded-none bg-transparent p-0" />
                {favouriteError?.id === song.id && <p role="alert" className="text-sm text-red-300">{favouriteError.message}</p>}
              </li>
            ))}
          </ul>
          {!loading && songs && songs.length > 0 && <div className="space-y-3">
            <button type="button" disabled={busy || !hasMore} onClick={() => void loadMore()}
              aria-controls="songs-panel" className={cn(buttonClass, "w-full")}>
              {loadingMore ? "loading more songs..." : hasMore ? "show more" : "end of list"}
            </button>
            <p role="status" className="text-sm text-zinc-400">songs shown: {visibleSongs?.length}</p>
          </div>}
          {pageError && <p role="alert" className="text-sm text-red-300">{pageError}</p>}
        </div>
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
