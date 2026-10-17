import { authenticatedFetch } from "@/lib/api";

const songIdPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export interface SavedSong {
  id: string;
  title: string;
  isFavourite: boolean;
  url: string;
  prompt: string;
  lyrics: string;
  model: string;
  createdAt: string;
}

function isSavedSong(value: unknown): value is SavedSong {
  return !!value && typeof value === "object" &&
    "id" in value && typeof value.id === "string" &&
    songIdPattern.test(value.id) &&
    "title" in value && typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 200 &&
    "isFavourite" in value && typeof value.isFavourite === "boolean" &&
    "url" in value && value.url === `/api/music/${value.id}.mp3` &&
    "prompt" in value && typeof value.prompt === "string" &&
    "lyrics" in value && typeof value.lyrics === "string" &&
    "model" in value && typeof value.model === "string" &&
    "createdAt" in value && typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt));
}

export const songsPageSize = 50;

export async function getSongs(signal: AbortSignal, before?: SavedSong, favourites = false): Promise<SavedSong[]> {
  const query = new URLSearchParams();
  if (before) query.set("before", `${before.createdAt},${before.id}`);
  if (favourites) query.set("favourites", "true");
  const response = await authenticatedFetch(`/api/songs${query.size ? `?${query}` : ""}`, { signal });
  if (!response.ok) throw new Error("could not load your songs. try again.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("songs" in data) || !Array.isArray(data.songs)) {
    throw new Error("invalid songs response. try again.");
  }
  const songs: unknown[] = data.songs;
  if (songs.length > songsPageSize || !songs.every(isSavedSong)) throw new Error("invalid songs response. try again.");
  return songs;
}

export async function setSongFavourite(id: string, isFavourite: boolean, signal: AbortSignal): Promise<void> {
  if (!songIdPattern.test(id)) throw new Error("invalid song reference.");
  const response = await authenticatedFetch(`/api/songs/${id}/favourite`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isFavourite }), signal,
  });
  if (response.status !== 204) throw new Error("could not update favourite. try again.");
}

export async function deleteSavedSong(id: string, signal: AbortSignal): Promise<void> {
  if (!songIdPattern.test(id)) throw new Error("invalid song reference.");
  const response = await authenticatedFetch(`/api/songs/${id}`, { method: "DELETE", signal });
  if (response.status !== 204) throw new Error("could not delete the song. try deleting again.");
}

export async function getSongRecovery(signal: AbortSignal): Promise<string[]> {
  const response = await authenticatedFetch("/api/songs/recovery", { signal });
  if (!response.ok) throw new Error("could not load unsaved songs. try again.");
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || !("songIds" in data) || !Array.isArray(data.songIds) ||
      !data.songIds.every((id: unknown) => typeof id === "string" && songIdPattern.test(id))) {
    throw new Error("invalid unsaved songs response. try again.");
  }
  return [...new Set<string>(data.songIds)];
}

export async function retrySongStorage(id: string, signal: AbortSignal): Promise<SavedSong> {
  if (!songIdPattern.test(id)) throw new Error("invalid song reference.");
  const response = await authenticatedFetch(`/api/songs/${id}/retry`, { method: "POST", signal });
  const data: unknown = await response.json();
  if (!response.ok) {
    throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string"
      ? data.error : "could not save the song. try saving again.");
  }
  if (!data || typeof data !== "object" || !("track" in data) || !isSavedSong(data.track) || data.track.id !== id) {
    throw new Error("invalid saved song response. try saving again.");
  }
  return data.track;
}
