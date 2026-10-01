import { tool, type ToolContext } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
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
  lyrics: { type: 'string', description: 'Exact supplied or explicitly requested lyrics with section tags. Empty when Lyria should write lyrics or for instrumental music.' },
} as const;

export const generateMusicTool = tool({
  name: 'generate_music',
  description:
    'Prepare one self-contained song brief as editable fields for Lyria 3.5 batch generation. ' +
    'Lead with the primary genre, adding an era or regional style when relevant. ' +
    'Describe mood, groove, instrument roles and textures, and production character with concrete musical terms. ' +
    'Include tempo or BPM and key when useful, and duration when requested. Choose coherent details for unspecified preferences without overriding the user. ' +
    'Describe progression and energy changes with section tags or prose, for example [Intro] -> [Verse] -> [Chorus] -> [Bridge] -> [Outro]. ' +
    'For vocals, specify the lyric language and suitable vocal timbre and delivery; add range or harmonies when relevant. ' +
    'Write musical directions in the requested lyric language, otherwise the user\'s language. ' +
    'If lyrics are supplied or explicitly requested from you, put them in the lyrics field, with section tags such as [Verse 1] and [Chorus]. ' +
    'Preserve supplied lyrics verbatim, including casing and line breaks; parentheses may mark backing vocals or ad-libs. ' +
    'Otherwise let Lyria write lyrics: leave lyrics empty and describe the narrative, emotion, and desired hook or key phrases in vocals; favor short repeating hooks for dance music. ' +
    'For instrumental requests, explicitly say instrumental only, no vocals in the vocals field, and leave lyrics empty. ' +
    'Fill every field with plain text; use an empty string for any field that does not apply. Keep all fields together under 10,000 characters. ' +
    'Keep the prompt focused and free of Markdown or conversational commentary. Do not use RealTime weights or streaming controls. ' +
    'Each revision must include the full song brief, not references to earlier prompts. ' +
    'This only prepares the prompt: the user must click generate music before audio is generated.',
  inputSchema: {
    type: 'object',
    properties: musicPromptProperties,
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
    validateMusicPrompt(Object.values(prompt).join('\n\n'));
    context.invocationState.musicPrompt = prompt;
    return { status: 'awaiting_confirmation', prompt };
  }, {
    name: 'generate_music',
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
}, {
  name: 'generate_audio',
  run_type: 'tool',
  argsConfigPath: [1],
  metadata: { ls_provider: 'google', ls_model_name: 'lyria-3.5' },
});
