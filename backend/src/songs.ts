import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteSongObject, putSongObject, r2Storage, readSongObject } from './r2.js';
import { userDirectory } from './user-files.js';

export const musicDirectory = fileURLToPath(new URL('../generated-music/', import.meta.url));
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

interface Song {
  id: string;
  owner_id: string;
  object_key: string;
  prompt: string;
  model: string;
  lyrics: string;
  size_bytes: number;
  status: 'pending' | 'ready';
  created_at: string;
}

// ponytail: up to five failed saves per user; memory recovery ends at backend restart.
const memoryRecovery = new Map<string, { song: Song; audio: Buffer }>();

export interface SavedSong {
  id: string;
  url: string;
  lyrics: string;
  prompt: string;
  model: string;
  sizeBytes: number;
  createdAt: string;
}

function database() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('configure SUPABASE_URL and the server-only SUPABASE_SECRET_KEY before generating songs.');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

function songPath(userId: unknown, id: unknown): string {
  if (typeof id !== 'string' || !uuid.test(id)) throw new SongNotFoundError('song not found.');
  return path.join(userDirectory(musicDirectory, userId), `${id}.mp3`);
}

export class SongNotFoundError extends Error {}

export class SongStorageError extends Error {
  constructor(public readonly songId: string, inMemory = false) {
    super('song generated, but saving failed. retry saving instead of generating again.' +
      (inMemory ? ' local recovery is only in memory; keep the backend running until saving succeeds.' : ''));
  }
}

async function writeAtomic(filename: string, data: string | Buffer): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { flag: 'wx' });
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function clearSongRecovery(userId: string, id: string): Promise<void> {
  const filename = songPath(userId, id);
  memoryRecovery.delete(id);
  await Promise.all([filename, filename.replace(/\.mp3$/, '.json')].map(async (file) => {
    await rm(file, { force: true }).catch((error: unknown) => console.error('could not clear saved song recovery file:', error));
  }));
}

export async function checkSongStorage(userId: string): Promise<void> {
  r2Storage();
  // Check the table and database credentials before the paid generation call.
  const { error } = await database().from('songs').select('id').eq('owner_id', userId).limit(1);
  if (error) throw new Error('song database is unavailable. generation was not started.');
  const pending = await listSongRecovery(userId);
  // ponytail: at most five failed saves per user; add retention cleanup when needed.
  if (pending.length >= 5) throw new Error('retry your unsaved songs before generating another song.');
}

function publicSong(song: Song): SavedSong {
  return {
    id: song.id, url: `/api/music/${song.id}.mp3`, lyrics: song.lyrics,
    prompt: song.prompt, model: song.model, sizeBytes: song.size_bytes, createdAt: song.created_at,
  };
}

async function findSong(userId: string, id: string): Promise<Song | null> {
  songPath(userId, id);
  if (!process.env.SUPABASE_SECRET_KEY) return null;
  const { data, error } = await database().from('songs').select('*').eq('owner_id', userId).eq('id', id).maybeSingle();
  if (error) throw new Error('could not load song metadata. try again.');
  return data as Song | null;
}

async function legacySongPath(userId: string, id: string): Promise<string> {
  const filename = songPath(userId, id);
  const pending = await access(filename.replace(/\.mp3$/, '.json')).then(() => true).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  });
  if (pending) throw new SongNotFoundError('song is not saved yet. retry storage first.');
  await access(filename).catch(() => { throw new SongNotFoundError('song not found.'); });
  return filename;
}

export async function listSongs(userId: string): Promise<SavedSong[]> {
  userDirectory(musicDirectory, userId);
  const { data, error } = await database().from('songs').select('*')
    .eq('owner_id', userId).eq('status', 'ready').order('created_at', { ascending: false }).limit(100);
  if (error) throw new Error('could not load saved songs. try again.');
  return (data as Song[]).map(publicSong);
}

export async function deleteSong(userId: string, id: string): Promise<void> {
  const song = await findSong(userId, id);
  const key = `users/${userId}/${id}.mp3`;
  if (!song || song.status !== 'ready' || song.object_key !== key) {
    throw new SongNotFoundError('song not found.');
  }
  await deleteSongObject(key).catch(() => { throw new Error('could not delete song audio. try deleting again.'); });
  const filename = songPath(userId, id);
  // Remove local copies before metadata so legacy playback cannot restore a deleted song.
  await Promise.all([filename, filename.replace(/\.mp3$/, '.json')].map((file) => rm(file, { force: true })))
    .catch(() => { throw new Error('could not delete local song files. try deleting again.'); });
  memoryRecovery.delete(id);
  // Keep metadata until cleanup succeeds; deleting an absent R2 object is safe to retry.
  const { error } = await database().from('songs').delete().eq('owner_id', userId).eq('id', id);
  if (error) throw new Error('could not finish deleting the song. try deleting again.');
}

export async function listSongRecovery(userId: string): Promise<string[]> {
  const directory = userDirectory(musicDirectory, userId);
  const files = await readdir(directory).catch((error: unknown) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  });
  const ids = files.filter((name) => name.endsWith('.json') && uuid.test(name.slice(0, -5))).map((name) => name.slice(0, -5));
  for (const [id, recovery] of memoryRecovery) {
    if (recovery.song.owner_id === userId) ids.push(id);
  }
  return [...new Set(ids)];
}

