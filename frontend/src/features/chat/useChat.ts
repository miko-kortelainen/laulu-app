import { useCallback, useEffect, useRef, useState } from "react";
import { generateMusic, getChatContext, resetChat, retrySongStorage, sendMessage, SongStorageError, uploadAudio, type AudioTrack, type ChatContext, type MusicTrack } from "./api";
import { emptyMusicPrompt, isMusicPrompt, musicPromptFields, type MusicPrompt } from "./musicPrompt";

export interface Message {
  role: "user" | "agent";
  text: string;
  track?: MusicTrack;
  audio?: AudioTrack;
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
  const [updatedMusicFields, setUpdatedMusicFields] = useState<(keyof MusicPrompt)[]>([]);
  const [musicModel, setMusicModel] = useState("lyria-3.5");
  const [musicError, setMusicError] = useState<string>();
  const [pendingSongId, setPendingSongId] = useState<string>();
  const [pendingAudio, setPendingAudio] = useState<AudioTrack>();
  const [uploadError, setUploadError] = useState<string>();
  const [context, setContext] = useState<ChatContext>();
  const [contextError, setContextError] = useState<string>();
  const contextRequest = useRef(0);
  const busy = useRef(false);
  const currentAudio = useRef<string | undefined>(undefined);

  const refreshContext = useCallback(async (): Promise<void> => {
    const request = ++contextRequest.current;
    const result = await getChatContext().catch((error: unknown) => new Error(errorMessage(error)));
    if (request !== contextRequest.current) return;
    if (result instanceof Error) {
      setContextError(result.message);
    } else {
      setContext(result);
      setContextError(undefined);
    }
  }, []);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- state updates only after the context fetch resolves.
    void refreshContext();
  }, [refreshContext]);

  useEffect(() => {
    if (!updatedMusicFields.length) return;
    const timeout = window.setTimeout(() => setUpdatedMusicFields([]), 2500);
    return () => window.clearTimeout(timeout);
  }, [updatedMusicFields]);

  async function send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || busy.current) return;

    busy.current = true;
    const attachment = pendingAudio;
    if (attachment) {
      setPendingAudio(undefined);
      setUploadError(undefined);
    }
    setUpdatedMusicFields([]);
    setActivity('thinking...');
    setMessages((previous) => [...previous, { role: "user", text: message, audio: attachment }]);

    if (attachment) currentAudio.current = attachment.url;
    const result = await sendMessage(message, currentAudio.current, musicPrompt, setActivity).catch(
      (error: unknown) => ({ reply: `Error: ${errorMessage(error)}`, failed: true }),
    );

    if (attachment && "failed" in result) setPendingAudio(attachment);
    if ("musicPrompt" in result && result.musicPrompt) {
      const nextPrompt = result.musicPrompt;
      setUpdatedMusicFields(musicPromptFields
        .filter(({ name }) => nextPrompt[name] !== musicPrompt[name])
        .map(({ name }) => name));
      setMusicPrompt(nextPrompt);
      setMusicError(undefined);
    }
    setMessages((previous) => [...previous, { role: "agent", text: result.reply }]);
    await refreshContext();
    busy.current = false;
    setActivity(undefined);
  }

  async function upload(file: File): Promise<void> {
    if (busy.current) return;
    busy.current = true;
    setUploadError(undefined);
    setActivity('uploading audio...');
    const result = await uploadAudio(file).catch((error: unknown) => new Error(errorMessage(error)));
    if (result instanceof Error) {
      setUploadError(result.message);
    } else {
      setPendingAudio(result);
    }
    busy.current = false;
    setActivity(undefined);
  }

  function removeAudio(): void {
    if (busy.current) return;
    setPendingAudio(undefined);
    setUploadError(undefined);
  }

  function editMusicPrompt(field: keyof MusicPrompt, value: string): void {
    if (busy.current) return;
    setUpdatedMusicFields([]);
    setMusicPrompt((previous) => ({ ...previous, [field]: value }));
    setMusicError(undefined);
  }

  function changeMusicModel(model: string): void {
    if (busy.current) return;
    setMusicModel(model);
    setMusicError(undefined);
  }

  async function confirmMusic(): Promise<void> {
    if (busy.current || (!pendingSongId && !isMusicPrompt(musicPrompt))) return;

    busy.current = true;
    setActivity(pendingSongId ? 'saving track...' : 'generating track...');
    const result = await (pendingSongId ? retrySongStorage(pendingSongId) : generateMusic(musicPrompt, musicModel))
      .catch((error: unknown) => error instanceof Error ? error : new Error(errorMessage(error)));
    if (result instanceof Error) {
      if (result instanceof SongStorageError) setPendingSongId(result.songId);
      setMusicError(result.message);
    } else {
      currentAudio.current = result.url;
      setPendingSongId(undefined);
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
      contextRequest.current++;
      setContext({ messages: 0, limit: context?.limit ?? 40 });
      setContextError(undefined);
      currentAudio.current = undefined;
      setPendingAudio(undefined);
      setUploadError(undefined);
      setMusicPrompt(emptyMusicPrompt);
      setUpdatedMusicFields([]);
      setMusicModel("lyria-3.5");
      setMusicError(undefined);
      setPendingSongId(undefined);
      setMessages([
        { role: "agent", text: "Conversation cleared. How can I help you?" },
      ]);
    }

    busy.current = false;
    setActivity(undefined);
  }

  return { messages, loading, activity, musicPrompt, updatedMusicFields, musicModel, musicError, pendingSongId, context, contextError, pendingAudio, uploadError, send, clear, confirmMusic, editMusicPrompt, changeMusicModel, upload, removeAudio };
}
