import { GoogleGenAI } from '@google/genai';
import { PublicError } from './errors.js';
import { tool, type ToolContext } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { readFileSync } from 'node:fs';
import { generateLyrics, validateLyricOutput } from './lyrics.js';
import { getAiGateway } from './gateway.js';
import { isCount, isRecord } from './validation.js';
import { userDirectory } from './user-files.js';
import { checkSongStorage, musicDirectory, saveSong, validateSongTitle, type SavedSong } from './songs.js';
import { QuotaError, reserveUsage, settleGeneration, songOutputLimit } from './quotas.js';

export { musicDirectory };

export class MusicPromptTokenLimitError extends PublicError {}
export class MusicGenerationError extends PublicError {
  constructor(message: string, readonly confirmedFailure: boolean) { super(message); }
}

export function validateMusicModel(value: unknown = 'lyria-3.5'): 'lyria-3.5' | 'lyria-3-clip-preview' {
  if (value !== 'lyria-3.5' && value !== 'lyria-3-clip-preview') {
    throw new PublicError('choose Lyria 3.5 or Lyria 3 Clip Preview.');
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function musicServiceError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/\b(moderation|safety|prohibited|content[_ -]?(filter(?:ed)?|policy)|copyright|recitation)\b/i.test(message)) {
    return 'this prompt was blocked by music safety checks. edit the prompt or lyrics and try again.';
  }
  const status = record(error).status;
  if (status === 400 || status === 422) {
    return 'the music service could not use this prompt. edit the prompt or lyrics and try again.';
  }
  if (status === 429) return 'the music service is busy. try again in a few minutes.';
  return 'could not generate your track. try again later.';
}

export function validateMusicPrompt(value: unknown): string {
  if (!validMusicPrompt(value)) {
    throw new PublicError('music prompt must contain 1–10,000 characters.');
  }
  return value.trim();
}

function validMusicPrompt(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim() && value.length <= 10_000;
}

const musicPromptProperties = {
  genre: { type: 'string', description: 'Primary genre, era or regional style only. No artist or band names, parenthetical artist references, or artist-inspired labels.' },
  mood: { type: 'string', description: 'Emotion, energy and groove.' },
  key: { type: 'string', description: 'Musical key, for example G major.' },
  bpm: { type: 'string', description: 'Tempo in BPM, with feel or tempo changes when useful.' },
  duration: { type: 'string', description: 'Requested song duration, or empty if unspecified.' },
  instruments: { type: 'string', description: 'Instrument roles and textures.' },
  vocals: { type: 'string', description: 'Lyric language, timbre, delivery, harmonies, and story or hook when Lyria should write lyrics; or instrumental only, no vocals.' },
  production: { type: 'string', description: 'Production character and sound.' },
  lyrics: { type: 'string', maxLength: 3_000, description: 'Current or supplied lyrics, preserved exactly, up to 3,000 characters including section tags and line breaks. To write or revise lyrics, set lyricRequest instead of composing text in this field. Empty when Lyria should write lyrics or for instrumental music.' },
} as const;

export const updateMusicFormTool = tool({
  name: 'update_music_form',
  description: readFileSync(new URL('../prompts/music-form.md', import.meta.url), 'utf8').trim(),
  inputSchema: {
    type: 'object',
    properties: {
      ...musicPromptProperties,
      lyricRequest: { type: 'string', description: 'Optional request for the dedicated lyric agent. Describe the subject, language, requested changes, and sections to preserve. Omit unless writing or revising lyrics.' },
    },
    required: Object.keys(musicPromptProperties),
    additionalProperties: false,
  },
  callback: traceable(async (input: unknown, context: ToolContext) => {
    const fields = record(input);
    const prompt = readMusicForm(fields);
    await applyLyricRequest(prompt, fields.lyricRequest, context);
    context.invocationState.musicPrompt = prompt;
    return { status: 'awaiting_confirmation', prompt };
  }, {
    name: 'update_music_form',
    run_type: 'tool',
    processInputs: ({ args }) => record(args[0]),
  }),
});

function readMusicForm(fields: Record<string, unknown>): Record<string, string> {
  const prompt: Record<string, string> = {};
  for (const name of Object.keys(musicPromptProperties)) {
    if (typeof fields[name] !== 'string') throw new Error(`music prompt field ${name} must be text.`);
    prompt[name] = fields[name];
  }
  if (prompt.lyrics.length > 3_000) throw new Error('lyrics must contain at most 3,000 characters.');
  validateMusicPrompt(Object.values(prompt).join('\n\n'));
  return prompt;
}

async function applyLyricRequest(prompt: Record<string, string>, value: unknown, context: ToolContext): Promise<void> {
  const request = readLyricRequest(value);
  if (request === undefined) return;
  if (context.invocationState.lyricGenerationAttempted) {
    throw new Error('only one lyric generation attempt is allowed per message. send a new message to try again.');
  }
  context.invocationState.lyricGenerationAttempted = true;
  const userId = context.invocationState.userId;
  if (typeof userId !== 'string') throw new Error('a verified user is required for lyrics.');
  const lyrics = await generateLyrics(prompt, request, userId).catch((error: unknown) => {
    if (error instanceof QuotaError) context.invocationState.quotaError = error;
    throw error;
  });
  // shortcut: preserve usable partial lyrics, even mid-section; change only with an explicit replacement policy.
  prompt.lyrics = validateLyricOutput(lyrics.slice(0, 3_000));
  validateMusicPrompt(Object.values(prompt).join('\n\n'));
}

