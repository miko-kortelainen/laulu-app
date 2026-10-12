import { emptyMusicPrompt, formatMusicPrompt, musicPromptFields, type MusicPrompt } from "@/lib/music-prompt";
import type { SavedSong } from "./api";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getSongPrompt(song: SavedSong): { prompt: MusicPrompt; originalPrompt?: string } {
  const prompt = { ...emptyMusicPrompt };
  const fieldByLabel = new Map(musicPromptFields.map((field) => [field.label.toLowerCase(), field]));
  const fieldOrder = new Map(musicPromptFields.map((field, index) => [field.name, index]));
  const labels = musicPromptFields.map(({ label }) => escapeRegExp(label)).join("|");
  // shortcut: saved prompts use labeled text in field order; store structured fields if the format changes.
  // Only accept headers in field order so label-like lines inside a value stay part of that value.
  const matches = [...song.prompt.matchAll(new RegExp(`(?:^|\\n\\n)(${labels}):[ \\t]*\\n?`, "gi"))];
  const sections: { field: (typeof musicPromptFields)[number]; index: number; valueStart: number }[] = [];
  for (const match of matches) {
    const field = fieldByLabel.get(match[1].toLowerCase());
    if (!field) continue;
    const previous = sections[sections.length - 1];
    if (previous && (fieldOrder.get(field.name) ?? 0) <= (fieldOrder.get(previous.field.name) ?? 0)) continue;
    sections.push({ field, index: match.index, valueStart: match.index + match[0].length });
  }
  for (const [index, section] of sections.entries()) {
    prompt[section.field.name] = song.prompt.slice(section.valueStart, sections[index + 1]?.index).trim();
  }
  const originalPrompt = formatMusicPrompt(prompt) === song.prompt.trim() ? undefined : song.prompt;
  prompt.lyrics = song.lyrics || prompt.lyrics;
  return { prompt, originalPrompt };
}
