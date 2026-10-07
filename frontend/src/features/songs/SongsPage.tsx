import { Link } from "react-router";
import { AudioDownload } from "@/components/ui/audio-download";
import { AudioPlayer } from "@/components/ui/audio-player";
import { cn } from "@/lib/utils";
import { useSongs } from "./useSongs";

const buttonClass = "min-h-10 rounded-lg border border-white/10 px-3 py-2 text-sm hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:opacity-50";

export function SongsPage() {
  const { songs, loading, error, refresh, selectedSongId, selectSong, deletingId, deleteError, removeSong,
    recoveryIds, savingId, saveError, saveSong } = useSongs();
  const busy = loading || deletingId !== undefined || savingId !== undefined;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto py-8">
      <section aria-labelledby="songs-title" className="mx-auto max-w-2xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 id="songs-title" className="text-2xl font-semibold">my songs</h1>
            <p className="mt-1 text-sm text-zinc-400">your latest 100 saved songs, newest first</p>
          </div>
          <button type="button" onClick={refresh} disabled={busy} className={buttonClass}>
            {error ? "try again" : "refresh"}
          </button>
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
            <li key={song.id} className="space-y-4 rounded-xl border border-white/10 bg-zinc-900/70 p-5">
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="font-medium">song {index + 1}</h2>
                  <p className="mt-1 break-words text-xs text-zinc-400">
                    <time dateTime={song.createdAt}>{new Date(song.createdAt).toLocaleString()}</time> · {song.model}
                  </p>
                </div>
                <button type="button" aria-expanded={selectedSongId === song.id} aria-controls={`song-${song.id}`}
                  onClick={() => selectSong(song.id)} className={buttonClass}>
                  {selectedSongId === song.id ? "close" : "listen"}
                  <span className="sr-only"> song {index + 1}</span>
                </button>
              </div>
              <div id={`song-${song.id}`} hidden={selectedSongId !== song.id} className="space-y-3">
                {selectedSongId === song.id && <>
                  <AudioPlayer src={song.url} label={`song ${index + 1}`} className="w-full" />
                  <AudioDownload url={song.url} name={`song-${song.id}.mp3`}>download MP3</AudioDownload>
                </>}
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-zinc-400 focus-visible:outline-2 focus-visible:outline-offset-2">prompt</summary>
                <p className="mt-3 whitespace-pre-wrap break-words text-zinc-300">{song.prompt}</p>
              </details>
              {song.lyrics && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-zinc-400 focus-visible:outline-2 focus-visible:outline-offset-2">lyrics</summary>
                  <p className="mt-3 whitespace-pre-wrap break-words text-zinc-300">{song.lyrics}</p>
                </details>
              )}
              <button type="button" disabled={busy} onClick={() => void removeSong(song.id)}
                className={cn(buttonClass, "text-red-300")}>
                {deletingId === song.id ? "deleting..." : "delete"}
                <span className="sr-only"> song {index + 1}</span>
              </button>
              {deleteError?.id === song.id && <p role="alert" className="text-sm text-red-300">{deleteError.message}</p>}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
