import { formatMusicPrompt, isMusicPrompt, type MusicPrompt } from "./musicPrompt";

export interface ChatReply {
  reply: string;
  musicPrompt?: MusicPrompt;
  stems?: SeparatedStems;
  cleanedAudio?: AudioTrack;
}

export interface AudioTrack {
  url: string;
  name: string;
}

export interface SeparatedStems {
  vocalsUrl: string;
  instrumentalUrl: string;
}

export interface MusicTrack {
  url: string;
  lyrics: string;
}

async function readChatResponse(response: Response, onStatus: (status: string) => void): Promise<unknown> {
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return response.json();
  if (!response.body) throw new Error('Invalid chat response.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: unknown;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }) + (done ? '\n' : '');
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        const data: unknown = JSON.parse(line);
        if (data && typeof data === 'object' && 'status' in data && typeof data.status === 'string') {
          onStatus(data.status);
        } else {
          result = data;
        }
      }
      if (done) return result;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function sendMessage(message: string, audioUrl: string | undefined, musicPrompt: MusicPrompt, onStatus: (status: string) => void): Promise<ChatReply> {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({ message, audioUrl, musicPrompt: JSON.stringify(musicPrompt) }),
  });
  const data = await readChatResponse(response, onStatus);

  if (!data || typeof data !== "object") {
    throw new Error("Invalid chat response.");
  }

  const reply = "reply" in data && typeof data.reply === "string" ? data.reply : "";
  const error = "error" in data && typeof data.error === "string" ? data.error : "";

  if (!response.ok || error) {
    throw new Error(error || reply || "Chat request failed.");
  }

  if (!reply || ("musicPrompt" in data && data.musicPrompt !== undefined &&
      !isMusicPrompt(data.musicPrompt))) {
    throw new Error("Invalid chat response.");
  }

  const stems = "stems" in data ? data.stems : undefined;
  if (stems !== undefined && (!stems || typeof stems !== "object" ||
      !("vocalsUrl" in stems) || typeof stems.vocalsUrl !== "string" ||
      !/^\/api\/stems\/[0-9a-f-]{36}\/source_vocals\.wav$/.test(stems.vocalsUrl) ||
      !("instrumentalUrl" in stems) || typeof stems.instrumentalUrl !== "string" ||
      stems.instrumentalUrl !== stems.vocalsUrl.replace("source_vocals.wav", "source_instrumental.wav"))) {
    throw new Error("Invalid stem separation response.");
  }

  const cleanedAudio = "cleanedAudio" in data ? data.cleanedAudio : undefined;
  if (cleanedAudio !== undefined && (!cleanedAudio || typeof cleanedAudio !== "object" ||
      !("url" in cleanedAudio) || typeof cleanedAudio.url !== "string" ||
      !/^\/api\/cleaned\/[0-9a-f-]{36}\/source_cleaned\.wav$/.test(cleanedAudio.url) ||
      !("name" in cleanedAudio) || typeof cleanedAudio.name !== "string")) {
    throw new Error("Invalid echo removal response.");
  }

  return {
    reply,
    musicPrompt: "musicPrompt" in data && isMusicPrompt(data.musicPrompt)
      ? data.musicPrompt : undefined,
    stems: stems as SeparatedStems | undefined,
    cleanedAudio: cleanedAudio as AudioTrack | undefined,
  };
}

export async function uploadAudio(file: File): Promise<AudioTrack> {
  if (!/\.(mp3|wav|flac|ogg)$/i.test(file.name) || !file.size || file.size > 50 * 1024 * 1024) {
    throw new Error("Choose an MP3, WAV, FLAC, or OGG file up to 50 MB.");
  }
  const response = await fetch(`/api/audio?name=${encodeURIComponent(file.name)}`, {
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

export async function generateMusic(fields: MusicPrompt, model: string): Promise<MusicTrack> {
  const prompt = formatMusicPrompt(fields);
  if (!prompt.trim() || prompt.length > 10_000) {
    throw new Error("Music prompt must contain 1–10,000 characters.");
  }
  const response = await fetch("/api/music", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, model }),
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
