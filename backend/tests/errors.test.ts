import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicError, publicErrorMessage } from '../src/errors.js';
import { operationFailure } from '../src/operations.js';
import { SongStorageError } from '../src/songs.js';
import { MusicGenerationError } from '../src/music.js';
import { QuotaError } from '../src/quotas.js';

test('unexpected errors stay in logs while public recovery messages and metadata survive', (t) => {
  const logs = t.mock.method(console, 'error', () => {});
  const internal = new Error('private provider diagnostics /srv/audio/file.wav');
  assert.equal(publicErrorMessage(internal, 'please try again.'), 'please try again.');
  assert.equal(logs.mock.calls[0].arguments[1], internal);
  assert.equal(publicErrorMessage({ message: 'untrusted diagnostic' }, 'please try again.'), 'please try again.');
  assert.equal(publicErrorMessage(new PublicError('choose a valid billing plan.'), 'fallback'), 'choose a valid billing plan.');
  assert.deepEqual(operationFailure(internal), { error: 'request failed. check your requests before trying again.' });
  const storage = new SongStorageError('song-id', false, internal);
  const failure = operationFailure(storage);
  assert.equal(failure.songId, 'song-id');
  assert.match(String(failure.error), /retry saving/);
  assert.doesNotMatch(JSON.stringify(failure), /private provider|\/srv\/audio/);
  assert.equal(storage.cause, internal);
  assert.equal(operationFailure(new MusicGenerationError('generation outcome is unknown.', false)).generationStatus, 'unknown');
  const quota = operationFailure(new QuotaError('allowance exhausted.', 429, 'chat', '2026-10-21T00:00:00Z'));
  assert.deepEqual(quota, { error: 'allowance exhausted.', code: 'quota_exceeded', resource: 'chat', resetAt: '2026-10-21T00:00:00Z' });
  assert.doesNotMatch(String(operationFailure(new QuotaError('private database detail', 503)).error), /private database/);
});
