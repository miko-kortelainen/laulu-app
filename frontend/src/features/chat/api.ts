import { formatMusicPrompt, isMusicPrompt, type MusicPrompt } from "@/lib/music-prompt";
import { authenticatedFetch } from "@/lib/api";
import { formatDate } from "@/lib/date";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readObject(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(message);
  return value;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function isCount(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatResetDate(message: string, data: Record<string, unknown>): string {
  return typeof data.resetAt === "string" && Number.isFinite(Date.parse(data.resetAt))
    ? message.replace(data.resetAt, formatDate(data.resetAt, true)) : message;
}

export interface ChatReply {
  operationId?: string;
  reply: string;
  musicPrompt?: MusicPrompt;
}

export interface ChatContext {
  messages: number;
  limit: number;
}

export async function getChatContext(): Promise<ChatContext> {
  const response = await authenticatedFetch("/api/context");
  if (!response.ok) throw new Error("could not load conversation context.");
  const data = readObject(await response.json(), "invalid conversation context response.");
  if (!isCount(data.messages, 0) || !isCount(data.limit, 1)) {
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
  title: string;
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
  const data = readObject(value, "invalid operation response.");
  if (!isOperation(data)) throw new Error("invalid operation response.");
  return data;
}

function isOperation(data: Record<string, unknown>): data is Record<string, unknown> & Operation {
  return isUuid(data.id) && ["music", "chat"].some(kind => kind === data.kind) &&
    ["queued", "running", "completed", "failed", "unknown"].some(state => state === data.state) &&
    typeof data.status === "string" && (data.result === null || isRecord(data.result));
}

async function readOperationResponse(response: Response, id: string): Promise<Operation> {
  if (!response.ok) throw new Error("could not recover this request. reload before trying again.");
  const data = readObject(await response.json(), "invalid operation response.");
  const operation = readOperation(data.operation);
  if (operation.id !== id) throw new Error("invalid operation response.");
  return operation;
}

export async function getOperations(signal: AbortSignal, onStatus: (status: string) => void): Promise<Operation[]> {
  const response = await fetchOperation("/api/operations", { signal }, onStatus);
  if (!response.ok) throw new Error("could not recover requests. reload to try again.");
  const data = readObject(await response.json(), "invalid operation response.");
  if (!Array.isArray(data.operations)) {
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
      await pause(signal);
      continue;
    }
    const operation = await readOperationResponse(response, id);
    if (!["queued", "running"].includes(operation.state)) return operation;
    onStatus(operation.status || "working...");
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

interface RequestOptions {
  onStatus: (status: string) => void;
  signal: AbortSignal;
  operationId?: string;
}

async function startRequest(url: string, body: Record<string, unknown>,
  { onStatus, signal, operationId: id = crypto.randomUUID() }: RequestOptions): Promise<Response> {
  const response = await authenticatedFetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, operationId: id }), signal,
  }).catch((error: unknown) => { signal.throwIfAborted(); return error instanceof Error ? error : new Error("connection lost."); });
  if (!(response instanceof Error) && response.status !== 202) return response;
  if (!(response instanceof Error)) {
    await readOperationResponse(response, id);
  }
  const operation = await waitForOperation(id, onStatus, signal);
  return Response.json(operation.result, { status: operation.state === "completed" ? 200 : 502, headers: { "X-Operation-ID": id } });
}

export async function sendMessage(request: { message: string; audioUrl?: string; musicPrompt: MusicPrompt },
  options: RequestOptions & { operationId: string }): Promise<ChatReply> {
  const response = await startRequest("/api/chat", { ...request, musicPrompt: JSON.stringify(request.musicPrompt) }, options);
  return readChatReply(response);
}

async function readChatReply(response: Response): Promise<ChatReply> {
  const data = readObject(await response.json(), "Invalid chat response.");
  const reply = stringOrEmpty(data.reply);
  const error = stringOrEmpty(data.error);
  const operationId = response.headers.get("X-Operation-ID") ?? undefined;

  if (!response.ok || error) {
    throw new OperationError(formatResetDate(error || reply || "Chat request failed.", data), operationId);
  }

  if (!reply) throw new Error("Invalid chat response.");
  return {
    operationId,
    reply,
    musicPrompt: readMusicPrompt(data.musicPrompt),
  };
}

