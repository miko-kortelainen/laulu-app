import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { userDirectory } from './user-files.js';
import { MusicGenerationError } from './music.js';
import { retainUploadSession } from './agent.js';
import { database } from './database.js';
import { cleanupSongRecovery, musicDirectory, retrySongStorage, SongNotFoundError, SongStorageError, writeAtomic } from './songs.js';
import { QuotaError, quotaRpc, settleGeneration } from './quotas.js';

export interface Operation {
  id: string;
  owner_id: string;
  kind: 'music' | 'chat';
  state: 'queued' | 'running' | 'completed' | 'failed' | 'unknown';
  status: string;
  result: Record<string, unknown> | null;
  acknowledged: boolean;
  created_at: string;
}

// ponytail: one backend instance; coordinate workers before scaling horizontally.
const active = new Map<string, Operation>();
const pendingPersistence = new Set<string>();
const reconciliation = new Map<string, Promise<Operation>>();
export const busySessions = new Set<string>();

export function sessionBusy(userId: string): boolean {
  return busySessions.has(userId) || [...active.values()].some((operation) => operation.owner_id === userId);
}

export function operationId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    throw new Error('invalid operation reference.');
  }
  return value;
}

function unavailable(): Error {
  return new Error('operation database is unavailable. reconnect to recover your request.');
}

async function persist(operation: Operation): Promise<void> {
  const { error } = await database().from('operations').update({
    state: operation.state, status: operation.status, result: operation.result,
  }).eq('id', operation.id).eq('owner_id', operation.owner_id).abortSignal(AbortSignal.timeout(10_000));
  if (error) throw unavailable();
}

export async function getOperation(userId: string, id: string): Promise<Operation> {
  operationId(id);
  const { data, error } = await database().from('operations').select('*')
    .eq('owner_id', userId).eq('id', id).abortSignal(AbortSignal.timeout(10_000)).maybeSingle();
  if (error) throw unavailable();
  if (!data) throw new SongNotFoundError('operation not found.');
  const running = active.get(id);
  if (running?.owner_id === userId) {
    if (pendingPersistence.has(id)) {
      await persist(running);
      active.delete(id);
      pendingPersistence.delete(id);
      return running;
    }
    return running.state === 'running' ? running : { ...running, state: 'running', status: 'saving result...', result: null };
  }
  const existing = reconciliation.get(id);
  if (existing) return existing;
  if (sessionBusy(userId)) return data as Operation;
  busySessions.add(userId);
  const recovery = reconcile(data as Operation).finally(() => {
    reconciliation.delete(id);
    busySessions.delete(userId);
  });
  reconciliation.set(id, recovery);
  return recovery;
}

export async function listOperations(userId: string): Promise<Operation[]> {
  const { data, error } = await database().from('operations').select('*').eq('owner_id', userId)
    .eq('acknowledged', false).order('created_at', { ascending: true }).limit(100)
    .abortSignal(AbortSignal.timeout(10_000));
  if (error) throw unavailable();
  const operations: Operation[] = [];
  for (const row of data as Operation[]) operations.push(await getOperation(userId, row.id));
  return operations;
}

export async function acknowledgeOperation(userId: string, id: string): Promise<void> {
  operationId(id);
  const { error } = await database().from('operations').update({ acknowledged: true })
    .eq('owner_id', userId).eq('id', id).in('state', ['completed', 'failed', 'unknown'])
    .abortSignal(AbortSignal.timeout(10_000));
  if (error) throw unavailable();
}

export function operationFailure(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : 'request failed.',
    ...(error instanceof MusicGenerationError ? { generationStatus: error.confirmedFailure ? 'failed' : 'unknown' } : {}),
    ...(error instanceof SongStorageError ? { songId: error.songId } : {}),
    ...(error instanceof QuotaError ? { code: error.status === 429 ? 'quota_exceeded' : 'quota_unavailable',
      resource: error.resource, resetAt: error.resetAt } : {}),
  };
}