function readLyricRequest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  return validateMusicPrompt(value);
}

interface MusicRequest {
  prompt: string;
  modelId?: unknown;
  userId: string;
  operationId?: string;
  title?: string;
}

export const generateMusic = traceable(async (
  { prompt, modelId = 'lyria-3.5', userId, operationId, title = 'untitled' }: MusicRequest,
  _traceConfig?: { metadata: { thread_id: string; ls_model_name?: string } },
): Promise<SavedSong> => {
  const input = validateMusicPrompt(prompt);
  const model = validateMusicModel(modelId);
  const songTitle = validateSongTitle(title);
  userDirectory(musicDirectory, userId);
  const gateway = getAiGateway('google-ai-studio');
  await checkSongStorage(userId);

  const client = new GoogleGenAI({
    apiKey: 'byok',
    httpOptions: { baseUrl: gateway.baseURL, fetch: gateway.fetch },
  });
  await checkMusicTokens(client, model, input);

  const songId = await reserveUsage(userId, 'generation', songOutputLimit(), operationId);
  let audio: Buffer | undefined;
  let confirmedFailure = false;
  let lyrics: string[] = [];
  try {
    const data = await client.interactions.create({
      model, input, store: false,
    }, { timeout: 300_000, maxRetries: 0 });
    confirmedFailure = ['completed', 'failed', 'cancelled', 'incomplete', 'budget_exceeded'].includes(data.status);
    ({ audio, lyrics } = completedMusic(data));
  } catch (error: unknown) {
    return failGeneration(error, { confirmedFailure, userId, songId });
  }

  const text = lyrics.join('\n')
    .replace(/\[\[[^\]\r\n]*\]\]/g, '')
    .replace(/^[ \t]*\[:\][ \t]*/gm, '')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
  return saveSong(userId, audio, { prompt: input, model, lyrics: text, id: songId, title: songTitle });
}, {
  name: 'generate_audio',
  run_type: 'tool',
  argsConfigPath: [1],
  metadata: { ls_provider: 'google' },
});

function completedMusic(data: { status: string; steps?: unknown[]; errors?: unknown[] }): { audio: Buffer; lyrics: string[] } {
  if (data.status !== 'completed' || !Array.isArray(data.steps)) {
    throw musicOutputError(data.errors, 'music service did not return a completed track.');
  }
  const { audio, lyrics } = readMusicOutput(data.steps);
  if (!audio?.length) throw musicOutputError(data.errors, 'music service returned no audio.');
  return { audio, lyrics };
}

function musicOutputError(errors: unknown[] | undefined, fallback: string): Error {
  return new Error(errors?.length ? JSON.stringify(errors) : fallback);
}

async function checkMusicTokens(client: GoogleGenAI, model: string, input: string): Promise<void> {
  const tokenData = await client.models.countTokens({
    model,
    contents: input,
    config: { httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } },
  }).catch((error: unknown) => {
    console.error('music token counting failed:', error);
    throw new PublicError('could not check your prompt. generation was not started. try again later.');
  });
  const totalTokens = tokenData.totalTokens;
  if (!isCount(totalTokens)) {
    throw new PublicError('could not check your prompt. generation was not started. try again later.');
  }
  if (totalTokens > 131_072) {
    throw new MusicPromptTokenLimitError(`music prompt contains ${totalTokens.toLocaleString('en-US')} tokens; the ${model} input limit is 131,072. shorten the prompt and try again.`);
  }

}

async function failGeneration(error: unknown, { confirmedFailure, userId, songId }: { confirmedFailure: boolean; userId: string; songId: string }): Promise<never> {
  console.error('music generation failed:', error);
  const failed = confirmedFailure || rejectedGeneration(error);
  let settlementError: string | undefined;
  if (failed) {
    await settleGeneration(userId, songId, 'failed').catch((cause: unknown) => {
      console.error('could not refund failed generation:', cause);
      settlementError = ' could not restore your song allowance. contact support.';
    });
  }
  const message = failed ? musicServiceError(error) : 'could not confirm whether your track finished.';
  throw new MusicGenerationError(message +
    (settlementError ?? (failed ? '' : ' the outcome is unknown; your song allowance remains reserved.')), failed);
}

function rejectedGeneration(error: unknown): boolean {
  return error instanceof Error && 'status' in error && typeof error.status === 'number' && [400, 401, 403, 404, 422, 429].includes(error.status);
}

function readMusicOutput(steps: unknown[]): { audio?: Buffer; lyrics: string[] } {
  let audio: Buffer | undefined;
  const lyrics: string[] = [];
  for (const value of musicContent(steps)) {
    const block = record(value);
    if (block.type === 'text' && typeof block.text === 'string') lyrics.push(block.text);
    if (block.type === 'audio') audio = readAudioBlock(block);
  }
  return { audio, lyrics };
}

function* musicContent(steps: unknown[]): Generator<unknown> {
  for (const value of steps) {
    const step = record(value);
    if (step.type !== 'model_output') continue;
    if (step.error) throw new Error(JSON.stringify(step.error));
    if (Array.isArray(step.content)) yield* step.content;
  }
}

function readAudioBlock(block: Record<string, unknown>): Buffer {
  if (!['audio/mpeg', 'audio/mp3'].some(mime => mime === block.mime_type) || !validBase64(block.data)) {
    throw new Error('music service returned invalid MP3 audio.');
  }
  return Buffer.from(block.data, 'base64');
}

function validBase64(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}
