import path from 'node:path';

export function userDirectory(directory: string, userId: unknown): string {
  if (typeof userId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('a valid audio owner is required.');
  }
  return path.join(directory, userId);
}
