import { useEffect, useRef } from "react";
import { AiInput } from "@/components/ui/ai-input";
import { cn } from "@/lib/utils";
import { ChatMessage } from "./ChatMessage";
import { useChat } from "./useChat";
import { MusicPromptFields } from "./MusicPromptFields";
import { isMusicPrompt } from "./musicPrompt";

const MODELS = ["nvidia/nemotron-3-super-120b-a12b"];

export function ChatPage() {
  const { messages, loading, activity, musicPrompt, updatedMusicFields, musicModel, musicError, context, contextError, pendingAudio, uploadError, send, clear, confirmMusic, editMusicPrompt, changeMusicModel, upload, removeAudio } = useChat();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const audioInputRef = useRef<HTMLInputElement>(null);

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
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto py-4 space-y-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
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
            <div className="mb-3 space-y-3">
              <div className="flex items-center gap-3">
                <button type="button" disabled={loading} onClick={() => audioInputRef.current?.click()}
                  className="shrink-0 rounded-lg border border-white/10 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:cursor-not-allowed disabled:opacity-50">
                  {activity === "uploading audio..." ? "uploading audio..." : pendingAudio ? "replace audio" : "upload audio"}
                </button>
                {!pendingAudio && <span className="text-xs text-zinc-500">no file selected</span>}
              </div>
              <input ref={audioInputRef} type="file" accept=".mp3,.wav,.flac,.ogg" disabled={loading}
                aria-label="upload audio" className="hidden"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void upload(file);
                }} />
              {pendingAudio && (
                <div className="min-w-0 space-y-2 rounded-xl border border-white/10 bg-zinc-900/80 p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-all text-xs font-medium text-zinc-200">{pendingAudio.name}</p>
                      <p className="mt-1 text-xs text-zinc-400">attached to your next message</p>
                    </div>
                    <button type="button" disabled={loading} onClick={removeAudio} aria-label="remove attached audio"
                      className="shrink-0 rounded-lg px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/5 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-400 disabled:cursor-not-allowed disabled:opacity-50">
                      remove
                    </button>
                  </div>
                  <audio controls preload="none" src={pendingAudio.url}
                    aria-label={`attached audio: ${pendingAudio.name}`} className="h-10 w-full" />
                </div>
              )}
              {uploadError && <p role="alert" className="text-xs text-red-400">{uploadError}</p>}
            </div>
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
        <aside aria-labelledby="music-heading" className="min-h-0 min-w-0 space-y-4 border-t border-white/10 pt-4 lg:w-[26rem] lg:shrink-0 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:pl-6 lg:pr-2">
          <h2 id="music-heading" className="text-sm font-semibold">music generation</h2>
          <MusicPromptFields prompt={musicPrompt} updatedFields={updatedMusicFields} model={musicModel} disabled={loading}
            onChange={editMusicPrompt} onModelChange={changeMusicModel} />
          <button type="button" onClick={() => void confirmMusic()} disabled={loading || !isMusicPrompt(musicPrompt)}
            className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-zinc-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-50">
            generate music
          </button>
          {musicError && <p role="alert" className="text-xs text-red-400">{musicError}</p>}
          <div className="space-y-2 border-t border-white/10 pt-4 text-xs text-zinc-400">
            <div className="flex items-center justify-between gap-3">
              <label htmlFor="chat-context">conversation context</label>
              <span className="tabular-nums">{context ? `${context.messages} / ${context.limit} messages` : contextError ? "unavailable" : "loading..."}</span>
            </div>
            {context && <meter id="chat-context" min={0} max={context.limit} value={context.messages}
              className="block h-2 w-full" aria-describedby="chat-context-description" />}
            <p id="chat-context-description">recent chat and tool messages. older messages are trimmed; Clear resets the history.</p>
            {contextError && <p className="text-red-400">{contextError}</p>}
          </div>
        </aside>
      </div>
    </div>
  );
}
