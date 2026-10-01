import { useRef, useState } from "react";
import { generateMusic, resetChat, sendMessage, uploadAudio, type AudioTrack, type MusicTrack, type SeparatedStems } from "./api";

export interface Message {
  role: "user" | "agent";
  text: string;
  musicPrompt?: string;
  track?: MusicTrack;
  musicError?: string;
  audio?: AudioTrack;
  stems?: SeparatedStems;
  cleanedAudio?: AudioTrack;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed.";
}

export function useChat() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      text: "Hello! I am your AI assistant powered by NVIDIA Nemotron Super on Nebius Token Factory. How can I help you?",
    },
  ]);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const currentAudio = useRef<string | undefined>(undefined);

  async function send(text: string, audioUrl?: string): Promise<void> {
    const message = text.trim();
    if (!message || busy.current) return;

    busy.current = true;
    setLoading(true);
    setMessages((previous) => [...previous, { role: "user", text: message }]);

    if (audioUrl) currentAudio.current = audioUrl;
    const result = await sendMessage(message, currentAudio.current).catch(
      (error: unknown) => ({ reply: `Error: ${errorMessage(error)}` }),
    );

    if ("cleanedAudio" in result && result.cleanedAudio) currentAudio.current = result.cleanedAudio.url;
    setMessages((previous) => [...previous, { role: "agent", text: result.reply,
      musicPrompt: "musicPrompt" in result ? result.musicPrompt : undefined,
      stems: "stems" in result ? result.stems : undefined,
      cleanedAudio: "cleanedAudio" in result ? result.cleanedAudio : undefined }]);
    busy.current = false;
    setLoading(false);
  }

  async function upload(file: File): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    const result = await uploadAudio(file).catch((error: unknown) => new Error(errorMessage(error)));
    if (!(result instanceof Error)) currentAudio.current = result.url;
    setMessages((previous) => [...previous, result instanceof Error
      ? { role: "agent", text: `Error: ${result.message}` }
      : { role: "user", text: result.name, audio: result }]);
    busy.current = false;
    setLoading(false);
  }

  async function confirmMusic(index: number): Promise<void> {
    const message = messages[index];
    if (busy.current || !message?.musicPrompt || message.track) return;

    busy.current = true;
    setLoading(true);
    const result = await generateMusic(message.musicPrompt).catch(
      (error: unknown) => new Error(errorMessage(error)),
    );
    if (!(result instanceof Error)) currentAudio.current = result.url;
    setMessages((previous) => previous.map((item, itemIndex) => itemIndex !== index ? item :
      result instanceof Error
        ? { ...item, musicError: result.message }
        : { ...item, track: result, musicError: undefined }));
    busy.current = false;
    setLoading(false);
  }

  async function clear(): Promise<void> {
    if (busy.current) return;

    busy.current = true;
    setLoading(true);

    const error = await resetChat().catch(
      (cause: unknown) => new Error(errorMessage(cause)),
    );

    if (error) {
      setMessages((previous) => [
        ...previous,
        { role: "agent", text: `Error: ${error.message}` },
      ]);
    } else {
      currentAudio.current = undefined;
      setMessages([
        { role: "agent", text: "Conversation cleared. How can I help you?" },
      ]);
    }

    busy.current = false;
    setLoading(false);
  }

  return { messages, loading, send, clear, confirmMusic, upload };
}
