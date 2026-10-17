import { randomUUID } from 'node:crypto';
import { database } from './database.js';
import { isCount, isRecord, isTimestamp } from './validation.js';

export type PaidOperation = 'chat' | 'analysis' | 'generation';

export class QuotaError extends Error {
  constructor(
    message: string,
    readonly status: 429 | 503,
    readonly resource?: string,
    readonly resetAt?: string,
  ) {
    super(message);
  }
}

export function songOutputLimit(): number {
  const setting = process.env.MAX_GENERATED_SONG_BYTES;
  const limit = setting === undefined ? 25 * 1024 * 1024 : Number(setting);
  if (setting?.trim() === '' || !isCount(limit)) throw new QuotaError('invalid server setting MAX_GENERATED_SONG_BYTES.', 503);
  if (!limit) throw new QuotaError('MAX_GENERATED_SONG_BYTES must be positive.', 503);
  return limit;
}

export async function quotaRpc(name: string, parameters: Record<string, unknown>): Promise<unknown> {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    throw new QuotaError('configure the server-only Supabase database credentials before using paid operations.', 503);
  }
  const result = await Promise.resolve(database().rpc(name, parameters).abortSignal(AbortSignal.timeout(10_000))).catch(() => {
    throw new QuotaError('usage database is unavailable. try again.', 503);
  });
  if (result.error) throw new QuotaError('usage database is unavailable. try again.', 503);
  return result.data as unknown;
}

export function checkAllowance(data: unknown): void {
  if (!isRecord(data) || data.allowed !== false) return;
  const resource = data.resource;
  if (!validResource(resource)) {
    throw new QuotaError('invalid quota response. operation was not started.', 503);
  }
  const resetAt = allowanceReset(data);
  throw new QuotaError(allowanceMessage({ resource, resetAt, scope: data.scope }), 429, resource, resetAt);
}

function allowanceReset(data: Record<string, unknown>): string | undefined {
  const resetAt = typeof data.resetAt === 'string' ? data.resetAt : undefined;
  if (data.resource !== 'storage' && !isTimestamp(resetAt)) {
    throw new QuotaError('invalid quota response. operation was not started.', 503);
  }
  return resetAt;
}

function validResource(value: unknown): value is string {
  return ['chat', 'analysis', 'generation', 'lyrics', 'storage'].some(resource => resource === value);
}

function allowanceMessage({ resource, resetAt, scope }: { resource: string; resetAt?: string; scope?: unknown }): string {
  if (resource === 'storage') return 'song storage allowance exhausted. delete a saved song and try again.';
  return `${scope === 'global' ? 'app-wide daily' : 'your'} ${resource} allowance exhausted. try again after ${resetAt}.`;
}

function reservationCreated(data: unknown, id: string): boolean {
  return isRecord(data) && data.allowed === true && data.id === id && data.created === true;
}

export async function reserveUsage(userId: string, operation: PaidOperation, storageBytes = 0, id: string = randomUUID()): Promise<string> {
  const data = await quotaRpc('reserve_usage', {
    p_user_id: userId, p_operation: operation, p_id: id,
    p_storage_bytes: storageBytes, p_defaults: {},
  });
  checkAllowance(data);
  if (!reservationCreated(data, id)) {
    throw new QuotaError('could not reserve usage. operation was not started.', 503);
  }
  return id;
}

export async function settleGeneration(userId: string, id: string, status: 'completed' | 'failed'): Promise<void> {
  await quotaRpc('settle_generation', { p_user_id: userId, p_id: id, p_status: status });
}

export async function reserveLyrics(userId: string): Promise<void> {
  const id = randomUUID();
  const data = await quotaRpc('reserve_lyrics', { p_user_id: userId, p_id: id });
  checkAllowance(data);
  if (!reservationCreated(data, id)) {
    throw new QuotaError('could not reserve lyrics usage. operation was not started.', 503);
  }
}

interface Allowance { limit: number; used: number; remaining: number }
export interface Usage {
  resetAt: string;
  generationResetAt: string;
  plan: 'free' | 'starter' | 'pro' | 'ultra';
  chat: Allowance;
  analysis: Allowance;
  generation: Allowance;
  lyrics: Allowance;
  storage: Allowance & { reserved: number };
}

export async function getUsage(userId: string): Promise<Usage> {
  const data = await quotaRpc('get_usage', { p_user_id: userId, p_defaults: {} });
  if (!isRecord(data) || !validUsagePeriod(data)) throw new QuotaError('invalid usage response.', 503);
  for (const name of ['chat', 'analysis', 'generation', 'lyrics', 'storage'] as const) {
    const fields = name === 'storage' ? ['limit', 'used', 'remaining', 'reserved'] : ['limit', 'used', 'remaining'];
    if (!validAllowance(data[name], fields)) throw new QuotaError('invalid usage response.', 503);
  }
  return data as unknown as Usage;
}

function validUsagePeriod(data: Record<string, unknown>): boolean {
  return isTimestamp(data.resetAt) && isTimestamp(data.generationResetAt) &&
    ['free', 'starter', 'pro', 'ultra'].some(plan => plan === data.plan);
}

function validAllowance(value: unknown, fields: string[]): boolean {
  return isRecord(value) && fields.every(field => isCount(value[field]));
}