export async function startOperation(userId: string, id: string, kind: Operation['kind'],
  work: (onStatus: (status: string) => void) => Promise<Record<string, unknown>>): Promise<Operation> {
  operationId(id);
  // Insert once. A lost start response can only recover this operation, never dispatch it again.
  const { data, error } = await database().from('operations').insert({ id, owner_id: userId, kind })
    .select('*').abortSignal(AbortSignal.timeout(10_000)).single();
  if (error?.code === '23505') {
    const existing = await getOperation(userId, id);
    if (existing.kind !== kind) throw new Error('operation reference belongs to another request.');
    return existing;
  }
  if (error || !data) throw unavailable();
  const operation = data as Operation;
  active.set(id, operation);
  let releaseUploads: (() => void) | undefined;
  const run = async (): Promise<void> => {
    try {
      if (kind === 'chat') releaseUploads = retainUploadSession(userId);
      operation.state = 'running';
      operation.status = kind === 'music' ? 'generating track...' : 'thinking...';
      // Persist before any paid work. A restart treats running work as uncertain.
      await persist(operation);
      operation.result = await work((status) => { operation.status = status; });
      operation.state = 'completed';
    } catch (error: unknown) {
      operation.result = operationFailure(error);
      operation.state = error instanceof MusicGenerationError && !error.confirmedFailure ? 'unknown' : 'failed';
    }
    operation.status = '';
    const journal = journalPath(operation);
    await writeJournal(operation).catch((error: unknown) => console.error('operation journal write failed:', error));
    await persist(operation);
    await rm(journal, { force: true });
    active.delete(id);
  };
  void run().finally(() => releaseUploads?.()).catch((error: unknown) => {
    pendingPersistence.add(id);
    console.error('operation result persistence failed:', error);
  });
  return operation;
}

function journalPath(operation: Operation): string {
  return path.join(userDirectory(musicDirectory, operation.owner_id), `${operationId(operation.id)}.operation.json`);
}

async function writeJournal(operation: Operation): Promise<void> {
  const journal = journalPath(operation);
  await mkdir(path.dirname(journal), { recursive: true });
  await writeAtomic(journal, JSON.stringify(operation));
}

async function reconcile(operation: Operation): Promise<Operation> {
  if (operation.kind === 'music' && operation.result?.generationStatus === 'failed') {
    await settleGeneration(operation.owner_id, operation.id, 'failed');
  }
  if (operation.state !== 'queued' && operation.state !== 'running' && operation.state !== 'unknown') return operation;
  const journal = journalPath(operation);
  const json = await readFile(journal, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (json) {
    const recovered: unknown = JSON.parse(json);
    if (!recovered || typeof recovered !== 'object' || !('id' in recovered) || recovered.id !== operation.id ||
        !('owner_id' in recovered) || recovered.owner_id !== operation.owner_id ||
        !('kind' in recovered) || recovered.kind !== operation.kind ||
        !('state' in recovered) || !['completed', 'failed', 'unknown'].includes(String(recovered.state)) ||
        !('result' in recovered) || !recovered.result || typeof recovered.result !== 'object') {
      throw new Error('invalid operation recovery file.');
    }
    operation.state = recovered.state as Operation['state'];
    operation.result = recovered.result as Record<string, unknown>;
    operation.status = '';
    if (operation.kind === 'music' && operation.result?.generationStatus === 'failed') {
      await settleGeneration(operation.owner_id, operation.id, 'failed');
    }
    await persist(operation);
    await rm(journal, { force: true });
    return operation;
  }
  if (operation.kind === 'music') {
    // A saved song or complete local recovery proves completion without another provider call.
    const track = await retrySongStorage(operation.owner_id, operation.id).catch((error: unknown) => {
      if (error instanceof SongStorageError) return error;
      if (error instanceof SongNotFoundError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return undefined;
      throw error;
    });
    if (track) {
      operation.state = track instanceof SongStorageError ? 'failed' : 'completed';
      operation.result = track instanceof SongStorageError ? operationFailure(track) : { track };
    } else {
      const { data, error } = await database().from('usage_reservations').select('generation_status')
        .eq('user_id', operation.owner_id).eq('id', operation.id).maybeSingle();
      if (error) throw unavailable();
      const uncertain = data?.generation_status === 'reserved';
      operation.state = uncertain ? 'unknown' : 'failed';
      operation.result = { error: uncertain
        ? 'generation was interrupted and its outcome is unknown. your allowance remains reserved. no automatic generation retry was made.'
        : 'request was interrupted. no recoverable audio was found.' };
    }
  } else {
    operation.state = 'unknown';
    operation.result = { error: 'chat was interrupted by a backend restart. no automatic paid retry was made. send a new message to continue.' };
  }
  operation.status = '';
  await persist(operation);
  return operation;
}

export async function recoverOperations(): Promise<void> {
  for (const id of [...pendingPersistence].slice(0, 100)) {
    const operation = active.get(id);
    if (operation) await getOperation(operation.owner_id, id);
  }
  const { data, error } = await database().from('operations').select('*')
    .in('state', ['queued', 'running', 'unknown']).order('state').order('created_at').limit(100);
  if (error) throw unavailable();
  for (const operation of data as Operation[]) {
    if (!active.has(operation.id) && !busySessions.has(operation.owner_id)) await getOperation(operation.owner_id, operation.id);
  }
  await cleanupSongRecovery((userId) => {
    if (sessionBusy(userId)) return undefined;
    busySessions.add(userId);
    return () => { busySessions.delete(userId); };
  });
  await quotaRpc('cleanup_operations', {});
}
