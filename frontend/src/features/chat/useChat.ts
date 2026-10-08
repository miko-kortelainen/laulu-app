import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { acknowledgeOperation, getOperations, readOperationResult, waitForOperation, generateMusic, getChatContext, getUsage, resetChat, retrySongStorage, sendMessage, OperationError, SongStorageError, uploadAudio, type AudioTrack, type ChatContext, type MusicTrack, type Usage } from "./api";
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

interface Draft {
  musicPrompt?: MusicPrompt;
  musicModel?: string;
  pendingAudio?: AudioTrack;
  pendingSongId?: string;
  currentAudio?: string;
  pendingChatId?: string;
}

function readDraft(userId: string): Draft {
  const value: unknown = (() => {
    try { return JSON.parse(sessionStorage.getItem(`music-draft:${userId}`) || "null"); }
    catch { return null; }
  })();
  if (!value || typeof value !== "object") return {};
  const fields = value as Record<string, unknown>;
  const audio = fields.pendingAudio;
  const validAudio = (url: unknown) => typeof url === "string" && /^\/api\/(audio|music)\/[0-9a-f-]{36}\.(mp3|wav|flac|ogg)$/.test(url);
  return {
    musicPrompt: isMusicPrompt(fields.musicPrompt) ? fields.musicPrompt : undefined,
    musicModel: fields.musicModel === "lyria-3-clip-preview" ? fields.musicModel : "lyria-3.5",
    pendingSongId: typeof fields.pendingSongId === "string" && /^[0-9a-f-]{36}$/.test(fields.pendingSongId) ? fields.pendingSongId : undefined,
    pendingAudio: audio && typeof audio === "object" && "url" in audio && validAudio(audio.url) &&
      "name" in audio && typeof audio.name === "string" ? { url: audio.url as string, name: audio.name } : undefined,
    currentAudio: validAudio(fields.currentAudio) ? fields.currentAudio as string : undefined,
    pendingChatId: typeof fields.pendingChatId === "string" && /^[0-9a-f-]{36}$/.test(fields.pendingChatId) ? fields.pendingChatId : undefined,
  };
}

function saveDraft(userId: string, draft: Draft): void {
  try { sessionStorage.setItem(`music-draft:${userId}`, JSON.stringify(draft)); }
  catch (error: unknown) { console.error("could not preserve the music draft:", error); }
}

