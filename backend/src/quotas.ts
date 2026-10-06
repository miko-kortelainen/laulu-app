import { randomUUID } from 'node:crypto';
import { database } from './database.js';

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

function configuredLimit(name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum || process.env[name]?.trim() === '') {
    throw new QuotaError(`invalid server setting ${name}.`, 503);
  }
  return value;
}

export function quotaDefaults(): { chat_daily: number; analysis_daily: number; generation_daily: number; storage_bytes: number } {
  return {
    chat_daily: configuredLimit('QUOTA_CHAT_DAILY', 50, 2_147_483_647),
    analysis_daily: configuredLimit('QUOTA_ANALYSIS_DAILY', 10, 2_147_483_647),
    generation_daily: configuredLimit('QUOTA_GENERATION_DAILY', 5, 2_147_483_647),
    storage_bytes: configuredLimit('QUOTA_STORAGE_BYTES', 512 * 1024 * 1024),
  };
}

export function songOutputLimit(): number {
  const limit = configuredLimit('MAX_GENERATED_SONG_BYTES', 25 * 1024 * 1024);
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
  if (data && typeof data === 'object' && 'allowed' in data && data.allowed === false) {
    if (!('resource' in data) || typeof data.resource !== 'string' ||
        !['chat', 'analysis', 'generation', 'storage'].includes(data.resource)) {
      throw new QuotaError('invalid quota response. operation was not started.', 503);
    }
    const resetAt = 'resetAt' in data && typeof data.resetAt === 'string' ? data.resetAt : undefined;
    if (data.resource !== 'storage' && (!resetAt || !Number.isFinite(Date.parse(resetAt)))) {
      throw new QuotaError('invalid quota response. operation was not started.', 503);
    }
    throw new QuotaError(data.resource === 'storage'
      ? 'song storage allowance exhausted. delete a saved song and try again.'
      : `daily ${data.resource} allowance exhausted. try again after ${resetAt}.`,
    429, data.resource, resetAt);
  }
}

export async function reserveUsage(userId: string, operation: PaidOperation, storageBytes = 0): Promise<string> {
  const id = randomUUID();
  const data = await quotaRpc('reserve_usage', {
    p_user_id: userId, p_operation: operation, p_id: id,
    p_storage_bytes: storageBytes, p_defaults: quotaDefaults(),
  });
  checkAllowance(data);
  if (!data || typeof data !== 'object' || !('allowed' in data) || data.allowed !== true ||
      !('id' in data) || data.id !== id || !('created' in data) || data.created !== true) {
    throw new QuotaError('could not reserve usage. operation was not started.', 503);
  }
  return id;
}

export async function releaseSongReservation(userId: string, id: string): Promise<void> {
  await quotaRpc('release_song_reservation', { p_user_id: userId, p_id: id });
}

interface Allowance { limit: number; used: number; remaining: number }
export interface Usage {
  resetAt: string;
  chat: Allowance;
  analysis: Allowance;
  generation: Allowance;
  storage: Allowance & { reserved: number };
}

export async function getUsage(userId: string): Promise<Usage> {
  const data = await quotaRpc('get_usage', { p_user_id: userId, p_defaults: quotaDefaults() });
  if (!data || typeof data !== 'object' || !('resetAt' in data) || typeof data.resetAt !== 'string' ||
      !Number.isFinite(Date.parse(data.resetAt))) throw new QuotaError('invalid usage response.', 503);
  for (const name of ['chat', 'analysis', 'generation', 'storage'] as const) {
    const value = name in data ? (data as Record<string, unknown>)[name] : undefined;
    if (!value || typeof value !== 'object') throw new QuotaError('invalid usage response.', 503);
    for (const field of name === 'storage' ? ['limit', 'used', 'remaining', 'reserved'] : ['limit', 'used', 'remaining']) {
      const count = (value as Record<string, unknown>)[field];
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
        throw new QuotaError('invalid usage response.', 503);
      }
    }
  }
  return data as Usage;
}
