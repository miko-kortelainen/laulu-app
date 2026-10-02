import { GoogleGenAI } from '@google/genai';
import { tool, type ToolContext } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generateLyrics } from './lyrics.js';

export const musicDirectory = fileURLToPath(new URL('../generated-music/', import.meta.url));

export interface MusicTrack {
  url: string;
  lyrics: string;
}

export class MusicPromptTokenLimitError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function validateMusicPrompt(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 10_000) {
    throw new Error('music prompt must contain 1–10,000 characters.');
  }
  return value.trim();
}

const musicPromptProperties = {
  genre: { type: 'string', description: 'Primary genre, era or regional style.' },
  mood: { type: 'string', description: 'Emotion, energy and groove.' },
  key: { type: 'string', description: 'Musical key, for example G major.' },
  bpm: { type: 'string', description: 'Tempo in BPM, with feel or tempo changes when useful.' },
  duration: { type: 'string', description: 'Requested song duration, or empty if unspecified.' },
  instruments: { type: 'string', description: 'Instrument roles and textures.' },
  vocals: { type: 'string', description: 'Lyric language, timbre, delivery, harmonies, and story or hook when Lyria should write lyrics; or instrumental only, no vocals.' },
  production: { type: 'string', description: 'Production character and sound.' },
  structure: { type: 'string', description: 'Song sections, progression and energy changes.' },
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
    const prompt: Record<string, string> = {};
    for (const name of Object.keys(musicPromptProperties)) {
      if (typeof fields[name] !== 'string') throw new Error(`music prompt field ${name} must be text.`);
      prompt[name] = fields[name];
    }
    if (prompt.lyrics.length > 3_000) throw new Error('lyrics must contain at most 3,000 characters.');
    validateMusicPrompt(Object.values(prompt).join('\n\n'));
    if (fields.lyricRequest !== undefined) {
      const request = validateMusicPrompt(fields.lyricRequest);
      if (context.invocationState.lyricGenerationAttempted) {
        throw new Error('only one lyric generation attempt is allowed per message. send a new message to try again.');
      }
      context.invocationState.lyricGenerationAttempted = true;
      prompt.lyrics = validateMusicPrompt((await generateLyrics(prompt, request)).slice(0, 3_000));
      validateMusicPrompt(Object.values(prompt).join('\n\n'));
    }
    context.invocationState.musicPrompt = prompt;
    return { status: 'awaiting_confirmation', prompt };
  }, {
    name: 'update_music_form',
    run_type: 'tool',
    processInputs: ({ args }) => record(args[0]),
  }),
});

export const generateMusic = traceable(async (
  prompt: string,
  _traceConfig?: { metadata: { thread_id: string } },
): Promise<MusicTrack> => {
  const input = validateMusicPrompt(prompt);
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    throw new Error('set GEMINI_API_KEY in backend/.env to generate music.');
  }

  const client = new GoogleGenAI({ apiKey });
  const tokenData = await client.models.countTokens({
    model: 'lyria-3.5',
    contents: input,
    config: { httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } },
  }).catch((error: unknown) => {
    throw new Error(`music token counting failed. generation was not started. ${error instanceof Error ? error.message : 'unknown service error.'}`);
  });
  const totalTokens = tokenData.totalTokens;
  if (typeof totalTokens !== 'number' || !Number.isSafeInteger(totalTokens) || totalTokens < 0) {
    throw new Error('music token counting returned an invalid count. generation was not started.');
  }
  if (totalTokens > 131_072) {
    throw new MusicPromptTokenLimitError(`music prompt contains ${totalTokens.toLocaleString('en-US')} tokens; the Lyria 3.5 input limit is 131,072. shorten the prompt and try again.`);
  }

  const data = await client.interactions.create({
    model: 'lyria-3.5', input, store: false,
  }, { timeout: 300_000, maxRetries: 0 }).catch((error: unknown) => {
    throw new Error(`music generation failed. ${error instanceof Error ? error.message : 'unknown service error.'}`);
  });
  if (data.status !== 'completed' || !Array.isArray(data.steps)) {
    throw new Error('music service did not return a completed track.');
  }

  let audio: Buffer | undefined;
  const lyrics: string[] = [];
  for (const value of data.steps) {
    const step = record(value);
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue;

    for (const value of step.content) {
      const block = record(value);
      if (block.type === 'text' && typeof block.text === 'string') lyrics.push(block.text);
      if (block.type !== 'audio') continue;
      if ((block.mime_type !== 'audio/mpeg' && block.mime_type !== 'audio/mp3') ||
          typeof block.data !== 'string' || !block.data ||
          block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(block.data)) {
        throw new Error('music service returned invalid MP3 audio.');
      }
      audio = Buffer.from(block.data, 'base64');
    }
  }
  if (!audio?.length) throw new Error('music service returned no audio.');

  const filename = `${randomUUID()}.mp3`;
  await mkdir(musicDirectory, { recursive: true });
  await writeFile(`${musicDirectory}${filename}`, audio, { flag: 'wx' });
  const text = lyrics.join('\n')
    .replace(/\[\[[^\]\r\n]*\]\]/g, '')
    .replace(/^[ \t]*\[:\][ \t]*/gm, '')
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
  return { url: `/api/music/${filename}`, lyrics: text };
}, {
  name: 'generate_audio',
  run_type: 'tool',
  argsConfigPath: [1],
  metadata: { ls_provider: 'google', ls_model_name: 'lyria-3.5' },
});
