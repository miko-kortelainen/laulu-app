import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { localSongPath, musicDirectory } from './songs.js';
import { userDirectory } from './user-files.js';
import { audioDirectory, reserveLocalAudio, retainLocalAudio } from './local-audio.js';

export { audioDirectory } from './local-audio.js';
const runFile = promisify(execFile);
const audioInputOptions = ['-v', 'error', '-protocol_whitelist', 'file', '-format_whitelist', 'wav,mp3,flac,ogg'];
const audioExtensions = new Set(['.mp3', '.wav', '.flac', '.ogg']);
const uuidPattern = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
// One backend process serves all users, so these limits are server-wide.
const maxAudioJobs = Math.max(1, Number.parseInt(process.env.MAX_AUDIO_JOBS ?? '', 10) || 2);
let activeUploads = 0;
let activeProcessors = 0;
const waitingProcessors: (() => void)[] = [];
const audioUrlPattern = new RegExp(`^/api/(music|audio)/(${uuidPattern}\\.(mp3|wav|flac|ogg))$`);

export interface AudioTrack {
  url: string;
  name: string;
}

export class AudioBusyError extends Error {
  constructor() {
    super('audio uploads are busy. try again in a moment.');
  }
}

// Call before reading an upload body, which is held in memory.
export function startAudioUpload(): () => void {
  if (activeUploads >= maxAudioJobs) throw new AudioBusyError();
  activeUploads++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeUploads--;
  };
}

async function withProcessorSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeProcessors < maxAudioJobs) activeProcessors++;
  else await new Promise<void>((resolve) => waitingProcessors.push(resolve));
  try {
    return await task();
  } finally {
    // Hand the slot straight to the next waiting conversion.
    const next = waitingProcessors.shift();
    if (next) next();
    else activeProcessors--;
  }
}

export function audioPath(value: unknown, userId: unknown): string {
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

async function runProcessor(command: 'ffmpeg' | 'ffprobe', args: string[]): Promise<string> {
  const result = await withProcessorSlot(() => runFile(command, args, {
    timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  })).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error('install FFmpeg on the backend host. ffmpeg and ffprobe must be on PATH.');
    }
    if (error && typeof error === 'object' && 'killed' in error && error.killed) {
      throw new Error('audio processing timed out. try a shorter track.');
    }
    const detail = error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
      ? error.stderr.trim().split('\n').at(-1) : undefined;
    throw new Error(detail || 'local audio processing failed.');
  });
  return result.stdout;
}

async function validateAudio(source: string): Promise<void> {
  const stdout = await runProcessor('ffprobe', [...audioInputOptions, '-select_streams', 'a',
    '-show_entries', 'stream=channels:format=duration', '-of', 'json', source]);
  const info = JSON.parse(stdout) as { streams?: { channels?: number }[]; format?: { duration?: string } };
  const channels = info.streams?.[0]?.channels;
  const duration = Number(info.format?.duration);
  if (info.streams?.length !== 1 || (channels !== 1 && channels !== 2) || !(duration > 0 && duration <= 600)) {
    throw new Error('audio must be mono or stereo and between 0 and 10 minutes long.');
  }
}

export async function prepareAnalysisAudio(audioUrl: unknown, userId: unknown): Promise<{ data: string; format: 'mp3' | 'wav' }> {
  const { filename: source, temporary } = await resolveAudioPath(audioUrl, userId);
  const releaseSource = retainLocalAudio(source);
  try {
    const file = await stat(source).catch(() => { throw new Error('audio file no longer exists. upload it again.'); });
    const extension = path.extname(source);
    // Leave room for the data URI prefix under the provider's 10 MB base64 limit.
    if ((extension === '.mp3' || extension === '.wav') && file.size > 0 && file.size < 7_499_000) {
      return { data: (await readFile(source)).toString('base64'), format: extension === '.mp3' ? 'mp3' : 'wav' };
    }
    const temporaryRoot = userDirectory(audioDirectory, userId);
    await mkdir(temporaryRoot, { recursive: true });
    const directory = await mkdtemp(path.join(temporaryRoot, '.analysis-'));
    const releaseTemporary = retainLocalAudio(directory);
    try {
      const output = path.join(directory, 'analysis.mp3');
      await validateAudio(source);
      // 80 kbps keeps a full ten-minute track below the provider's base64 limit.
      await runProcessor('ffmpeg', [...audioInputOptions, '-nostdin', '-xerror', '-i', source,
        '-map', '0:a:0', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '80k', output]);
      const data = (await readFile(output)).toString('base64');
      if (!data || data.length + 13 >= 10_000_000) throw new Error('audio is too large to analyze. try a shorter track.');
      return { data, format: 'mp3' };
    } finally {
      releaseTemporary();
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    releaseSource();
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
  const release = await reserveLocalAudio(source, data.length);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(source, data, { flag: 'wx' });
    await validateAudio(source);
    return { url: `/api/audio/${filename}`, name: path.basename(name) };
  } catch (error: unknown) {
    await rm(source, { force: true });
    throw error;
  } finally {
    await release();
  }
}
