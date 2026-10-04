import { cn } from "@/lib/utils";
import { AudioPlayer } from "@/components/ui/audio-player";
import { AudioDownload } from "@/components/ui/audio-download";
import type { Message } from "./useChat";

function MessageContent({ text }: { text: string }) {
  const parts = [];
  let lastIndex = 0;

  for (const match of text.matchAll(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g)) {
    if (match.index > lastIndex) {
      parts.push(
        <span key={lastIndex} className="whitespace-pre-wrap">
          {text.slice(lastIndex, match.index)}
        </span>,
      );
    }

    parts.push(
      <pre
        key={match.index}
        className="my-2 max-w-full overflow-x-auto rounded-lg border border-white/10 bg-zinc-950/60 p-3 font-mono text-xs text-zinc-300"
      >
        <code>{match[2]}</code>
      </pre>,
    );
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={lastIndex} className="whitespace-pre-wrap">
        {text.slice(lastIndex)}
      </span>,
    );
  }

  return <>{parts}</>;
}

export function ChatMessage({ message, loading, onSeparate, onRemoveEcho }: {
  message: Message;
  loading: boolean;
  onSeparate: (url: string) => void;
  onRemoveEcho: (url: string) => void;
}) {
  const isUser = message.role === "user";
  const sourceUrl = message.audio?.url ?? message.track?.url;
  const hasAudio = Boolean(message.track || message.audio || message.stems || message.cleanedAudio);

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 max-w-[95%] sm:max-w-[90%]",
        isUser ? "ml-auto items-end" : "mr-auto items-start",
      )}
    >
      <div
        className={cn(
          "min-w-0 max-w-full rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
          "[overflow-wrap:anywhere] border",
          hasAudio && "w-full",
          isUser && "border-white/15 bg-zinc-700/70 font-medium text-zinc-100",
          !isUser && "border-white/10 bg-zinc-900/80 text-zinc-100 shadow-xs",
        )}
      >
        <MessageContent text={isUser ? message.text : message.text.trim()} />
        {message.track && (
          <div className="mt-3 space-y-3">
            <AudioPlayer src={message.track.url} label="generated music" className="w-full" />
            <div>
              <AudioDownload url={message.track.url} name="generated-music.mp3">download MP3</AudioDownload>
            </div>
            {message.track.lyrics && (
              <details className="rounded-lg border border-white/10 bg-zinc-900/40 p-3 text-xs">
                <summary className="cursor-pointer font-medium text-zinc-400 hover:text-zinc-200 select-none">
                  lyrics
                </summary>
                <div className="mt-2 whitespace-pre-wrap text-zinc-300">
                  {message.track.lyrics}
                </div>
              </details>
            )}
          </div>
        )}
        {message.audio && (
          <div className="mt-3 space-y-2">
            <p className="text-xs opacity-70">{message.audio.name}</p>
            <AudioPlayer src={message.audio.url} label={`uploaded audio: ${message.audio.name}`} className="w-full" />
          </div>
        )}
        {sourceUrl && (
          <>
            <button type="button" disabled={loading} onClick={() => onSeparate(sourceUrl)}
              className="mt-3 rounded-lg border border-current/20 px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50">
              separate stems
            </button>
            <button type="button" disabled={loading} onClick={() => onRemoveEcho(sourceUrl)}
              className="ml-2 mt-3 rounded-lg border border-current/20 px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50">
              remove echo/reverb
            </button>
          </>
        )}
        {(message.stems || message.cleanedAudio) && (
          <div className="mt-3 space-y-3">
            {[
              ...(message.stems ? [
                { name: "vocals", url: message.stems.vocalsUrl },
                { name: "instrumental", url: message.stems.instrumentalUrl },
              ] : []),
              ...(message.cleanedAudio ? [message.cleanedAudio] : []),
            ].map((stem) => (
              <div key={stem.name} className="space-y-1">
                <p className="text-xs">{stem.name}</p>
                <AudioPlayer src={stem.url} label={stem.name} className="w-full" />
                <AudioDownload url={stem.url} name={`${stem.name}.wav`}>{`download ${stem.name} WAV`}</AudioDownload>
                <button type="button" disabled={loading} onClick={() => onRemoveEcho(stem.url)}
                  aria-label={`remove echo/reverb from ${stem.name}`}
                  className="ml-2 rounded-lg border border-current/20 px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50">
                  remove echo/reverb
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
