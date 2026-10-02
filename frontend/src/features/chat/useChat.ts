import { useRef, useState } from "react";
import { generateMusic, resetChat, sendMessage, uploadAudio, type AudioTrack, type MusicTrack, type SeparatedStems } from "./api";
import { emptyMusicPrompt, isMusicPrompt, type MusicPrompt } from "./musicPrompt";

export interface Message {
  role: "user" | "agent";
  text: string;
  track?: MusicTrack;
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
  const [activity, setActivity] = useState<string>();
  const loading = activity !== undefined;
  const [musicPrompt, setMusicPrompt] = useState<MusicPrompt>(emptyMusicPrompt);
  const [musicModel, setMusicModel] = useState("lyria-3.5");
  const [musicError, setMusicError] = useState<string>();
  const busy = useRef(false);
  const currentAudio = useRef<string | undefined>(undefined);

  async function send(text: string, audioUrl?: string): Promise<void> {
    const message = text.trim();
    if (!message || busy.current) return;

    busy.current = true;
    setActivity('thinking...');
    setMessages((previous) => [...previous, { role: "user", text: message }]);

    if (audioUrl) currentAudio.current = audioUrl;
    const result = await sendMessage(message, currentAudio.current, musicPrompt, setActivity).catch(
      (error: unknown) => ({ reply: `Error: ${errorMessage(error)}` }),
    );

    if ("cleanedAudio" in result && result.cleanedAudio) currentAudio.current = result.cleanedAudio.url;
    if ("musicPrompt" in result && result.musicPrompt) {
      setMusicPrompt(result.musicPrompt);
      setMusicError(undefined);
    }
    setMessages((previous) => [...previous, { role: "agent", text: result.reply,
      stems: "stems" in result ? result.stems : undefined,
      cleanedAudio: "cleanedAudio" in result ? result.cleanedAudio : undefined }]);
    busy.current = false;
    setActivity(undefined);
  }

  async function upload(file: File): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setActivity('uploading audio...');
    const result = await uploadAudio(file).catch((error: unknown) => new Error(errorMessage(error)));
    if (!(result instanceof Error)) currentAudio.current = result.url;
    setMessages((previous) => [...previous, result instanceof Error
      ? { role: "agent", text: `Error: ${result.message}` }
      : { role: "user", text: result.name, audio: result }]);
    busy.current = false;
    setActivity(undefined);
  }

  function editMusicPrompt(field: keyof MusicPrompt, value: string): void {
    if (busy.current) return;
    setMusicPrompt((previous) => ({ ...previous, [field]: value }));
    setMusicError(undefined);
  }

  function changeMusicModel(model: string): void {
    if (busy.current) return;
    setMusicModel(model);
    setMusicError(undefined);
  }

  async function confirmMusic(): Promise<void> {
    if (busy.current || !isMusicPrompt(musicPrompt)) return;

    busy.current = true;
    setActivity('generating track...');
    const result = await generateMusic(musicPrompt, musicModel).catch(
      (error: unknown) => new Error(errorMessage(error)),
    );
    if (result instanceof Error) {
      setMusicError(result.message);
    } else {
      currentAudio.current = result.url;
      setMusicError(undefined);
      setMessages((previous) => [...previous, { role: "agent", text: "your track is ready.", track: result }]);
    }
    busy.current = false;
    setActivity(undefined);
  }

  async function clear(): Promise<void> {
    if (busy.current) return;

    busy.current = true;
    setActivity('clearing conversation...');

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
      setMusicPrompt(emptyMusicPrompt);
      setMusicModel("lyria-3.5");
      setMusicError(undefined);
      setMessages([
        { role: "agent", text: "Conversation cleared. How can I help you?" },
      ]);
    }

    busy.current = false;
    setActivity(undefined);
  }

  return { messages, loading, activity, musicPrompt, musicModel, musicError, send, clear, confirmMusic, editMusicPrompt, changeMusicModel, upload };
}
