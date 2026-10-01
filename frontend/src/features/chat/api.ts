export interface ChatReply {
  reply: string;
  musicPrompt?: string;
}

export interface MusicTrack {
  url: string;
  lyrics: string;
}

export async function sendMessage(message: string): Promise<ChatReply> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const data: unknown = await response.json();

  if (!data || typeof data !== "object") {
    throw new Error("Invalid chat response.");
  }

  const reply = "reply" in data && typeof data.reply === "string" ? data.reply : "";
  const error = "error" in data && typeof data.error === "string" ? data.error : "";

  if (!response.ok) {
    throw new Error(error || reply || "Chat request failed.");
  }

  if (!reply || ("musicPrompt" in data && data.musicPrompt !== undefined &&
      (typeof data.musicPrompt !== "string" || !data.musicPrompt.trim()))) {
    throw new Error("Invalid chat response.");
  }

  return {
    reply,
    musicPrompt: "musicPrompt" in data && typeof data.musicPrompt === "string"
      ? data.musicPrompt : undefined,
  };
}

export async function generateMusic(prompt: string): Promise<MusicTrack> {
  const response = await fetch("/api/music", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  const data: unknown = await response.json();
  if (!data || typeof data !== "object") throw new Error("Invalid music response.");
  if (!response.ok) {
    throw new Error("error" in data && typeof data.error === "string"
      ? data.error : "Music generation failed.");
  }
  const track = "track" in data ? data.track : undefined;
  if (!track || typeof track !== "object" ||
      !("url" in track) || typeof track.url !== "string" ||
      !/^\/api\/music\/[0-9a-f-]{36}\.mp3$/.test(track.url) ||
      !("lyrics" in track) || typeof track.lyrics !== "string") {
    throw new Error("Invalid music response.");
  }
  return { url: track.url, lyrics: track.lyrics };
}

export async function resetChat(): Promise<void> {
  const response = await fetch("/api/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: "default" }),
  });

  if (!response.ok) {
    throw new Error("Conversation reset failed.");
  }
}