async function persistSong(song: Song, audio: Buffer): Promise<SavedSong> {
  const existing = await findSong(song.owner_id, song.id);
  if (existing?.status === 'ready') return publicSong(existing);
  if (!existing) {
    const { error } = await database().from('songs').insert(song);
    if (error) throw new Error('could not create song metadata.');
  }
  await putSongObject(song.object_key, audio);
  const { data, error } = await database().from('songs').update({ status: 'ready' })
    .eq('owner_id', song.owner_id).eq('id', song.id).eq('status', 'pending').select('*').single();
  if (error || !data) throw new Error('could not finish saving song metadata.');
  return publicSong(data as Song);
}

export async function saveSong(userId: string, audio: Buffer, prompt: string, model: string, lyrics: string): Promise<SavedSong> {
  const id = randomUUID();
  const filename = songPath(userId, id);
  const song: Song = {
    id, owner_id: userId, object_key: `users/${userId}/${id}.mp3`,
    prompt, model, lyrics, size_bytes: audio.length, status: 'pending', created_at: new Date().toISOString(),
  };
  try {
    await mkdir(path.dirname(filename), { recursive: true });
    // Publish metadata first so incomplete local saves cannot look like legacy songs.
    await writeAtomic(filename.replace(/\.mp3$/, '.json'), JSON.stringify(song));
    await writeAtomic(filename, audio);
  } catch (error: unknown) {
    memoryRecovery.set(id, { song, audio });
    console.error('local song recovery failed; keeping audio in memory:', error);
  }
  const track = await persistSong(song, audio).catch(() => { throw new SongStorageError(id, memoryRecovery.has(id)); });
  await clearSongRecovery(userId, id);
  return track;
}

export async function retrySongStorage(userId: string, id: string): Promise<SavedSong> {
  const filename = songPath(userId, id);
  const saved = await findSong(userId, id);
  if (saved?.status === 'ready') {
    await clearSongRecovery(userId, id);
    return publicSong(saved);
  }
  const recovery = memoryRecovery.get(id);
  if (recovery?.song.owner_id === userId) {
    const track = await persistSong(recovery.song, recovery.audio).catch(() => { throw new SongStorageError(id, true); });
    await clearSongRecovery(userId, id);
    return track;
  }
  const json = await readFile(filename.replace(/\.mp3$/, '.json'), 'utf8')
    .catch(() => { throw new SongNotFoundError('unsaved song not found.'); });
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object' ||
      !('id' in value) || value.id !== id ||
      !('owner_id' in value) || value.owner_id !== userId ||
      !('object_key' in value) || value.object_key !== `users/${userId}/${id}.mp3` ||
      !('prompt' in value) || typeof value.prompt !== 'string' ||
      !('model' in value) || typeof value.model !== 'string' ||
      !('lyrics' in value) || typeof value.lyrics !== 'string' ||
      !('size_bytes' in value) || typeof value.size_bytes !== 'number' || !Number.isSafeInteger(value.size_bytes) || value.size_bytes <= 0 ||
      !('status' in value) || value.status !== 'pending' ||
      !('created_at' in value) || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))) {
    throw new SongNotFoundError('unsaved song not found.');
  }
  const song: Song = { id, owner_id: userId, object_key: value.object_key, prompt: value.prompt, model: value.model,
    lyrics: value.lyrics, size_bytes: value.size_bytes, status: 'pending', created_at: value.created_at };
  const audio = await readFile(filename);
  if (audio.length !== song.size_bytes) throw new Error('unsaved song audio is incomplete.');
  const track = await persistSong(song, audio).catch(() => { throw new SongStorageError(id); });
  await clearSongRecovery(userId, id);
  return track;
}

export async function readSong(userId: string, id: string, range?: string): Promise<{ audio: Buffer; contentRange?: string } | { filename: string }> {
  const song = await findSong(userId, id);
  if (!song) return { filename: await legacySongPath(userId, id) };
  if (song.status !== 'ready') throw new SongNotFoundError('song not found.');
  const key = `users/${userId}/${id}.mp3`;
  if (song.object_key !== key) throw new SongNotFoundError('song not found.');
  return readSongObject(key, range);
}

export async function localSongPath(userId: string, id: string): Promise<{ filename: string; temporary: boolean }> {
  const source = songPath(userId, id);
  const song = await findSong(userId, id);
  if (!song) return { filename: await legacySongPath(userId, id), temporary: false };
  if (song.status !== 'ready' || song.object_key !== `users/${userId}/${id}.mp3`) {
    throw new SongNotFoundError('song not found.');
  }
  const { audio } = await readSongObject(song.object_key);
  if (audio.length !== song.size_bytes) throw new Error('song storage returned incomplete audio.');
  await mkdir(path.dirname(source), { recursive: true });
  const filename = `${source}.${randomUUID()}.cache.mp3`;
  await writeAtomic(filename, audio);
  await clearSongRecovery(userId, id);
  return { filename, temporary: true };
}
