import { Agent, MaxTokensError } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { readFileSync } from 'node:fs';
import { createNebiusModel, getLyricsModelId } from './model.js';
import { reserveLyrics } from './quotas.js';

export function countLyricCharacters(lyrics: string): number {
  return lyrics.length;
}

export interface LyricSection {
  name: string;
  lines: string[];
}

export function lyricSections(lyrics: string): LyricSection[] {
  const sections: LyricSection[] = [];
  let current: LyricSection | undefined;
  for (const line of lyrics.split(/\r?\n/)) {
    const tag = /^\s*\[([^\]\r\n]+)\]\s*$/.exec(line);
    if (tag) {
      current = { name: tag[1].trim().toLowerCase().replace(/\s*\d+$/, ''), lines: [] };
      sections.push(current);
    } else if (current && line.trim()) {
      current.lines.push(line);
    }
  }
  return sections;
}

export function countLyricLines(lyrics: string): number {
  return lyrics.split(/\r?\n/).filter((line) => line.trim() && !/^\s*\[[^\]\r\n]+\]\s*$/.test(line)).length;
}

export function validateLyricOutput(lyrics: string): string {
  if (!lyrics.trim()) throw new Error('generated lyrics are empty. send a new message to try again.');
  if (countLyricCharacters(lyrics) > 3_000) {
    throw new Error('generated lyrics exceed 3,000 characters. send a new message to try again.');
  }
  // shortcut: section lengths stay advisory until revision scope and per-section requirements are explicit inputs.
  return lyrics;
}

export const generateLyrics = traceable(async (
  brief: Record<string, string>,
  request: string,
  userId: string,
): Promise<string> => {
  const model = createNebiusModel(getLyricsModelId());
  // The completion budget includes reasoning and the finished lyric text.
  model.updateConfig({ maxTokens: 8192, params: { reasoning_effort: 'low' } });
  const agent = new Agent({
    model,
    systemPrompt: readFileSync(new URL('../prompts/lyrics.md', import.meta.url), 'utf8').trim(),
    printer: false,
    retryStrategy: null,
  });
  await reserveLyrics(userId);
  const result = await agent.invoke(JSON.stringify({ request, brief }), {
    cancelSignal: AbortSignal.timeout(120_000),
    limits: { turns: 1 },
  }).catch((error: unknown) => {
    if (!(error instanceof MaxTokensError)) throw error;
    const lyrics = error.partialMessage.content
      .flatMap((block) => block.type === 'textBlock' ? [block.text] : []).join('');
    if (!lyrics.trim()) throw error;
    return lyrics;
  });
  if (typeof result === 'string') return result;
  if (result.stopReason !== 'endTurn') {
    throw new Error('lyric generation did not finish. try again.');
  }
  return result.toString();
}, { name: 'generate_lyrics', run_type: 'chain' });
