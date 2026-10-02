import { useEffect, useRef } from "react";
import { AiInput } from "@/components/ui/ai-input";
import { cn } from "@/lib/utils";
import { ChatMessage } from "./ChatMessage";
import { useChat } from "./useChat";
import { MusicPromptFields } from "./MusicPromptFields";
import { isMusicPrompt } from "./musicPrompt";

const MODELS = ["nvidia/nemotron-3-super-120b-a12b"];

export function ChatPage() {
  const { messages, loading, activity, musicPrompt, musicModel, musicError, send, clear, confirmMusic, editMusicPrompt, changeMusicModel, upload } = useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, loading]);

  return (
    <div
      className={cn(
        "mx-auto flex min-h-dvh w-full max-w-7xl flex-col lg:h-dvh",
        "px-4 py-4 font-sans text-zinc-100 sm:px-6 sm:py-6",
      )}
    >
      <header
        className={cn(
          "flex flex-none items-center justify-between gap-4",
          "border-b border-white/10 pb-4",
        )}
      >
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Nemotron Copilot</h1>
          <p className="text-xs text-zinc-400">
            Powered by Nebius Token Factory & Strands Agents SDK
          </p>
        </div>
        <button
          type="button"
          onClick={clear}
          disabled={loading}
          className="shrink-0 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          Clear
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 lg:flex-row">
        <section aria-label="chat" className="flex h-[70dvh] min-h-0 min-w-0 flex-col lg:h-auto lg:flex-1">
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4 space-y-4">
            {messages.map((message, index) => (
              <ChatMessage key={index} message={message} loading={loading}
                onSeparate={(url) => send("separate the vocals and instrumental from this track.", url)}
                onRemoveEcho={(url) => send("remove echo and reverb from this audio.", url)} />
            ))}

            {loading && (
              <div className="mr-auto flex flex-col items-start gap-1 max-w-[90%] sm:max-w-[85%]">
                <div className="text-[11px] font-mono text-zinc-500 px-4">
                  Nemotron Super
                </div>
                <div
                  role="status"
                  className={cn(
                    "flex items-center gap-2 rounded-2xl border border-white/10",
                    "bg-zinc-900/80 px-4 py-2.5 text-sm text-zinc-400",
                  )}
                >
                  <span className="size-3 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" aria-hidden="true" />
                  <span>{activity}</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </main>

          <footer className="flex-none pt-4 border-t border-white/10">
            <label className="mb-3 flex flex-col gap-1 text-xs text-zinc-400">
              upload audio
              <input type="file" accept=".mp3,.wav,.flac,.ogg" disabled={loading}
                className="min-w-0 max-w-full text-xs file:mr-2 file:rounded-lg file:border file:border-white/10 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-zinc-200 disabled:opacity-50"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void upload(file);
                }} />
            </label>
            <AiInput
              placeholder="Ask Nemotron Super..."
              onSubmit={(text) => send(text)}
              models={MODELS}
              selectedModel={MODELS[0]}
              allowAttachments={false}
              allowEffortSelect={false}
              allowModelSelect={false}
              allowVoice={false}
              disabled={loading}
              minWidth="100%"
              maxWidth="100%"
              variant="default"
              className="mx-auto w-full"
            />
          </footer>
        </section>
        <aside aria-labelledby="music-heading" className="min-h-0 min-w-0 space-y-4 border-t border-white/10 pt-4 lg:w-[26rem] lg:shrink-0 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:pl-6">
          <h2 id="music-heading" className="text-sm font-semibold">music generation</h2>
          <MusicPromptFields prompt={musicPrompt} model={musicModel} disabled={loading}
            onChange={editMusicPrompt} onModelChange={changeMusicModel} />
          <button type="button" onClick={() => void confirmMusic()} disabled={loading || !isMusicPrompt(musicPrompt)}
            className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
            generate music
          </button>
          {musicError && <p role="alert" className="text-xs text-red-400">{musicError}</p>}
        </aside>
      </div>
    </div>
  );
}
