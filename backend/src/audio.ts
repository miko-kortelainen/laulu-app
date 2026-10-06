import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { localSongPath, musicDirectory } from './songs.js';
import { userDirectory } from './user-files.js';

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

export function audioPath(value: unknown, userId: unknown): string {
  const processed = typeof value === 'string' ? processedUrlPattern.exec(value) : null;
  if (processed && ((processed[1] === 'stems' && processed[4] !== 'cleaned') ||
      (processed[1] === 'cleaned' && processed[4] === 'cleaned'))) {
    return path.join(userDirectory(processed[1] === 'stems' ? stemsDirectory : cleanedDirectory, userId), processed[2], processed[3]);
  }
  const match = typeof value === 'string' ? audioUrlPattern.exec(value) : null;
  if (!match || (match[1] === 'music' && match[3] !== 'mp3')) {
    throw new Error('choose a generated track or upload an MP3, WAV, FLAC, or OGG file first.');
  }
  return path.join(userDirectory(match[1] === 'music' ? musicDirectory : audioDirectory, userId), match[2]);
}

async function resolveAudioPath(value: unknown, userId: unknown): Promise<{ filename: string; temporary: boolean }> {
  const filename = audioPath(value, userId);
  if (typeof value === 'string' && value.startsWith('/api/music/')) {
    return localSongPath(userId as string, path.basename(filename, '.mp3'));
  }
  return { filename, temporary: false };
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

export async function prepareAnalysisAudio(audioUrl: unknown, userId: unknown): Promise<{ data: string; format: 'mp3' | 'wav' }> {
  const { filename: source, temporary } = await resolveAudioPath(audioUrl, userId);
  try {
    const file = await stat(source).catch(() => { throw new Error('audio file no longer exists. upload it again.'); });
    const extension = path.extname(source);
    // Leave room for the data URI prefix under the provider's 10 MB base64 limit.
    if ((extension === '.mp3' || extension === '.wav') && file.size > 0 && file.size < 7_499_000) {
      return { data: (await readFile(source)).toString('base64'), format: extension === '.mp3' ? 'mp3' : 'wav' };
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'music-analysis-'));
    try {
      const output = path.join(directory, 'analysis.mp3');
      await runProcessor('prepare_analysis.py', [source, output], 60_000);
      const data = (await readFile(output)).toString('base64');
      if (!data || data.length + 13 >= 10_000_000) throw new Error('audio is too large to analyze. try a shorter track.');
      return { data, format: 'mp3' };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    if (temporary) await rm(source, { force: true }).catch((error: unknown) => console.error('could not clear song processing file:', error));
  }
}

export async function uploadAudio(name: unknown, data: unknown, userId: unknown): Promise<AudioTrack> {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 ||
      !audioExtensions.has(path.extname(name).toLowerCase())) {
    throw new Error('choose an MP3, WAV, FLAC, or OGG file.');
  }
  if (!Buffer.isBuffer(data) || !data.length || data.length > 50 * 1024 * 1024) {
    throw new Error('audio upload must contain 1 byte to 50 MB.');
  }
  const filename = `${randomUUID()}${path.extname(name).toLowerCase()}`;
  const directory = userDirectory(audioDirectory, userId);
  const source = path.join(directory, filename);
  await mkdir(directory, { recursive: true });
  await writeFile(source, data, { flag: 'wx' });
  await runProcessor('audio.py', [source], 60_000).catch(async (error: unknown) => {
    await rm(source, { force: true });
    throw error;
  });
  return { url: `/api/audio/${filename}`, name: path.basename(name) };
}

// ponytail: one GPU job at a time; add a queue only when concurrent users need it.
let processing = false;

export async function processAudio(audioUrl: unknown, operation: 'stems' | 'cleaned', userId: unknown): Promise<string> {
  if (processing) throw new Error('another track is being processed. try again when it finishes.');
  processing = true;
  const names = operation === 'stems' ? ['vocals', 'instrumental'] : ['cleaned'];
  let pending: string | undefined;
  let source: string | undefined;
  let temporary = false;

  try {
    ({ filename: source, temporary } = await resolveAudioPath(audioUrl, userId));
    await access(source).catch(() => { throw new Error('audio file no longer exists. upload it again.'); });
    const directory = userDirectory(operation === 'stems' ? stemsDirectory : cleanedDirectory, userId);
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
    try {
      if (pending) await rm(pending, { recursive: true, force: true });
    } finally {
      if (temporary && source) await rm(source, { force: true }).catch((error: unknown) => console.error('could not clear song processing file:', error));
    }
  }
}
