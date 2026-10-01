import { tool, type ToolContext } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { musicDirectory } from './music.js';

export const audioDirectory = fileURLToPath(new URL('../uploaded-audio/', import.meta.url));
export const stemsDirectory = fileURLToPath(new URL('../separated-audio/', import.meta.url));
const runtimeDirectory = fileURLToPath(new URL('../stem-separation/', import.meta.url));
const runFile = promisify(execFile);
const audioExtensions = new Set(['.mp3', '.wav', '.flac', '.ogg']);
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const audioUrlPattern = new RegExp(`^/api/(music|audio)/(${uuidPattern}\\.(mp3|wav|flac|ogg))$`);

export interface AudioTrack {
  url: string;
  name: string;
}

export interface SeparatedStems {
  vocalsUrl: string;
  instrumentalUrl: string;
}

export function audioPath(value: unknown): string {
  const match = typeof value === 'string' ? audioUrlPattern.exec(value) : null;
  if (!match || (match[1] === 'music' && match[3] !== 'mp3')) {
    throw new Error('choose a generated track or upload an MP3, WAV, FLAC, or OGG file first.');
  }
  return path.join(match[1] === 'music' ? musicDirectory : audioDirectory, match[2]);
}

async function runSeparator(args: string[], timeout: number): Promise<void> {
  const python = path.join(runtimeDirectory, '.venv', 'bin', 'python');
  await access(python).catch(() => {
    throw new Error('install the local separator first: uv sync --project backend/stem-separation');
  });
  await runFile(python, [path.join(runtimeDirectory, 'separate.py'), ...args], {
    timeout, maxBuffer: 4 * 1024 * 1024,
  }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'killed' in error && error.killed) {
      throw new Error('stem separation timed out. try a shorter track.');
    }
    const detail = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim().split('\n').at(-1) : undefined;
    throw new Error(detail || 'local stem separation failed.');
  });
}

export async function uploadAudio(name: unknown, data: unknown): Promise<AudioTrack> {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 ||
      !audioExtensions.has(path.extname(name).toLowerCase())) {
    throw new Error('choose an MP3, WAV, FLAC, or OGG file.');
  }
  if (!Buffer.isBuffer(data) || !data.length || data.length > 50 * 1024 * 1024) {
    throw new Error('audio upload must contain 1 byte to 50 MB.');
  }
  const filename = `${randomUUID()}${path.extname(name).toLowerCase()}`;
  const source = path.join(audioDirectory, filename);
  await mkdir(audioDirectory, { recursive: true });
  await writeFile(source, data, { flag: 'wx' });
  await runSeparator(['--validate-only', source], 60_000).catch(async (error: unknown) => {
    await rm(source, { force: true });
    throw error;
  });
  return { url: `/api/audio/${filename}`, name: path.basename(name) };
}

// ponytail: one GPU job at a time; add a queue only when concurrent users need it.
let separating = false;

export async function separateStems(audioUrl: unknown): Promise<SeparatedStems> {
  const source = audioPath(audioUrl);
  await access(source).catch(() => { throw new Error('audio file no longer exists. upload it again.'); });
  if (separating) throw new Error('another track is being separated. try again when it finishes.');
  separating = true;
  let pending: string | undefined;

  try {
    await mkdir(stemsDirectory, { recursive: true });
    pending = await mkdtemp(path.join(stemsDirectory, '.pending-'));
    await runSeparator([source, pending], 20 * 60_000);
    for (const stem of ['vocals', 'instrumental']) {
      const file = await stat(path.join(pending, `source_${stem}.wav`));
      if (!file.isFile() || file.size <= 44) throw new Error('separator did not return both audio stems.');
    }
    const id = randomUUID();
    await rename(pending, path.join(stemsDirectory, id));
    pending = undefined;
    return {
      vocalsUrl: `/api/stems/${id}/source_vocals.wav`,
      instrumentalUrl: `/api/stems/${id}/source_instrumental.wav`,
    };
  } finally {
    separating = false;
    if (pending) await rm(pending, { recursive: true, force: true });
  }
}

export const separateStemsTool = tool({
  name: 'separate_stems',
  description:
    'Separate an available generated or uploaded audio track into vocals and instrumental WAV files locally. ' +
    'Uses MelBand Roformer | Vocals by Kimberley Jensen. Call only when the user requests stem separation, ' +
    'vocal isolation, or an instrumental version. Use the available audio URL supplied with the message or an exact URL from the conversation. ' +
    'If no audio is available, ask the user to upload a track or generate one. Do not invent URLs. ' +
    'This model returns vocals and instrumental only, not individual drums, bass, or other instruments. ' +
    'The chat shows players and download links after success; never claim success if the tool fails.',
  inputSchema: {
    type: 'object',
    properties: { audio_url: { type: 'string' } },
    required: ['audio_url'],
    additionalProperties: false,
  },
  callback: traceable(async (input: unknown, context: ToolContext) => {
    const audioUrl = input && typeof input === 'object' && 'audio_url' in input ? input.audio_url : undefined;
    const stems = await separateStems(audioUrl);
    context.invocationState.stems = stems;
    return { ...stems };
  }, {
    name: 'separate_stems', run_type: 'tool',
    processInputs: ({ args }) => ({ audio_url: args[0] && typeof args[0] === 'object' && 'audio_url' in args[0]
      ? args[0].audio_url : undefined }),
  }),
});
