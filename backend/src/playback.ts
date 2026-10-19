import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isUuid } from './validation.js';

// shortcut: links use a per-process key, share a key before running multiple backend instances.
const signingKey = randomBytes(32);
const mediaPath = /^\/api\/(?:music\/[0-9a-f-]{36}\.mp3|audio\/[0-9a-f-]{36}\.(?:mp3|wav|flac|ogg))$/i;

export function isPlaybackPath(value: unknown): value is string {
  return typeof value === 'string' && mediaPath.test(value) && isUuid(value.split('/').pop()?.split('.')[0]);
}

function signature(src: string, userId: string, expiresAt: number): Buffer {
  return createHmac('sha256', signingKey).update(`${src}\n${userId}\n${expiresAt}`).digest();
}

export function createPlaybackUrl(src: string, userId: string, sessionExpiresAt: number): string {
  const expiresAt = Math.min(Math.floor(Date.now() / 1000) + 3600, sessionExpiresAt);
  const token = `${userId}.${expiresAt}.${signature(src, userId, expiresAt).toString('base64url')}`;
  return `${src}?playback=${token}`;
}

function parsePlaybackToken(token: string): { userId: string; expiresAt: number; supplied: Buffer } | undefined {
  const parts = token.split('.');
  if (parts.length !== 3 || !isUuid(parts[0])) return;
  if (!/^\d+$/.test(parts[1]) || !/^[\w-]{43}$/.test(parts[2])) return;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() / 1000) return;
  return { userId: parts[0], expiresAt, supplied: Buffer.from(parts[2], 'base64url') };
}

export function playbackUser(src: string, token: unknown): string | undefined {
  if (!isPlaybackPath(src) || typeof token !== 'string') return;
  const parsed = parsePlaybackToken(token);
  if (!parsed) return;
  const expected = signature(src, parsed.userId, parsed.expiresAt);
  if (parsed.supplied.length === expected.length && timingSafeEqual(parsed.supplied, expected)) return parsed.userId;
}