export function useChat(userId: string) {
  const { pathname } = useLocation();
  const [draft] = useState(() => readDraft(userId));
  const requests = useRef(new AbortController());
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "agent",
      text: "Hello! I am your AI assistant powered by NVIDIA Nemotron Super on Nebius Token Factory. How can I help you?",
    },
  ]);
  const [activity, setActivity] = useState<string | undefined>("recovering requests...");
  const loading = activity !== undefined;
  const [musicPrompt, setMusicPrompt] = useState<MusicPrompt>(draft.musicPrompt ?? emptyMusicPrompt);
  const [updatedMusicFields, setUpdatedMusicFields] = useState<(keyof MusicPrompt)[]>([]);
  const [musicModel, setMusicModel] = useState(draft.musicModel ?? "lyria-3.5");
  const [musicError, setMusicError] = useState<string>();
  const [pendingSongId, setPendingSongId] = useState<string | undefined>(draft.pendingSongId);
  const [pendingAudio, setPendingAudio] = useState<AudioTrack | undefined>(draft.pendingAudio);
  const [uploadError, setUploadError] = useState<string>();
  const [context, setContext] = useState<ChatContext>();
  const [contextError, setContextError] = useState<string>();
  const contextRequest = useRef(0);
  const [usage, setUsage] = useState<Usage>();
  const [usageError, setUsageError] = useState<string>();
  const usageRequest = useRef(0);
  const busy = useRef(true);
  const sendingAudio = useRef<AudioTrack | undefined>(undefined);
  const currentAudio = useRef<string | undefined>(draft.currentAudio);
  const pendingChatId = useRef(draft.pendingChatId);

  useEffect(() => {
    saveDraft(userId, {
      musicPrompt, musicModel, pendingAudio: pendingAudio ?? sendingAudio.current, pendingSongId,
      currentAudio: currentAudio.current, pendingChatId: pendingChatId.current,
    });
  }, [userId, musicPrompt, musicModel, pendingAudio, pendingSongId, messages]);

  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    busy.current = true;
    const recover = async () => {
      const operations = await getOperations(controller.signal, setActivity);
      for (const pending of operations) {
        const operation = await waitForOperation(pending.id, setActivity, controller.signal);
        if (controller.signal.aborted) return;
        const result = await readOperationResult(operation).catch((error: unknown) =>
          error instanceof Error ? error : new Error(errorMessage(error)));
        if (result instanceof Error) {
          if (operation.kind === "music") {
            if (result instanceof SongStorageError) setPendingSongId(result.songId);
            setMusicError(result.message);
          } else setMessages((previous) => [...previous, { role: "agent", text: `Error: ${result.message}` }]);
        } else if ("reply" in result) {
          setMessages((previous) => [...previous, { role: "agent", text: result.reply }]);
          if (operation.id === pendingChatId.current) {
            if (result.musicPrompt) setMusicPrompt(result.musicPrompt);
            setPendingAudio(undefined);
          }
        } else {
          currentAudio.current = result.url;
          setPendingSongId(undefined);
          setMusicError(undefined);
          setMessages((previous) => [...previous, { role: "agent", text: "your track is ready.", track: result }]);
        }
        if (operation.id === pendingChatId.current) pendingChatId.current = undefined;
        void acknowledgeOperation(operation.id, controller.signal).catch((error: unknown) => {
          if (!controller.signal.aborted) console.error(error);
        });
      }
    };
    void recover().catch((error: unknown) => {
      if (!controller.signal.aborted) setMusicError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) {
        busy.current = false;
        setActivity(undefined);
      }
    });
    return () => controller.abort();
  }, []);

  const refreshUsage = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const request = ++usageRequest.current;
    const result = await getUsage(signal).catch((error: unknown) => new Error(errorMessage(error)));
    if (signal?.aborted || request !== usageRequest.current) return;
    if (result instanceof Error) {
      setUsageError(result.message);
    } else {
      setUsage(result);
      setUsageError(undefined);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    if (!loading) {
      // oxlint-disable-next-line react/set-state-in-effect -- state updates after the usage fetch resolves.
      void refreshUsage(controller.signal);
    }
    return () => controller.abort();
  }, [loading, pathname, refreshUsage]);

  useEffect(() => {
    if (!usage || loading) return;
    const delay = Date.parse(usage.resetAt) - Date.now();
    if (delay <= 0) return;
    const timeout = window.setTimeout(() => void refreshUsage(), Math.min(delay + 1000, 2_147_483_647));
    return () => window.clearTimeout(timeout);
  }, [usage, loading, refreshUsage]);

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

  function finishOperation(result: { operationId?: string } | Error): void {
    if ("operationId" in result && typeof result.operationId === "string") {
      const signal = requests.current.signal;
      void acknowledgeOperation(result.operationId, signal).catch((error: unknown) => {
        if (!signal.aborted) console.error(error);
      });
    }
  }

  async function send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || busy.current) return;

    busy.current = true;
    const attachment = pendingAudio;
    if (attachment) {
      sendingAudio.current = attachment;
      setPendingAudio(undefined);
      setUploadError(undefined);
    }
    setUpdatedMusicFields([]);
    setActivity('thinking...');
    setMessages((previous) => [...previous, { role: "user", text: message, audio: attachment }]);

    if (attachment) currentAudio.current = attachment.url;
    const id = crypto.randomUUID();
    pendingChatId.current = id;
    saveDraft(userId, { musicPrompt, musicModel, pendingAudio: attachment, pendingSongId,
      currentAudio: currentAudio.current, pendingChatId: id });
    const result = await sendMessage(message, currentAudio.current, musicPrompt, setActivity, requests.current.signal, id).catch(
      (error: unknown) => ({ reply: `Error: ${errorMessage(error)}`, failed: true, operationId: error instanceof OperationError ? error.operationId : undefined }),
    );

    if (requests.current.signal.aborted) return;
    pendingChatId.current = undefined;
    sendingAudio.current = undefined;
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
    finishOperation(result);
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
    const result = await (pendingSongId ? retrySongStorage(pendingSongId) : generateMusic(musicPrompt, musicModel, setActivity, requests.current.signal))
      .catch((error: unknown) => error instanceof Error ? error : new Error(errorMessage(error)));
    if (requests.current.signal.aborted) return;
    if (result instanceof Error) {
      if (result instanceof SongStorageError) setPendingSongId(result.songId);
      setMusicError(result.message);
    } else {
      currentAudio.current = result.url;
      setPendingSongId(undefined);
      setMusicError(undefined);
      setMessages((previous) => [...previous, { role: "agent", text: "your track is ready.", track: result }]);
    }
    finishOperation(result);
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

  return { messages, loading, activity, musicPrompt, updatedMusicFields, musicModel, musicError, pendingSongId, context, contextError, usage, usageError, refreshUsage, pendingAudio, uploadError, send, clear, confirmMusic, editMusicPrompt, changeMusicModel, upload, removeAudio };
}
