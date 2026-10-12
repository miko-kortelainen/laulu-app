import { emptyMusicPrompt, formatMusicPrompt, musicPromptFields, type MusicPrompt } from "@/lib/music-prompt";
import type { SavedSong } from "./api";

export function getSongPrompt(song: SavedSong): { prompt: MusicPrompt; originalPrompt?: string } {
  const prompt = { ...emptyMusicPrompt };
  const labels = musicPromptFields.map(({ label }) => label).join("|");
  // shortcut: saved prompts use labeled text; store structured fields if the format changes.
  const sections = [...song.prompt.matchAll(new RegExp(`(?:^|\\n\\n)(${labels}):[ \\t]*\\n?`, "gi"))];
  for (const [index, section] of sections.entries()) {
    const field = musicPromptFields.find(({ label }) => label.toLowerCase() === section[1].toLowerCase())!;
    prompt[field.name] = song.prompt.slice(section.index + section[0].length, sections[index + 1]?.index).trim();
  }
  const originalPrompt = formatMusicPrompt(prompt) === song.prompt.trim() ? undefined : song.prompt;
  prompt.lyrics = song.lyrics || prompt.lyrics;
  return { prompt, originalPrompt };
}
