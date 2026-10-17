import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { userDirectory } from './user-files.js';
import { hasErrorCode, isCount } from './validation.js';

export const audioDirectory = fileURLToPath(new URL('../uploaded-audio/', import.meta.url));
export const localAudioLimit = 1024 * 1024 * 1024;

export class LocalAudioLimitError extends Error {
  constructor() {
    super('local audio storage is full. try again after expired files are deleted.');
  }
}

const readers = new Map<string, number>();
const reservations = new Map<string, number>();
// ponytail: one backend process per audio disk; use a shared lock before adding workers.
let storageWork: Promise<unknown> = Promise.resolve();

function serialized<T>(action: () => Promise<T>): Promise<T> {
  const result = storageWork.then(action);
  storageWork = result.catch(() => undefined);
  return result;
}

function contains(directory: string, filename: string): boolean {
  const relative = path.relative(directory, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function retainLocalAudio(filename: string): () => void {
  readers.set(filename, (readers.get(filename) ?? 0) + 1);
  return () => {
    const count = (readers.get(filename) ?? 1) - 1;
    if (count) readers.set(filename, count);
    else readers.delete(filename);
  };
}

async function scanLocalAudio(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return [];
    throw error;
  });
  let bytes = 0;
  for (const entry of entries) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) bytes += await scanAudioDirectory(filename);
    else if (entry.isFile()) bytes += await scanAudioFile(filename);
  }
  return bytes;
}

async function scanAudioDirectory(directory: string): Promise<number> {
  const bytes = await scanLocalAudio(directory);
  const active = [...readers.keys(), ...reservations.keys()].some(file => contains(directory, file));
  if (active) return bytes;
  await rmdir(directory).catch((error: unknown) => {
    if (!hasErrorCode(error, 'ENOTEMPTY', 'ENOENT')) throw error;
  });
  return bytes;
}

async function scanAudioFile(filename: string): Promise<number> {
  const file = await stat(filename).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (!file) return 0;
  const reserved = [...reservations.keys()].some(directory => contains(directory, filename));
  const retained = [...readers.keys()].some(directory => contains(directory, filename));
  if (!retained && !reserved) await rm(filename, { force: true });
  return !reserved && retained ? file.size : 0;
}

async function localAudioUsage(): Promise<number> {
  let bytes = await scanLocalAudio(audioDirectory);
  for (const reserved of reservations.values()) bytes += reserved;
  return bytes;
}

export async function cleanupLocalAudio(): Promise<void> {
  await serialized(localAudioUsage);
}

export async function clearUploadedAudio(userId: string): Promise<void> {
  const directory = userDirectory(audioDirectory, userId);
  await serialized(async () => {
    await scanLocalAudio(directory);
    await rmdir(directory).catch((error: unknown) => {
      if (!hasErrorCode(error, 'ENOENT')) throw error;
    });
  });
}

export async function reserveLocalAudio(filename: string, bytes: number): Promise<() => Promise<void>> {
  return serialized(async () => {
    if (!validReservation(filename, bytes)) {
      throw new Error('invalid local audio reservation.');
    }
    if ((await localAudioUsage()) + bytes > localAudioLimit) throw new LocalAudioLimitError();
    reservations.set(filename, bytes);
    return () => serialized(async () => { reservations.delete(filename); });
  });
}

function validReservation(filename: string, bytes: number): boolean {
  return isCount(bytes) && bytes > 0 && !reservations.has(filename) && contains(audioDirectory, filename);
}
