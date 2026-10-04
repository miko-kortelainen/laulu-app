import { useId } from "react";
import { cn } from "@/lib/utils";
import { useAudioPlayer } from "@/lib/use-audio-player";

interface AudioPlayerProps {
  src: string;
  label: string;
  className?: string;
}

function formatTime(seconds: number): string {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function AudioPlayer(props: AudioPlayerProps) {
  return <Player key={props.src} {...props} />;
}

function Player({ src, label, className }: AudioPlayerProps) {
  const { audioProps, playing, time, duration, volume, waveform, waveformError, playbackError, togglePlayback, seek, stop, changeVolume } = useAudioPlayer(src);
  const clipId = useId();
  const progress = duration ? Math.min(1, time / duration) : 0;
  const controlClass = "flex size-9 shrink-0 items-center justify-center rounded-lg border border-current/20 transition-colors hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div role="group" aria-label={label} className={cn("w-80 max-w-full min-w-0 space-y-2 rounded-lg bg-current/5 p-3", className)}>
      <audio {...audioProps} preload="metadata" aria-label={label} className="hidden" />
      <div className="relative h-12 rounded-sm focus-within:outline-2 focus-within:outline-offset-2">
        <svg viewBox="0 0 240 48" preserveAspectRatio="none" aria-hidden="true" className="h-full w-full">
          <defs><clipPath id={clipId}><rect width={progress * 240} height="48" /></clipPath></defs>
          {waveform ? (
            <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d={waveform} opacity="0.25" />
              <path d={waveform} clipPath={`url(#${clipId})`} />
            </g>
          ) : <line x1="0" y1="24" x2="240" y2="24" stroke="currentColor" opacity="0.25" />}
          <line data-playhead x1={progress * 240} x2={progress * 240} y1="1" y2="47" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <input type="range" min="0" max={duration || 1} step="0.01" value={time} disabled={!duration}
          aria-label={`seek ${label}`} aria-valuetext={`${formatTime(time)} of ${duration ? formatTime(duration) : "unknown duration"}`}
          onChange={(event) => seek(Number(event.currentTarget.value))}
          className="absolute inset-0 m-0 h-full w-full touch-none cursor-pointer opacity-0 disabled:cursor-not-allowed" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void togglePlayback()} aria-label={`${playing ? "pause" : "play"} ${label}`} className={controlClass}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-4">
            {playing ? <path d="M6 4h4v16H6zm8 0h4v16h-4z" /> : <path d="m8 4 12 8-12 8z" />}
          </svg>
        </button>
        <button type="button" onClick={stop} disabled={!playing && time === 0} aria-label={`stop ${label}`} className={controlClass}>
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className="size-4"><path d="M5 5h14v14H5z" /></svg>
        </button>
        <span className="whitespace-nowrap text-[11px] tabular-nums">{formatTime(time)} / {duration ? formatTime(duration) : "--:--"}</span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px]">
          volume
          <input type="range" min="0" max="1" step="0.01" value={volume} aria-label={`volume ${label}`}
            aria-valuetext={`${Math.round(volume * 100)}%`} onChange={(event) => changeVolume(Number(event.currentTarget.value))}
            className="h-6 w-16 cursor-pointer accent-current" />
        </label>
      </div>
      {!waveform && <p className="text-[11px] opacity-60">{waveformError ? "waveform unavailable" : "loading waveform..."}</p>}
      {playbackError && <p role="alert" className="text-xs">{playbackError}</p>}
    </div>
  );
}
