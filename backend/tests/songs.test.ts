import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { checkSongStorage, deleteSong, listSongRecovery, localSongPath, musicDirectory, retrySongStorage, saveSong, SongStorageError } from '../src/songs.js';
import { prepareAnalysisAudio } from '../src/audio.js';
import { configureTestGateway, testGatewayURL } from './gateway-environment.js';
import { configureTestSongStorage } from './song-fixture.js';

test('songs persist privately, restore from R2, and retry failed saves without regenerating', async () => {
  process.env.NODE_ENV = 'test';
  process.env.LANGSMITH_TRACING = 'false';
  const storage = configureTestSongStorage();
  const restoreGateway = configureTestGateway();
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_offline';
  const originalFetch = globalThis.fetch;
  const userA = randomUUID();
  const userB = randomUUID();
  const audio = Buffer.from('ID3-private-song');
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'offline', alg: 'ES256', use: 'sig' };
  let generations = 0;
  let tokenCalls = 0;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const database = await storage.databaseResponse(request);
    if (database) return database;
    if (request.url === `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`) return Response.json({ keys: [jwk] });
    if (request.url === `${testGatewayURL}/google-ai-studio/v1beta/models/lyria-3.5:countTokens`) {
      tokenCalls++;
      return Response.json({ totalTokens: 10 });
    }
    if (request.url === `${testGatewayURL}/google-ai-studio/v1beta/interactions`) {
      generations++;
      return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [
        { type: 'audio', mime_type: 'audio/mpeg', data: audio.toString('base64') },
        { type: 'text', text: 'saved lyrics' },
      ] }] });
    }
    assert.ok(request.url.startsWith('http://127.0.0.1:'), 'no live services are permitted');
    return originalFetch(input, init);
  };
  const { app } = await import('../src/index.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  function headers(userId: string) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'offline' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: `${process.env.SUPABASE_URL}/auth/v1`, aud: 'authenticated',
      role: 'authenticated', sub: userId, exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const body = `${header}.${claims}`;
    return { Authorization: `Bearer ${body}.${sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`,
      'Content-Type': 'application/json' };
  }
  const headersA = headers(userA);
  const headersB = headers(userB);
  const generate = () => fetch(`${base}/api/music`, { method: 'POST', headers: headersA,
    body: JSON.stringify({ prompt: 'instrumental folk', owner_id: userB, userId: userB }),
  });

  try {
    assert.equal((await fetch(`${base}/api/songs`)).status, 401);
    assert.equal((await fetch(`${base}/api/songs/recovery`)).status, 401);
    const response = await generate();
    assert.equal(response.status, 200);
    const { track } = await response.json();
    assert.equal(generations, 1);
    const row = storage.rows.get(track.id)!;
    assert.equal(row.owner_id, userA);
    assert.equal(row.status, 'ready');
    assert.equal(row.object_key, `users/${userA}/${track.id}.mp3`);
    assert.equal(track.lyrics, 'saved lyrics');
    assert.deepEqual(storage.objects.get(row.object_key as string), audio);
    const own = await (await fetch(`${base}/api/songs?owner_id=${userB}`, { headers: headersA })).json();
    assert.equal(own.songs.length, 1);
    assert.equal(own.songs[0].id, track.id);
    assert.equal('object_key' in own.songs[0], false);
    assert.deepEqual(await (await fetch(`${base}/api/songs`, { headers: headersB })).json(), { songs: [] });
    assert.deepEqual(await (await fetch(`${base}/api/songs/recovery`, { headers: headersA })).json(), { songIds: [] });
    assert.equal((await fetch(`${base}${track.url}`, { headers: headersB })).status, 404);
    assert.equal(storage.reads, 0);
    const playback = await fetch(`${base}${track.url}`, { headers: headersA });
    assert.equal(playback.status, 200);
    assert.equal(playback.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(Buffer.from(await playback.arrayBuffer()), audio);
    const range = await fetch(`${base}${track.url}`, { headers: { ...headersA, Range: 'bytes=0-2' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-2/${audio.length}`);
    assert.equal(await range.text(), 'ID3');
    for (const Range of ['bytes=999-', 'bytes=2-1', 'bytes=0-1,3-4']) {
      assert.equal((await fetch(`${base}${track.url}`, { headers: { ...headersA, Range } })).status, 416);
    }
    await assert.rejects(readFile(`${musicDirectory}${userA}/${track.id}.mp3`), /ENOENT/);
    const local = await localSongPath(userA, track.id);
    assert.deepEqual(await readFile(local.filename), audio);
    await rm(local.filename);
    const prepared = await prepareAnalysisAudio(track.url, userA);
    assert.equal(prepared.data, audio.toString('base64'));
    await assert.rejects(localSongPath(userB, track.id), /song not found/);
    await assert.rejects(prepareAnalysisAudio(track.url, userB), /song not found/);
    storage.rows.set(track.id, { ...row, object_key: `users/${userB}/${track.id}.mp3` });
    const beforeTamperedRead = storage.reads;
    assert.equal((await fetch(`${base}${track.url}`, { headers: headersA })).status, 404);
    await assert.rejects(localSongPath(userA, track.id), /song not found/);
    assert.equal(storage.reads, beforeTamperedRead);
    storage.rows.set(track.id, row);

    const legacyId = randomUUID();
    await writeFile(`${musicDirectory}${userA}/${legacyId}.mp3`, audio);
    const legacyUrl = `/api/music/${legacyId}.mp3`;
    assert.equal((await fetch(`${base}${legacyUrl}`, { headers: headersA })).status, 200);
    assert.equal((await fetch(`${base}${legacyUrl}`, { headers: headersB })).status, 404);
    delete process.env.SUPABASE_SECRET_KEY;
    assert.equal((await fetch(`${base}${legacyUrl}`, { headers: headersA })).status, 200);
    assert.equal((await prepareAnalysisAudio(legacyUrl, userA)).data, audio.toString('base64'));
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_offline';

    const otherTrack = await saveSong(userB, audio, 'piano', 'lyria-3.5', '');
    const deleteUrl = `${base}/api/songs/${track.id}`;
    assert.equal((await fetch(deleteUrl, { method: 'DELETE' })).status, 401);
    assert.equal((await fetch(deleteUrl, { method: 'DELETE', headers: headersB })).status, 404);
    assert.equal((await fetch(`${base}/api/songs/invalid`, { method: 'DELETE', headers: headersA })).status, 404);
    storage.rows.set(track.id, { ...row, object_key: `users/${userB}/${track.id}.mp3` });
    assert.equal((await fetch(deleteUrl, { method: 'DELETE', headers: headersA })).status, 404);
    storage.rows.set(track.id, { ...row, status: 'pending' });
    assert.equal((await fetch(deleteUrl, { method: 'DELETE', headers: headersA })).status, 404);
    storage.rows.set(track.id, row);
    assert.equal(storage.deletes, 0, 'reject invalid ownership and state before touching R2');
    storage.failures.deleteObject = true;
    assert.equal((await fetch(deleteUrl, { method: 'DELETE', headers: headersA })).status, 502);
    assert.ok(storage.rows.has(track.id));
    assert.ok(storage.objects.has(row.object_key as string));
    storage.failures.deleteObject = false;
    // Stale local files must not become playable through the legacy fallback after deletion.
    await writeFile(`${musicDirectory}${userA}/${track.id}.mp3`, audio);
    await writeFile(`${musicDirectory}${userA}/${track.id}.json`, JSON.stringify(row));
    storage.failures.deleteRow = true;
    const partialDelete = await fetch(deleteUrl, { method: 'DELETE', headers: headersA });
    assert.equal(partialDelete.status, 502);
    assert.match((await partialDelete.json()).error, /try deleting again/);
    assert.ok(storage.rows.has(track.id), 'keep metadata so cleanup can be retried');
    assert.equal(storage.objects.has(row.object_key as string), false);
    await assert.rejects(readFile(`${musicDirectory}${userA}/${track.id}.mp3`), /ENOENT/);
    await assert.rejects(readFile(`${musicDirectory}${userA}/${track.id}.json`), /ENOENT/);
    storage.failures.deleteRow = false;
    assert.equal((await fetch(deleteUrl, { method: 'DELETE', headers: headersA })).status, 204);
    assert.equal(storage.rows.has(track.id), false);
    assert.equal((await fetch(`${base}${track.url}`, { headers: headersA })).status, 404);
    assert.equal((await fetch(`${base}${track.url}`, { headers: headersB })).status, 404);
    assert.ok(storage.rows.has(otherTrack.id));
    assert.ok(storage.objects.has(`users/${userB}/${otherTrack.id}.mp3`));
    assert.equal((await fetch(deleteUrl, { method: 'DELETE', headers: headersA })).status, 404);

    for (const failure of ['insert', 'put', 'ready', 'readyResponse'] as const) {
      storage.failures[failure] = true;
      const failed = await generate();
      assert.equal(failed.status, 502);
      const error = await failed.json();
      assert.match(error.error, /song generated, but saving failed/);
      assert.match(error.songId, /^[0-9a-f-]{36}$/);
      const recovery = await (await fetch(`${base}/api/songs/recovery`, { headers: headersA })).json();
      assert.ok(recovery.songIds.includes(error.songId));
      if (failure !== 'readyResponse') {
        assert.equal((await fetch(`${base}/api/music/${error.songId}.mp3`, { headers: headersA })).status, 404);
      }
      const beforeRetry = generations;
      const reservationsBeforeRetry = storage.quotas.reservations.size;
      const tokensBeforeRetry = tokenCalls;
      assert.equal((await fetch(`${base}${error.retryUrl}`, { method: 'POST', headers: headersB })).status, 404);
      storage.failures[failure] = false;
      const retry = await fetch(`${base}${error.retryUrl}`, { method: 'POST', headers: headersA });
      assert.equal(retry.status, 200);
      assert.equal((await retry.json()).track.id, error.songId);
      assert.equal(generations, beforeRetry);
      assert.equal(storage.quotas.reservations.size, reservationsBeforeRetry, 'storage retry never reserves another paid attempt');
      assert.equal(tokenCalls, tokensBeforeRetry);
      const writesBeforeRepeat = storage.writes;
      assert.equal((await fetch(`${base}${error.retryUrl}`, { method: 'POST', headers: headersA })).status, 200);
      assert.equal(storage.writes, writesBeforeRepeat);
    }
    assert.equal((await fetch(`${base}/api/songs/invalid/retry`, { method: 'POST', headers: headersA })).status, 404);
    assert.equal((await fetch(`${base}/api/songs/unknown`, { method: 'POST', headers: headersA })).status, 404);
    assert.equal((await fetch(`${base}/api/reset`, { method: 'POST', headers: headersA })).status, 200);
    storage.failures.read = true;
    const beforePreflight = generations;
    const unavailable = await generate();
    assert.equal(unavailable.status, 502);
    assert.match((await unavailable.json()).error, /generation was not started/);
    assert.equal(generations, beforePreflight);
    storage.failures.read = false;
    storage.failures.put = true;
    for (let i = 0; i < 5; i++) await assert.rejects(saveSong(userA, audio, 'folk', 'lyria-3.5', ''), /saving failed/);
    await assert.rejects(checkSongStorage(userA), /retry your unsaved songs/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    storage.restore();
    restoreGateway();
    await rm(`${musicDirectory}${userA}`, { recursive: true, force: true });
    await rm(`${musicDirectory}${userB}`, { recursive: true, force: true });
  }
});

test('disk failures preserve storage retry and temporary processing files never become partial caches', async (context) => {
  const storage = configureTestSongStorage();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await storage.databaseResponse(new Request(input, init));
    assert.ok(response, 'no live services are permitted');
    return response;
  };
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const directory = `${musicDirectory}${userId}`;
  const audio = Buffer.from('ID3-disk-failure-fixture');
  const originalWrite = fs.writeFile;
  let diskFull = true;
  let audioWriteFails = false;
  let cacheWriteFails = false;
  const writes = context.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    const filename = String(args[0]);
    if (filename.startsWith(directory) && (diskFull || (audioWriteFails && filename.includes('.mp3.')))) {
      throw Object.assign(new Error('offline disk full'), { code: 'ENOSPC' });
    }
    if (cacheWriteFails && filename.includes('.cache.mp3.')) {
      await originalWrite(args[0], Buffer.from('partial'));
      throw Object.assign(new Error('offline interrupted write'), { code: 'ENOSPC' });
    }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  context.after(async () => {
    writes.mock.restore();
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    storage.restore();
    await rm(directory, { recursive: true, force: true });
  });

  // R2 success must not depend on the local recovery disk.
  const saved = await saveSong(userId, audio, 'folk', 'lyria-3.5', 'lyrics');
  assert.equal(storage.rows.get(saved.id)?.status, 'ready');
  assert.deepEqual(storage.objects.get(`users/${userId}/${saved.id}.mp3`), audio);
  assert.deepEqual(await listSongRecovery(userId), []);

  for (const failAfterMetadata of [false, true]) {
    diskFull = !failAfterMetadata;
    audioWriteFails = failAfterMetadata;
    storage.failures.put = true;
    let failedId = '';
    await assert.rejects(saveSong(userId, audio, 'folk', 'lyria-3.5', 'lyrics'), (error: unknown) => {
      assert.ok(error instanceof SongStorageError);
      assert.match(error.message, /keep the backend running/);
      failedId = error.songId;
      return true;
    });
    assert.deepEqual(await listSongRecovery(userId), [failedId]);
    assert.deepEqual(await listSongRecovery(otherUserId), []);
    await assert.rejects(retrySongStorage(otherUserId, failedId), /not found/);
    await assert.rejects(retrySongStorage(userId, failedId), /keep the backend running/);
    storage.failures.put = false;
    const retried = await retrySongStorage(userId, failedId);
    assert.equal(retried.id, failedId);
    assert.deepEqual(await listSongRecovery(userId), []);
    await assert.rejects(readFile(`${directory}/${failedId}.mp3`), /ENOENT/);
  }
  diskFull = false;
  audioWriteFails = false;

  // An old partial cache must never be trusted merely because it exists.
  await writeFile(`${directory}/${saved.id}.mp3`, Buffer.from('partial'));
  cacheWriteFails = true;
  await assert.rejects(localSongPath(userId, saved.id), /interrupted write/);
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith('.tmp') || name.endsWith('.cache.mp3')), false);
  cacheWriteFails = false;
  const local = await localSongPath(userId, saved.id);
  assert.equal(local.temporary, true);
  assert.deepEqual(await readFile(local.filename), audio);
  await assert.rejects(readFile(`${directory}/${saved.id}.mp3`), /ENOENT/);
  await rm(local.filename);
  storage.objects.set(`users/${userId}/${saved.id}.mp3`, Buffer.from('short'));
  await assert.rejects(localSongPath(userId, saved.id), /incomplete audio/);
  storage.objects.set(`users/${userId}/${saved.id}.mp3`, audio);

  const url = `/api/music/${saved.id}.mp3`;
  assert.equal((await prepareAnalysisAudio(url, userId)).data, audio.toString('base64'));
  assert.deepEqual(await fs.readdir(directory), []);

  await writeFile(`${directory}/${saved.id}.mp3`, audio);
  const originalRemove = fs.rm;
  let cleanupFails = true;
  const removals = context.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
    if (cleanupFails && String(args[0]) === `${directory}/${saved.id}.mp3`) throw new Error('offline cleanup failure');
    return originalRemove(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(deleteSong(userId, saved.id), /could not delete local song files/);
    assert.ok(storage.rows.has(saved.id));
    assert.deepEqual(await readFile(`${directory}/${saved.id}.mp3`), audio);
    cleanupFails = false;
    await deleteSong(userId, saved.id);
    assert.equal(storage.rows.has(saved.id), false);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    removals.mock.restore();
    syncBuiltinESMExports();
  }
});
