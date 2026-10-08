import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

test('local audio retention protects readers and concurrent writes share the disk cap', async () => {
  // Import an isolated copy so retention never deletes real local audio during this check.
  const directory = await mkdtemp(path.join(tmpdir(), 'local-audio-test-'));
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await mkdir(path.join(directory, 'src'));
  const modulePath = path.join(directory, 'src/local-audio.ts');
  await copyFile(new URL('../src/user-files.ts', import.meta.url), path.join(directory, 'src/user-files.ts'));
  await copyFile(new URL('../src/local-audio.ts', import.meta.url), modulePath);
  const storage: typeof import('../src/local-audio.js') = await import(pathToFileURL(modulePath).href);
  const roots = [storage.audioDirectory, storage.stemsDirectory, storage.cleanedDirectory];
  const expired: string[] = [];
  const retained: string[] = [];
  const old = new Date(Date.now() - storage.localAudioRetention - 60_000);
  let releaseUpload: (() => void) | undefined;
  try {
    for (const root of roots) {
      const owner = path.join(root, 'owner');
      await mkdir(path.join(owner, '.pending-crashed'), { recursive: true });
      for (const filename of [path.join(root, 'legacy.wav'), path.join(owner, '.pending-crashed/partial.wav')]) {
        await writeFile(filename, 'expired');
        await utimes(filename, old, old);
        expired.push(filename);
      }
      const current = path.join(owner, 'current.wav');
      await writeFile(current, 'kept');
      retained.push(current);
    }
    releaseUpload = storage.retainLocalAudio(retained[0]);
    const outside = path.join(directory, 'generated-song.mp3');
    await writeFile(outside, 'saved song');
    await utimes(outside, old, old);
    await symlink(outside, path.join(roots[0], 'link.mp3'));
    const releaseReader = storage.retainLocalAudio(expired[0]);
    const releaseSecondReader = storage.retainLocalAudio(expired[0]);
    await storage.cleanupLocalAudio();
    assert.equal(await readFile(expired[0], 'utf8'), 'expired');
    for (const filename of expired.slice(1)) await assert.rejects(stat(filename), { code: 'ENOENT' });
    for (const filename of retained) assert.equal(await readFile(filename, 'utf8'), 'kept');
    assert.equal(await readFile(outside, 'utf8'), 'saved song');
    releaseReader();
    await storage.cleanupLocalAudio();
    assert.equal(await readFile(expired[0], 'utf8'), 'expired');
    releaseSecondReader();
    await storage.cleanupLocalAudio();
    await assert.rejects(stat(expired[0]), { code: 'ENOENT' });

    // Sparse files exercise the 1 GiB limit without allocating 1 GiB on disk.
    await truncate(retained[0], storage.localAudioLimit - 108);
    const pending = path.join(roots[1], 'owner/.pending-active');
    const competing = path.join(roots[2], 'owner/competing.wav');
    const attempts = await Promise.allSettled([
      storage.reserveLocalAudio(pending, 100), storage.reserveLocalAudio(competing, 1),
    ]);
    assert.equal(attempts[0].status, 'fulfilled');
    assert.equal(attempts[1].status, 'rejected');
    if (attempts[0].status !== 'fulfilled') throw attempts[0].reason;
    await mkdir(pending);
    const partial = path.join(pending, 'source_vocals.wav');
    await writeFile(partial, Buffer.alloc(100));
    await utimes(partial, old, old);
    await storage.cleanupLocalAudio();
    assert.equal((await stat(partial)).size, 100);
    await assert.rejects(storage.reserveLocalAudio(competing, 1), storage.LocalAudioLimitError);
    // Failed work deletes its partial output before releasing its reservation.
    await rm(pending, { recursive: true });
    await attempts[0].value();
    const release = await storage.reserveLocalAudio(competing, 100);
    await release();
    await assert.rejects(storage.reserveLocalAudio(outside, 1), /invalid local audio reservation/);
    await assert.rejects(storage.reserveLocalAudio(competing, -1), /invalid local audio reservation/);
    const retry = await storage.reserveLocalAudio(competing, 100);
    await retry();

    for (const filename of ['audio.ts', 'user-files.ts']) {
      await copyFile(new URL(`../src/${filename}`, import.meta.url), path.join(directory, 'src', filename));
    }
    await writeFile(path.join(directory, 'src/songs.ts'),
      'export const musicDirectory = "unused"; export async function localSongPath() { throw new Error("no song download in this check"); }');
    const pythonDirectory = path.join(directory, 'audio-processing/.venv/bin');
    await mkdir(pythonDirectory, { recursive: true });
    await writeFile(path.join(pythonDirectory, 'python'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const audio: typeof import('../src/audio.js') = await import(pathToFileURL(path.join(directory, 'src/audio.ts')).href);
    const userId = '10000000-0000-4000-8000-000000000001';
    await assert.rejects(audio.uploadAudio('track.wav', Buffer.alloc(101), userId), storage.LocalAudioLimitError);
    const beforeFailure = await readdir(roots[0]);
    await assert.rejects(audio.uploadAudio('invalid.wav', Buffer.alloc(100), userId), /local audio processing failed/);
    assert.deepEqual((await readdir(roots[0])).sort(), [...beforeFailure, userId].sort());
    assert.deepEqual(await readdir(path.join(roots[0], userId)), []);
    // Failed validation releases its full reservation, so another attempt reaches the processor.
    await assert.rejects(audio.uploadAudio('invalid.wav', Buffer.alloc(100), userId), /local audio processing failed/);
    const source = path.join(roots[0], userId, '10000000-0000-4000-8000-000000000002.wav');
    await writeFile(source, 'source');
    await utimes(source, old, old);
    const url = '/api/audio/10000000-0000-4000-8000-000000000002.wav';
    for (const operation of ['stems', 'cleaned'] as const) {
      await assert.rejects(audio.processAudio(url, operation, userId), storage.LocalAudioLimitError);
      assert.equal(await readFile(source, 'utf8'), 'source', 'capacity failures preserve the active source');
    }
    await truncate(retained[0], 4);
    await writeFile(source, 'source');
    for (const operation of ['stems', 'cleaned'] as const) {
      await assert.rejects(audio.processAudio(url, operation, userId), /local audio processing failed/);
      const root = operation === 'stems' ? roots[1] : roots[2];
      assert.deepEqual(await readdir(path.join(root, userId)), [], 'processor failures delete pending output');
      assert.equal(await readFile(source, 'utf8'), 'source');
    }
    const userB = '10000000-0000-4000-8000-000000000003';
    const sessionDirectory = path.join(roots[0], userId);
    const otherDirectory = path.join(roots[0], userB);
    await mkdir(otherDirectory);
    await writeFile(path.join(otherDirectory, 'other.wav'), 'other session');
    const releaseSession = storage.retainLocalAudio(sessionDirectory);
    const releaseOtherSession = storage.retainLocalAudio(otherDirectory);
    await utimes(source, old, old);
    await storage.cleanupLocalAudio();
    assert.equal(await readFile(source, 'utf8'), 'source', 'uploads survive for the entire active session regardless of age');
    releaseSession();
    await storage.clearUploadedAudio(userId);
    await assert.rejects(stat(sessionDirectory), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(otherDirectory, 'other.wav'), 'utf8'), 'other session');
    releaseOtherSession();
    await storage.cleanupLocalAudio();
    await assert.rejects(stat(otherDirectory), { code: 'ENOENT' });
    releaseUpload();
    releaseUpload = undefined;
    await storage.cleanupLocalAudio();
    await assert.rejects(stat(retained[0]), { code: 'ENOENT' });
    assert.equal(await readFile(retained[1], 'utf8'), 'kept', 'completed stems keep their separate retention policy');
  } finally {
    releaseUpload?.();
    await rm(directory, { recursive: true, force: true });
  }
});
