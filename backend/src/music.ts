import { tool } from '@strands-agents/sdk';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const musicDirectory = fileURLToPath(new URL('../generated-music/', import.meta.url));

export interface MusicTrack {
  url: string;
  lyrics: string;
}

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

export const generateMusicTool = tool({
  name: 'generate_music',
  description:
    'Prepare one self-contained plain-text song prompt for Lyria 3.5 batch generation. ' +
    'Lead with the primary genre, adding an era or regional style when relevant. ' +
    'Describe mood, groove, instrument roles and textures, and production character with concrete musical terms. ' +
    'Include tempo or BPM and key when useful, and duration when requested. Choose coherent details for unspecified preferences without overriding the user. ' +
    'Describe progression and energy changes with section tags or prose, for example [Intro] -> [Verse] -> [Chorus] -> [Bridge] -> [Outro]. ' +
    'For vocals, specify the lyric language and suitable vocal timbre and delivery; add range or harmonies when relevant. ' +
    'Write musical directions in the requested lyric language, otherwise the user\'s language. ' +
    'If lyrics are supplied or explicitly requested from you, put them after the musical directions under Lyrics:, with section tags such as [Verse 1] and [Chorus]. ' +
    'Preserve supplied lyrics verbatim, including casing and line breaks; parentheses may mark backing vocals or ad-libs. ' +
    'Otherwise let Lyria write lyrics: describe the narrative, emotion, and desired hook or key phrases; favor short repeating hooks for dance music. ' +
    'For instrumental requests, explicitly say instrumental only, no vocals, and omit lyrics. ' +
    'Keep the prompt focused and free of Markdown or conversational commentary. Do not use RealTime weights or streaming controls. ' +
    'Each revision must include the full song brief, not references to earlier prompts. ' +
    'This only prepares the prompt: the user must click generate music before audio is generated.',
  inputSchema: {
    type: 'object',
    properties: { prompt: { type: 'string', minLength: 1, maxLength: 10_000 } },
    required: ['prompt'],
    additionalProperties: false,
  },
  callback: (input, context) => {
    const prompt = validateMusicPrompt(record(input).prompt);
    context.invocationState.musicPrompt = prompt;
    return { status: 'awaiting_confirmation', prompt };
  },
});

export async function generateMusic(prompt: string): Promise<MusicTrack> {
  const input = validateMusicPrompt(prompt);
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey === 'your_gemini_api_key_here') {
    throw new Error('set GEMINI_API_KEY in backend/.env to generate music.');
  }

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({ model: 'lyria-3.5', input, store: false }),
    signal: AbortSignal.timeout(300_000),
  }).catch((error: unknown) => {
    throw new Error(error instanceof Error && error.name === 'TimeoutError'
      ? 'music generation timed out. no track was saved.'
      : 'could not reach the music service.');
  });

  if (!response.ok) {
    throw new Error(`music service returned HTTP ${response.status}.`);
  }
  const data = record(await response.json());
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
}
