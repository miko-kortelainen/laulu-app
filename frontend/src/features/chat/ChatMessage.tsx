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

export function ChatMessage({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const hasAudio = Boolean(message.track || message.audio);

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1 max-w-[90%] sm:max-w-[80%]",
        isUser ? "ml-auto items-end" : "mr-auto items-start",
      )}
    >
      <div
        className={cn(
          "min-w-0 max-w-full rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed text-balance [overflow-wrap:anywhere]",
          hasAudio && "w-full",
          isUser && "bg-zinc-800 bg-linear-to-b from-white/[0.04] to-black/10 font-medium text-zinc-100",
          !isUser && "text-zinc-100",
        )}
      >
        {message.welcome && (
          <>
            hi, i'm{" "}
            <span className="bg-clip-text text-transparent"
              style={{ backgroundImage: "linear-gradient(to right, #f87171 0%, #fb923c 33%, #fde047 67%, #4ade80 100%)" }}>
              laulu
            </span>.
            <br />
            <br />
          </>
        )}
        <MessageContent text={isUser ? message.text : message.text.trim()} />
        {message.track && (
          <div className="mt-3 space-y-3">
            <p className="break-words text-sm font-medium">{message.track.title}</p>
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
      </div>
    </div>
  );
}
