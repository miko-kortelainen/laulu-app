import { tool, type ToolContext } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { wrapOpenAI } from 'langsmith/wrappers/openai';
import { readFileSync } from 'node:fs';
import OpenAI from 'openai';
import { prepareAnalysisAudio } from './audio.js';
import { getAiGateway } from './gateway.js';

const model = 'qwen3.8-omni-flash';
const instructions = readFileSync(new URL('../prompts/analysis.md', import.meta.url), 'utf8').trim();

export async function analyzeAudio(audioUrl: unknown, question: unknown, userId: unknown): Promise<string> {
  if (typeof question !== 'string' || !question.trim() || question.length > 2_000) {
    throw new Error('audio analysis question must contain 1–2,000 characters.');
  }
  const gateway = getAiGateway('qwencloud', model);
  const audio = await prepareAnalysisAudio(audioUrl, userId);
  // Trace the question and source URL, never the audio bytes or credentials.
  const tracingOptions = {
    name: 'QwenOmni',
    metadata: { ls_provider: 'qwencloud', ls_model_name: model },
    processInputs: () => ({ model, audio_url: audioUrl, question, instructions }),
  };
  const client = wrapOpenAI(new OpenAI({
    apiKey: 'byok',
    baseURL: gateway.baseURL,
    fetch: gateway.fetch,
    maxRetries: 0,
    timeout: 120_000,
  }), tracingOptions);
  const stream = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `${instructions}\n\nquestion: ${question.trim()}` },
      { type: 'input_audio', input_audio: { data: `data:;base64,${audio.data}`, format: audio.format } },
    ] }],
    max_tokens: 2_048,
    reasoning_effort: 'none',
    stream: true,
    stream_options: { include_usage: true },
  }, { signal: AbortSignal.timeout(120_000) });
  let answer = '';
  let finishReason: string | null | undefined;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    answer += choice?.delta.content ?? '';
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }
  if (finishReason !== 'stop' || !answer.trim()) {
    throw new Error('audio analysis did not return a complete answer. try again.');
  }
  return answer.trim();
}

export const analyzeAudioTool = tool({
  name: 'analyze_audio',
  description: 'Listen to an available generated track, upload, stem, or cleaned audio using Qwen Omni. ' +
    'Call when the user requests analysis, feedback, or a description of the actual audio. ' +
    'Use an exact available audio URL and a specific question in the user\'s language. Never invent URLs. ' +
    'Makes one paid QwenCloud call; at most one attempt per user message. ' +
    'Returns listening observations, not precise signal measurements. Never claim success after a failure.',
  inputSchema: {
    type: 'object',
    properties: { audio_url: { type: 'string' }, question: { type: 'string', maxLength: 2_000 } },
    required: ['audio_url', 'question'],
    additionalProperties: false,
  },
  callback: traceable(async (input: unknown, context: ToolContext) => {
    if (context.invocationState.audioAnalysisAttempted) {
      throw new Error('only one audio analysis attempt is allowed per message. send a new message to try again.');
    }
    context.invocationState.audioAnalysisAttempted = true;
    const fields = input && typeof input === 'object' ? input : {};
    return await analyzeAudio('audio_url' in fields ? fields.audio_url : undefined,
      'question' in fields ? fields.question : undefined, context.invocationState.userId);
  }, {
    name: 'analyze_audio', run_type: 'tool',
    processInputs: ({ args }) => ({ request: args[0] }),
  }),
});
