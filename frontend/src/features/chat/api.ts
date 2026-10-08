import { formatMusicPrompt, isMusicPrompt, type MusicPrompt } from "./musicPrompt";
import { authenticatedFetch } from "@/lib/api";

export interface ChatReply {
  operationId?: string;
  reply: string;
  musicPrompt?: MusicPrompt;
}

export interface ChatContext {
  messages: number;
  limit: number;
}

interface Allowance { limit: number; used: number; remaining: number }
export interface Usage {
  resetAt: string;
  chat: Allowance;
  analysis: Allowance;
  generation: Allowance;
  storage: Allowance & { reserved: number };
}

export async function getUsage(signal?: AbortSignal): Promise<Usage> {
  const response = await authenticatedFetch("/api/usage", { signal });
  if (!response.ok) throw new Error("could not load daily allowances. try again.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("resetAt" in data) || typeof data.resetAt !== "string" ||
      !Number.isFinite(Date.parse(data.resetAt))) throw new Error("invalid usage response.");
  for (const name of ["chat", "analysis", "generation", "storage"] as const) {
    const value = (data as Record<string, unknown>)[name];
    if (!value || typeof value !== "object") throw new Error("invalid usage response.");
    for (const field of name === "storage" ? ["limit", "used", "remaining", "reserved"] : ["limit", "used", "remaining"]) {
      const count = (value as Record<string, unknown>)[field];
      if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) throw new Error("invalid usage response.");
    }
  }
  return data as Usage;
}

export async function getChatContext(): Promise<ChatContext> {
  const response = await authenticatedFetch("/api/context");
  if (!response.ok) throw new Error("could not load conversation context.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" ||
      !("messages" in data) || typeof data.messages !== "number" || !Number.isSafeInteger(data.messages) || data.messages < 0 ||
      !("limit" in data) || typeof data.limit !== "number" || !Number.isSafeInteger(data.limit) || data.limit <= 0) {
    throw new Error("invalid conversation context response.");
  }
  return { messages: data.messages, limit: data.limit };
}

export interface AudioTrack {
  url: string;
  name: string;
}

export interface MusicTrack {
  operationId?: string;
  url: string;
  lyrics: string;
}

export class OperationError extends Error {
  readonly operationId?: string;

  constructor(message: string, operationId?: string) {
    super(message);
    this.operationId = operationId;
  }
}

export class SongStorageError extends OperationError {
  readonly songId: string;

  constructor(songId: string, message: string, operationId?: string) {
    super(message, operationId);
    this.songId = songId;
  }
}

export interface Operation {
  id: string;
  kind: "music" | "chat";
  state: "queued" | "running" | "completed" | "failed" | "unknown";
  status: string;
  result: Record<string, unknown> | null;
}

function readOperation(value: unknown): Operation {
  if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.id) ||
      !("kind" in value) || typeof value.kind !== "string" || !["music", "chat"].includes(value.kind) ||
      !("state" in value) || typeof value.state !== "string" || !["queued", "running", "completed", "failed", "unknown"].includes(value.state) ||
      !("status" in value) || typeof value.status !== "string" || !("result" in value) ||
      (value.result !== null && (typeof value.result !== "object" || Array.isArray(value.result)))) {
    throw new Error("invalid operation response.");
  }
  return value as Operation;
}

export async function getOperations(signal: AbortSignal, onStatus: (status: string) => void): Promise<Operation[]> {
  const response = await fetchOperation("/api/operations", { signal }, onStatus);
  if (!response.ok) throw new Error("could not recover requests. reload to try again.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("operations" in data) || !Array.isArray(data.operations)) {
    throw new Error("invalid operation response.");
  }
  return data.operations.map(readOperation);
}

export async function acknowledgeOperation(id: string, signal: AbortSignal): Promise<void> {
  const response = await fetchOperation(`/api/operations/${id}/acknowledge`, { method: "POST", signal });
  if (!response.ok) throw new Error("could not acknowledge the recovered request.");
}

async function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { window.clearTimeout(timer); reject(signal.reason); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, 1000);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function fetchOperation(url: string, options: RequestInit & { signal: AbortSignal },
  onStatus?: (status: string) => void): Promise<Response> {
  while (true) {
    options.signal.throwIfAborted();
    const response = await authenticatedFetch(url, options).catch((error: unknown) => {
      options.signal.throwIfAborted();
      return error instanceof Error ? error : new Error("connection lost.");
    });
    if (!(response instanceof Error) && response.status < 500) return response;
    onStatus?.("reconnecting to your request...");
    await pause(options.signal);
  }
}

export async function waitForOperation(id: string, onStatus: (status: string) => void, signal: AbortSignal): Promise<Operation> {
  let missing = 0;
  while (!signal.aborted) {
    const response = await fetchOperation(`/api/operations/${id}`, { signal }, onStatus);
    if (response.status === 404 && missing++ < 10) {
      onStatus("recovering your request...");
    } else {
      if (!response.ok) throw new Error("could not recover this request. reload before trying again.");
      const data: unknown = await response.json();
      const operation = readOperation(data && typeof data === "object" && "operation" in data ? data.operation : undefined);
      if (operation.id !== id) throw new Error("invalid operation response.");
      if (operation.state !== "queued" && operation.state !== "running") return operation;
      onStatus(operation.status || "working...");
    }
    await pause(signal);
  }
  signal.throwIfAborted();
  throw new Error("request interrupted.");
}

