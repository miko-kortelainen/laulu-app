import { Link } from "react-router";
import { AudioDownload } from "@/components/ui/audio-download";
import { AudioPlayer } from "@/components/ui/audio-player";
import { MusicPromptFields } from "@/components/ui/music-prompt-fields";
import { cn } from "@/lib/utils";
import { useSongs } from "./useSongs";
import { getSongPrompt } from "./songPrompt";

const buttonClass = "min-h-10 rounded-lg border border-white/10 px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50";
const infoClass = "w-full min-w-0 resize-y rounded-lg border border-white/15 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400";

export function SongsPage() {
  const { songs, loading, error, refresh, selectedSongId, selectSong, deletingId, deleteError, removeSong,
    recoveryIds, savingId, saveError, saveSong } = useSongs();
  const busy = loading || deletingId !== undefined || savingId !== undefined;
  const selectedSong = songs?.find((song) => song.id === selectedSongId);
  const songPrompt = selectedSong && getSongPrompt(selectedSong);

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-y-auto py-8 lg:flex-row lg:overflow-hidden">
      <section aria-labelledby="songs-title" className="max-h-[60dvh] min-h-0 min-w-0 shrink-0 space-y-6 overflow-y-auto lg:max-h-none lg:flex-1 lg:pr-2">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 id="songs-title" className="text-2xl font-semibold">my songs</h1>
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
          {songs?.map((song, index) => (
            <li key={song.id} className={cn("space-y-4 rounded-xl border border-white/10 bg-zinc-900/70 p-5",
              selectedSongId === song.id && "border-white/30")}>
              <h2>
                <button type="button" aria-expanded={selectedSongId === song.id} aria-controls={`song-${song.id} song-info`}
                  aria-label={`${selectedSongId === song.id ? "close" : "listen"} song ${index + 1}`}
                  title={`${selectedSongId === song.id ? "close" : "listen"} song ${index + 1}`}
                  onClick={() => selectSong(song.id)}
                  className="flex min-h-10 w-full items-center justify-between gap-4 rounded-lg px-3 py-2 text-left hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400">
                  <span className="min-w-0">
                    <span className="block font-medium">song {index + 1}</span>
                    <span className="mt-1 block break-words text-xs text-zinc-400">
                      <time dateTime={song.createdAt}>{new Date(song.createdAt).toLocaleString()}</time> · {song.model}
                    </span>
                  </span>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    aria-hidden="true" className="size-5 shrink-0 text-zinc-400">
                    <path d={selectedSongId === song.id ? "m6 6 12 12M18 6 6 18" : "m9 5 11 7-11 7V5Z"} />
                  </svg>
                </button>
              </h2>
              <div id={`song-${song.id}`} hidden={selectedSongId !== song.id} className="space-y-3">
                {selectedSongId === song.id && <AudioPlayer src={song.url} label={`song ${index + 1}`} className="w-full" />}
              </div>
              <div className="flex flex-wrap items-start gap-2">
                <button type="button" disabled={busy} onClick={() => void removeSong(song.id)}
                  title={`delete song ${index + 1}`} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg px-3 py-2 text-red-300 hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50">
                  {deletingId === song.id ? (
                    <span aria-hidden="true" className="size-4 rounded-full border-2 border-current border-t-transparent motion-safe:animate-spin" />
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                      aria-hidden="true" className="size-4">
                      <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
                    </svg>
                  )}
                  <span className="sr-only">{deletingId === song.id ? "deleting..." : "delete"} song {index + 1}</span>
                </button>
                <AudioDownload url={song.url} name={`song-${song.id}.mp3`} icon disabled={busy}>
                  {`download MP3 song ${index + 1}`}
                </AudioDownload>
              </div>
              {deleteError?.id === song.id && <p role="alert" className="text-sm text-red-300">{deleteError.message}</p>}
            </li>
          ))}
        </ul>
      </section>
      <aside id="song-info" aria-labelledby="song-info-heading"
        className="min-h-0 min-w-0 space-y-4 border-t border-white/10 pt-4 lg:w-[26rem] lg:shrink-0 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:pl-6 lg:pr-2">
        <h2 id="song-info-heading" className="text-sm font-semibold">song details</h2>
        {selectedSong && songPrompt ? <>
          <MusicPromptFields readOnly prompt={songPrompt.prompt} model={selectedSong.model} />
          {songPrompt.originalPrompt && <label className="flex min-w-0 flex-col gap-1">
            <span className="text-xs text-zinc-400">original prompt</span>
            <textarea name="originalPrompt" readOnly value={songPrompt.originalPrompt} rows={8} className={infoClass} />
          </label>}
        </> : <p className="text-sm text-zinc-400">select a song to view its prompt and lyrics.</p>}
      </aside>
    </main>
  );
}
