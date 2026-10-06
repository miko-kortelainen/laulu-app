import { authenticatedFetch } from "@/lib/api";

export interface SavedSong {
  id: string;
  url: string;
  prompt: string;
  lyrics: string;
  model: string;
  createdAt: string;
}

function isSavedSong(value: unknown): value is SavedSong {
  return !!value && typeof value === "object" &&
    "id" in value && typeof value.id === "string" &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.id) &&
    "url" in value && value.url === `/api/music/${value.id}.mp3` &&
    "prompt" in value && typeof value.prompt === "string" &&
    "lyrics" in value && typeof value.lyrics === "string" &&
    "model" in value && typeof value.model === "string" &&
    "createdAt" in value && typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt));
}

export async function getSongs(signal: AbortSignal): Promise<SavedSong[]> {
  const response = await authenticatedFetch("/api/songs", { signal });
  if (!response.ok) throw new Error("could not load your songs. try again.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("songs" in data) || !Array.isArray(data.songs)) {
    throw new Error("invalid songs response. try again.");
  }
  const songs: unknown[] = data.songs;
  if (!songs.every(isSavedSong)) throw new Error("invalid songs response. try again.");
  return songs;
}
