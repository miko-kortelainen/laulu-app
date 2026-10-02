import { Agent, MaxTokensError } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { readFileSync } from 'node:fs';
import { createNebiusModel } from './model.js';

export const generateLyrics = traceable(async (
  brief: Record<string, string>,
  request: string,
): Promise<string> => {
  const model = createNebiusModel(process.env.LYRICS_MODEL?.trim() || 'zai-org/GLM-5.3-Flash');
  // The completion budget includes reasoning and the finished lyric text.
  model.updateConfig({ maxTokens: 8192, params: { reasoning_effort: 'low' } });
  const agent = new Agent({
    model,
    systemPrompt: readFileSync(new URL('../prompts/lyrics.md', import.meta.url), 'utf8').trim(),
    printer: false,
    retryStrategy: null,
  });
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