export async function readOperationResult(operation: Operation): Promise<ChatReply | MusicTrack> {
  if (!operation.result) throw new Error("invalid operation result.");
  const response = Response.json(operation.result, { status: operation.state === "completed" ? 200 : 502 });
  return operation.kind === "music" ? readMusicResponse(response) : readChatReply(response);
}

async function startRequest(url: string, body: Record<string, unknown>, onStatus: (status: string) => void,
  signal: AbortSignal, id: string = crypto.randomUUID()): Promise<Response> {
  const response = await authenticatedFetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, operationId: id }), signal,
  }).catch((error: unknown) => { signal.throwIfAborted(); return error instanceof Error ? error : new Error("connection lost."); });
  if (!(response instanceof Error) && response.status !== 202) return response;
  if (!(response instanceof Error)) {
    const data: unknown = await response.json();
    const operation = readOperation(data && typeof data === "object" && "operation" in data ? data.operation : undefined);
    if (operation.id !== id) throw new Error("invalid operation response.");
  }
  const operation = await waitForOperation(id, onStatus, signal);
  return Response.json(operation.result, { status: operation.state === "completed" ? 200 : 502, headers: { "X-Operation-ID": id } });
}

export async function sendMessage(message: string, audioUrl: string | undefined, musicPrompt: MusicPrompt,
  onStatus: (status: string) => void, signal: AbortSignal, operationId: string): Promise<ChatReply> {
  const response = await startRequest("/api/chat", { message, audioUrl, musicPrompt: JSON.stringify(musicPrompt) }, onStatus, signal, operationId);
  return readChatReply(response);
}

async function readChatReply(response: Response): Promise<ChatReply> {
  const data: unknown = await response.json();

  if (!data || typeof data !== "object") {
    throw new Error("Invalid chat response.");
  }

  const reply = "reply" in data && typeof data.reply === "string" ? data.reply : "";
  const error = "error" in data && typeof data.error === "string" ? data.error : "";

  if (!response.ok || error) {
    throw new OperationError(error || reply || "Chat request failed.", response.headers.get("X-Operation-ID") ?? undefined);
  }

  if (!reply || ("musicPrompt" in data && data.musicPrompt !== undefined &&
      !isMusicPrompt(data.musicPrompt))) {
    throw new Error("Invalid chat response.");
  }

  return {
    operationId: response.headers.get("X-Operation-ID") ?? undefined,
    reply,
    musicPrompt: "musicPrompt" in data && isMusicPrompt(data.musicPrompt)
      ? data.musicPrompt : undefined,
  };
}

export async function uploadAudio(file: File): Promise<AudioTrack> {
  if (!/\.(mp3|wav|flac|ogg)$/i.test(file.name) || !file.size || file.size > 50 * 1024 * 1024) {
    throw new Error("Choose an MP3, WAV, FLAC, or OGG file up to 50 MB.");
  }
  const response = await authenticatedFetch(`/api/audio?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Invalid audio upload response.");
  if (!response.ok) {
    throw new Error("error" in data && typeof data.error === "string" ? data.error : "Audio upload failed.");
  }
  const audio = "audio" in data ? data.audio : undefined;
  if (!audio || typeof audio !== "object" ||
      !("url" in audio) || typeof audio.url !== "string" ||
      !/^\/api\/audio\/[0-9a-f-]{36}\.(mp3|wav|flac|ogg)$/.test(audio.url) ||
      !("name" in audio) || typeof audio.name !== "string") {
    throw new Error("Invalid audio upload response.");
  }
  return { url: audio.url, name: audio.name };
}

export async function generateMusic(fields: MusicPrompt, model: string, onStatus: (status: string) => void, signal: AbortSignal): Promise<MusicTrack> {
  const prompt = formatMusicPrompt(fields);
  if (!prompt.trim() || prompt.length > 10_000) {
    throw new Error("Music prompt must contain 1–10,000 characters.");
  }
  const response = await startRequest("/api/music", { prompt, model }, onStatus, signal);
  return readMusicResponse(response);
}

export async function retrySongStorage(songId: string): Promise<MusicTrack> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(songId)) {
    throw new Error("invalid song reference.");
  }
  const response = await authenticatedFetch(`/api/songs/${songId}/retry`, { method: "POST" });
  return readMusicResponse(response);
}

async function readMusicResponse(response: Response): Promise<MusicTrack> {
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Invalid music response.");
  if (!response.ok || ("error" in data && typeof data.error === "string")) {
    const message = "error" in data && typeof data.error === "string" ? data.error : "Music request failed.";
    if ("songId" in data && typeof data.songId === "string" &&
        /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(data.songId)) {
      throw new SongStorageError(data.songId, message, response.headers.get("X-Operation-ID") ?? undefined);
    }
    throw new OperationError(message, response.headers.get("X-Operation-ID") ?? undefined);
  }
  const track = "track" in data ? data.track : undefined;
  if (!track || typeof track !== "object" ||
      !("url" in track) || typeof track.url !== "string" ||
      !/^\/api\/music\/[0-9a-f-]{36}\.mp3$/.test(track.url) ||
      !("lyrics" in track) || typeof track.lyrics !== "string") {
    throw new Error("Invalid music response.");
  }
  return { url: track.url, lyrics: track.lyrics, operationId: response.headers.get("X-Operation-ID") ?? undefined };
}

export async function resetChat(): Promise<void> {
  const response = await authenticatedFetch("/api/reset", {
    method: "POST",
  });

  const data: unknown = response.ok ? await response.json() : undefined;
  if (!data || typeof data !== "object" || !("status" in data) || data.status !== "ok") {
    throw new Error("Conversation reset failed.");
  }
}