function readMusicPrompt(value: unknown): MusicPrompt | undefined {
  if (value === undefined) return undefined;
  if (!isMusicPrompt(value)) throw new Error("Invalid chat response.");
  return value;
}

export async function uploadAudio(file: File): Promise<AudioTrack> {
  if (!isUploadableAudio(file)) {
    throw new Error("Choose an MP3, WAV, FLAC, or OGG file up to 50 MB.");
  }
  const response = await authenticatedFetch(`/api/audio?name=${encodeURIComponent(file.name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: file,
  });
  const data = readObject(await response.json(), "Invalid audio upload response.");
  if (!response.ok) {
    throw new Error(typeof data.error === "string" ? data.error : "Audio upload failed.");
  }
  return readAudioTrack(data.audio);
}

function isUploadableAudio(file: File): boolean {
  return /\.(mp3|wav|flac|ogg)$/i.test(file.name) && file.size > 0 && file.size <= 50 * 1024 * 1024;
}

function readAudioTrack(value: unknown): AudioTrack {
  const audio = readObject(value, "Invalid audio upload response.");
  if (typeof audio.url !== "string") throw new Error("Invalid audio upload response.");
  if (!/^\/api\/audio\/[0-9a-f-]{36}\.(mp3|wav|flac|ogg)$/.test(audio.url) || typeof audio.name !== "string") {
    throw new Error("Invalid audio upload response.");
  }
  return { url: audio.url, name: audio.name };
}

export async function generateMusic({ fields, model, title }: { fields: MusicPrompt; model: string; title: string },
  options: RequestOptions): Promise<MusicTrack> {
  const prompt = formatMusicPrompt(fields);
  if (!prompt.trim() || prompt.length > 10_000) {
    throw new Error("Music prompt must contain 1–10,000 characters.");
  }
  const response = await startRequest("/api/music", { prompt, model, title }, options);
  return readMusicResponse(response);
}

export async function retrySongStorage(songId: string): Promise<MusicTrack> {
  if (!isUuid(songId)) {
    throw new Error("invalid song reference.");
  }
  const response = await authenticatedFetch(`/api/songs/${songId}/retry`, { method: "POST" });
  return readMusicResponse(response);
}

async function readMusicResponse(response: Response): Promise<MusicTrack> {
  const data = readObject(await response.json(), "Invalid music response.");
  const operationId = response.headers.get("X-Operation-ID") ?? undefined;
  if (!response.ok || typeof data.error === "string") {
    const message = formatResetDate(typeof data.error === "string" ? data.error : "Music request failed.", data);
    if (isUuid(data.songId)) {
      throw new SongStorageError(data.songId, message, operationId);
    }
    throw new OperationError(message, operationId);
  }
  return { ...readMusicTrack(data.track), operationId };
}

function readMusicTrack(value: unknown): Omit<MusicTrack, "operationId"> {
  const track = readObject(value, "Invalid music response.");
  if (typeof track.url !== "string") throw new Error("Invalid music response.");
  if (!/^\/api\/music\/[0-9a-f-]{36}\.mp3$/.test(track.url) || typeof track.lyrics !== "string") {
    throw new Error("Invalid music response.");
  }
  return { url: track.url, lyrics: track.lyrics, title: readSongTitle(track.title) };
}

function readSongTitle(value: unknown): string {
  if (value === undefined) return "untitled";
  if (typeof value !== "string" || value.length > 200) throw new Error("Invalid music response.");
  return value.trim() || "untitled";
}

export async function resetChat(): Promise<void> {
  const response = await authenticatedFetch("/api/reset", {
    method: "POST",
  });

  if (!response.ok) throw new Error("Conversation reset failed.");
  const data = readObject(await response.json(), "Conversation reset failed.");
  if (data.status !== "ok") {
    throw new Error("Conversation reset failed.");
  }
}
