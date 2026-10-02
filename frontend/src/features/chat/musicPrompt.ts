export const musicPromptFields = [
  { name: "genre", label: "genre / style" },
  { name: "mood", label: "mood" },
  { name: "key", label: "key" },
  { name: "bpm", label: "BPM" },
  { name: "duration", label: "duration" },
  { name: "vocals", label: "vocals / language" },
  { name: "instruments", label: "instruments", multiline: true },
  { name: "production", label: "production", multiline: true },
  { name: "structure", label: "song structure", multiline: true },
  { name: "lyrics", label: "lyrics", multiline: true },
] as const;

export type MusicPrompt = Record<(typeof musicPromptFields)[number]["name"], string>;

export const emptyMusicPrompt: MusicPrompt = {
  genre: "", mood: "", key: "", bpm: "", duration: "", vocals: "",
  instruments: "", production: "", structure: "", lyrics: "",
};

export function isMusicPrompt(value: unknown): value is MusicPrompt {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return musicPromptFields.every(({ name }) => typeof fields[name] === "string") &&
    musicPromptFields.some(({ name }) => typeof fields[name] === "string" && fields[name].trim());
}

export function formatMusicPrompt(prompt: MusicPrompt): string {
  return musicPromptFields.flatMap(({ name, label }) => {
    const value = prompt[name];
    if (!value.trim()) return [];
    return [name === "lyrics" ? `Lyrics:\n${value}` : `${label}: ${value}`];
  }).join("\n\n");
}
