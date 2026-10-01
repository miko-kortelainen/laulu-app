import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { musicDirectory } from './music.js';

export const audioDirectory = fileURLToPath(new URL('../uploaded-audio/', import.meta.url));
export const stemsDirectory = fileURLToPath(new URL('../separated-audio/', import.meta.url));
export const cleanedDirectory = fileURLToPath(new URL('../cleaned-audio/', import.meta.url));
const runtimeDirectory = fileURLToPath(new URL('../audio-processing/', import.meta.url));
const runFile = promisify(execFile);
const audioExtensions = new Set(['.mp3', '.wav', '.flac', '.ogg']);
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const audioUrlPattern = new RegExp(`^/api/(music|audio)/(${uuidPattern}\\.(mp3|wav|flac|ogg))$`);

const processedUrlPattern = new RegExp(`^/api/(stems|cleaned)/(${uuidPattern})/(source_(vocals|instrumental|cleaned)\\.wav)$`);

export interface AudioTrack {
  url: string;
  name: string;
}

export function audioPath(value: unknown): string {
  const processed = typeof value === 'string' ? processedUrlPattern.exec(value) : null;
  if (processed && ((processed[1] === 'stems' && processed[4] !== 'cleaned') ||
      (processed[1] === 'cleaned' && processed[4] === 'cleaned'))) {
    return path.join(processed[1] === 'stems' ? stemsDirectory : cleanedDirectory, processed[2], processed[3]);
  }
  const match = typeof value === 'string' ? audioUrlPattern.exec(value) : null;
  if (!match || (match[1] === 'music' && match[3] !== 'mp3')) {
    throw new Error('choose a generated track or upload an MP3, WAV, FLAC, or OGG file first.');
  }
  return path.join(match[1] === 'music' ? musicDirectory : audioDirectory, match[2]);
}

async function runProcessor(script: string, args: string[], timeout: number): Promise<void> {
  const python = path.join(runtimeDirectory, '.venv', 'bin', 'python');
  await access(python).catch(() => {
    throw new Error('install local audio processing first: uv sync --project backend/audio-processing');
  });
  await runFile(python, [path.join(runtimeDirectory, script), ...args], {
    timeout, maxBuffer: 4 * 1024 * 1024,
  }).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'killed' in error && error.killed) {
      throw new Error('audio processing timed out. try a shorter track.');
    }
    const detail = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim().split('\n').at(-1) : undefined;
    throw new Error(detail || 'local audio processing failed.');
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
  await runProcessor('audio.py', [source], 60_000).catch(async (error: unknown) => {
    await rm(source, { force: true });
    throw error;
  });
  return { url: `/api/audio/${filename}`, name: path.basename(name) };
}

// ponytail: one GPU job at a time; add a queue only when concurrent users need it.
let processing = false;

export async function processAudio(audioUrl: unknown, operation: 'stems' | 'cleaned'): Promise<string> {
  const source = audioPath(audioUrl);
  await access(source).catch(() => { throw new Error('audio file no longer exists. upload it again.'); });
  if (processing) throw new Error('another track is being processed. try again when it finishes.');
  processing = true;
  const directory = operation === 'stems' ? stemsDirectory : cleanedDirectory;
  const names = operation === 'stems' ? ['vocals', 'instrumental'] : ['cleaned'];
  let pending: string | undefined;

  try {
    await mkdir(directory, { recursive: true });
    pending = await mkdtemp(path.join(directory, '.pending-'));
    await runProcessor(operation === 'stems' ? 'separate.py' : 'dereverb.py', [source, pending], 20 * 60_000);
    for (const stem of names) {
      const file = await stat(path.join(pending, `source_${stem}.wav`));
      if (!file.isFile() || file.size <= 44) throw new Error('audio processor did not return the expected WAV files.');
    }
    const id = randomUUID();
    await rename(pending, path.join(directory, id));
    pending = undefined;
    return `/api/${operation}/${id}`;
  } finally {
    processing = false;
    if (pending) await rm(pending, { recursive: true, force: true });
  }
}
