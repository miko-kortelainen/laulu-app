import { useId } from "react";
import { cn } from "@/lib/utils";
import { useAudioPlayer } from "@/lib/use-audio-player";

interface AudioPlayerProps {
  src: string;
  label: string;
  className?: string;
  active?: boolean;
}

function formatTime(seconds: number): string {
  const value = Math.floor(seconds);
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

export function AudioPlayer(props: AudioPlayerProps) {
  return <Player key={props.src} {...props} />;
}

function Player({ src, label, className, active = true }: AudioPlayerProps) {
  const { audioProps, playing, time, duration, volume, buffered, buffering, playbackError, togglePlayback, seek, stop, changeVolume } = useAudioPlayer(src, active);
  const timelineId = useId();
  const progress = duration ? Math.min(1, time / duration) : 0;
  const controlClass = "flex size-9 shrink-0 items-center justify-center rounded-lg border border-current/20 transition-colors hover:bg-current/10 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div role="group" aria-label={label} className={cn("w-80 max-w-full min-w-0 space-y-2 rounded-lg bg-current/5 p-3", className)}>
      <audio {...audioProps} preload="none" aria-label={label} className="hidden" />
      <div className="relative h-12 bg-black/15 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
        <svg viewBox="0 0 240 48" preserveAspectRatio="none" aria-hidden="true" className="h-full w-full overflow-visible">
          <defs>
            <linearGradient id={`${timelineId}-gradient`} gradientUnits="userSpaceOnUse" x1="0" x2="240">
              <stop offset="0%" stopColor="#f87171" />
              <stop offset="33%" stopColor="#fb923c" />
              <stop offset="67%" stopColor="#fde047" />
              <stop offset="100%" stopColor="#4ade80" />
            </linearGradient>
            <pattern id={`${timelineId}-ticks`} width="12" height="48" patternUnits="userSpaceOnUse">
              <path d="M6 15v2 M6 31v2" stroke="currentColor" strokeOpacity="0.12" vectorEffect="non-scaling-stroke" />
            </pattern>
            <pattern id={`${timelineId}-markers`} width="60" height="48" patternUnits="userSpaceOnUse">
              <path d="M30 11v6 M30 31v6" stroke="currentColor" strokeOpacity="0.2" vectorEffect="non-scaling-stroke" />
            </pattern>
            <clipPath id={`${timelineId}-track`}>
              <rect y="21" width="240" height="6" />
            </clipPath>
          </defs>
          <rect width="240" height="48" fill={`url(#${timelineId}-ticks)`} />
          <rect width="240" height="48" fill={`url(#${timelineId}-markers)`} />
          <g clipPath={`url(#${timelineId}-track)`}>
            <rect y="21" width="240" height="6" fill="currentColor" opacity="0.08" />
            {duration > 0 && buffered.map((range) => (
              <rect key={range.start} x={range.start / duration * 240} y="21"
                width={(range.end - range.start) / duration * 240} height="6" fill="currentColor" opacity="0.25" />
            ))}
            <rect y="21" width={progress * 240} height="6" fill={`url(#${timelineId}-gradient)`} />
          </g>
          <line data-playhead x1={progress * 240} x2={progress * 240} y1="16" y2="32"
            stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
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
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] tabular-nums">
          {formatTime(time)} / {duration ? formatTime(duration) : "--:--"}
          {buffering && <span aria-hidden="true" className="size-3 shrink-0 rounded-full border-2 border-current border-t-transparent opacity-60 motion-safe:animate-spin" />}
        </span>
        <label className="ml-auto flex items-center gap-1.5 text-[11px]">
          volume
          <input type="range" min="0" max="1" step="0.01" value={volume} aria-label={`volume ${label}`}
            aria-valuetext={`${Math.round(volume * 100)}%`} onChange={(event) => changeVolume(Number(event.currentTarget.value))}
            className="audio-volume h-6 w-32 cursor-pointer appearance-none bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2" />
        </label>
      </div>
      <p role="status" className="sr-only">{buffering ? "buffering..." : ""}</p>
      {playbackError && <p role="alert" className="text-xs">{playbackError}</p>}
    </div>
  );
}
