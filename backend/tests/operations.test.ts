import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { configureTestOperations } from './operation-fixture.js';
import { configureTestGateway, testGatewayURL } from './gateway-environment.js';
import { cleanupSongRecovery, musicDirectory, saveSong, SongStorageError } from '../src/songs.js';
import { getOperation, sessionBusy, startOperation } from '../src/operations.js';
import { reserveUsage } from '../src/quotas.js';
import { endUploadSession, resetAgentSession } from '../src/agent.js';
import { audioDirectory } from '../src/audio.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test('durable operations survive lost start responses and deletion locks survive disconnects', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.LANGSMITH_TRACING = 'false';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_offline';
  const storage = configureTestOperations();
  const restoreGateway = configureTestGateway();
  const owner = randomUUID();
  const other = randomUUID();
  const id = randomUUID();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'offline', alg: 'ES256', use: 'sig' };
  const originalFetch = globalThis.fetch;
  const inserted = gate();
  const insertResponse = gate();
  const providerStarted = gate();
  const providerResult = gate();
  let generations = 0;
  storage.hooks.insert = async () => { inserted.release(); await insertResponse.promise; };
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const database = await storage.databaseResponse(request.clone());
    if (database) return database;
    if (request.url.endsWith('/auth/v1/.well-known/jwks.json')) return Response.json({ keys: [jwk] });
    if (request.url === `${testGatewayURL}/google-ai-studio/v1beta/models/lyria-3.5:countTokens`) return Response.json({ totalTokens: 10 });
    if (request.url === `${testGatewayURL}/google-ai-studio/v1beta/interactions`) {
      generations++;
      providerStarted.release();
      await providerResult.promise;
      return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [
        { type: 'audio', mime_type: 'audio/mpeg', data: Buffer.from('ID3-offline').toString('base64') },
      ] }] });
    }
    assert.ok(request.url.startsWith('http://127.0.0.1:'), 'live services are forbidden');
    return originalFetch(input, options);
  };
  const { app } = await import('../src/index.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  function headers(userId = owner) {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'offline' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: `${process.env.SUPABASE_URL}/auth/v1`, aud: 'authenticated',
      role: 'authenticated', sub: userId, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const body = `${header}.${claims}`;
    return { Authorization: `Bearer ${body}.${sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`,
      'Content-Type': 'application/json' };
  }
  const start = (signal?: AbortSignal) => fetch(`${base}/api/music`, { method: 'POST', headers: headers(), signal,
    body: JSON.stringify({ operationId: id, prompt: 'offline folk' }) });
  t.after(async () => {
    insertResponse.release(); providerResult.release();
    globalThis.fetch = originalFetch;
    storage.restore(); restoreGateway();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(path.join(musicDirectory, owner), { recursive: true, force: true });
  });
  const controller = new AbortController();
  const lost = start(controller.signal).catch((error: unknown) => error);
  await inserted.promise;
  controller.abort();
  assert.ok(await lost instanceof Error);
  insertResponse.release();
  await providerStarted.promise;
  assert.equal(sessionBusy(owner), true);
  const progress = await fetch(`${base}/api/operations/${id}`, { headers: headers() });
  assert.equal((await progress.json()).operation.state, 'running');
  assert.equal((await fetch(`${base}/api/operations/${id}`, { headers: headers(other) })).status, 404);
  assert.equal((await start()).status, 409);
  assert.equal((await fetch(`${base}/api/reset`, { method: 'POST', headers: headers() })).status, 409);
  providerResult.release();
  let operation = await getOperation(owner, id);
  while (operation.state === 'running') { await new Promise((resolve) => setTimeout(resolve, 10)); operation = await getOperation(owner, id); }
  assert.equal(operation.state, 'completed');
  assert.equal((operation.result?.track as { url: string }).url, `/api/music/${id}.mp3`);
  assert.equal(generations, 1);
  assert.equal((await start()).status, 202);
  assert.equal(generations, 1, 'same operation ID cannot dispatch paid work twice');

  const deleteStarted = gate();
  const deleteResult = gate();
  const send = S3Client.prototype.send.bind(S3Client.prototype);
  const deletion = t.mock.method(S3Client.prototype, 'send', async (command: unknown) => {
    if (command instanceof DeleteObjectCommand) { deleteStarted.release(); await deleteResult.promise; }
    return send(command as never);
  });
  const abortDelete = new AbortController();
  const pendingDelete = fetch(`${base}/api/songs/${id}`, { method: 'DELETE', headers: headers(), signal: abortDelete.signal })
    .catch((error: unknown) => error);
  await deleteStarted.promise;
  abortDelete.abort(); await pendingDelete;
  assert.equal((await fetch(`${base}/api/reset`, { method: 'POST', headers: headers() })).status, 409);
  deleteResult.release();
  while (sessionBusy(owner)) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await fetch(`${base}/api/reset`, { method: 'POST', headers: headers() })).status, 200);
  assert.equal(storage.rows.has(id), false);
  deletion.mock.restore();
});

test('restart reconciliation restores saved audio, journaled answers, and uncertain reservations without paid retries', async (t) => {
  process.env.LANGSMITH_TRACING = 'false';
  const storage = configureTestOperations();
  const originalFetch = globalThis.fetch;
  const owner = randomUUID();
  const directory = path.join(musicDirectory, owner);
  const uploads = path.join(audioDirectory, owner);
  globalThis.fetch = async (input, options) => {
    const response = await storage.databaseResponse(new Request(input, options));
    assert.ok(response, 'no model or external calls permitted');
    return response;
  };
  t.after(async () => { globalThis.fetch = originalFetch; storage.restore(); await resetAgentSession(owner); await rm(directory, { recursive: true, force: true }); await rm(uploads, { recursive: true, force: true }); });
  const interrupted = (id: string, kind = 'music') => {
    const row = { id, kind, owner_id: owner, state: 'running', status: 'working...', result: null, acknowledged: false, created_at: new Date().toISOString() };
    storage.operations.set(id, row);
    return row;
  };
  const savedId = await reserveUsage(owner, 'generation', 100);
  interrupted(savedId);
  storage.failures.put = true;
  await assert.rejects(saveSong(owner, Buffer.from('ID3-recovery'), 'folk', 'lyria-3.5', 'words', savedId), SongStorageError);
  storage.failures.put = false;
  assert.equal((await getOperation(owner, savedId)).state, 'completed');
  assert.equal(storage.quotas.reservations.get(savedId)?.status, 'completed');
  const unknownId = await reserveUsage(owner, 'generation', 100);
  interrupted(unknownId);
  assert.equal((await getOperation(owner, unknownId)).state, 'unknown');
  assert.equal(storage.quotas.reservations.get(unknownId)?.status, 'reserved');
  const preflightId = randomUUID();
  interrupted(preflightId);
  assert.equal((await getOperation(owner, preflightId)).state, 'failed');
  const chatId = randomUUID();
  const chat = interrupted(chatId, 'chat');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${chatId}.operation.json`), JSON.stringify({ ...chat, state: 'completed', result: { reply: 'recovered analysis' } }));
  assert.deepEqual((await getOperation(owner, chatId)).result, { reply: 'recovered analysis' });
  const failedId = await reserveUsage(owner, 'generation', 100);
  const failed = interrupted(failedId);
  await writeFile(path.join(directory, `${failedId}.operation.json`), JSON.stringify({ ...failed, state: 'failed',
    result: { error: 'confirmed rejection', generationStatus: 'failed' } }));
  assert.equal((await getOperation(owner, failedId)).state, 'failed');
  assert.equal(storage.quotas.reservations.get(failedId)?.status, 'failed');
  assert.equal((await getOperation(owner, failedId)).state, 'failed', 'confirmed refund is safe to reconcile repeatedly');
  const emptyChat = randomUUID(); interrupted(emptyChat, 'chat');
  assert.equal((await getOperation(owner, emptyChat)).state, 'unknown');

  let calls = 0;
  const quickId = randomUUID();
  await startOperation(owner, quickId, 'chat', async () => { calls++; return { reply: 'done' }; });
  let quick = await getOperation(owner, quickId);
  while (quick.state === 'running') { await new Promise((resolve) => setTimeout(resolve, 10)); quick = await getOperation(owner, quickId); }
  await startOperation(owner, quickId, 'chat', async () => { calls++; return { reply: 'duplicate' }; });
  assert.equal(calls, 1);

  const analysisStarted = gate();
  const analysisResult = gate();
  await mkdir(uploads, { recursive: true });
  const attachment = path.join(uploads, `${randomUUID()}.wav`);
  await writeFile(attachment, 'private analysis input');
  const analysisId = randomUUID();
  await startOperation(owner, analysisId, 'chat', async () => {
    analysisStarted.release(); await analysisResult.promise; return { reply: 'analysis complete' };
  });
  await analysisStarted.promise;
  await endUploadSession(owner);
  await access(attachment);
  analysisResult.release();
  while (sessionBusy(owner)) await new Promise((resolve) => setTimeout(resolve, 10));
  await endUploadSession(owner).catch(() => undefined);
  await assert.rejects(access(attachment), /ENOENT/);

  const expiredId = await reserveUsage(owner, 'generation', 100);
  storage.failures.put = true;
  await assert.rejects(saveSong(owner, Buffer.from('ID3-expired'), 'folk', 'lyria-3.5', '', expiredId), SongStorageError);
  const expiredMetadata = path.join(directory, `${expiredId}.json`);
  await utimes(expiredMetadata, new Date(0), new Date(0));
  storage.failures.deleteRow = true;
  await assert.rejects(cleanupSongRecovery((userId) => userId === owner ? () => {} : undefined), /expired song metadata/);
  await access(expiredMetadata);
  storage.failures.deleteRow = false;
  await cleanupSongRecovery((userId) => userId === owner ? () => {} : undefined);
  await assert.rejects(access(expiredMetadata), /ENOENT/);
  assert.equal(storage.rows.has(expiredId), false);
  storage.failures.put = false;

  const oldTemporary = path.join(directory, `${randomUUID()}.mp3.orphan.tmp`);
  const freshTemporary = path.join(directory, `${randomUUID()}.mp3.fresh.tmp`);
  await writeFile(oldTemporary, 'partial'); await writeFile(freshTemporary, 'active');
  await utimes(oldTemporary, new Date(0), new Date(0));
  await cleanupSongRecovery((userId) => userId === owner ? () => {} : undefined);
  await assert.rejects(access(oldTemporary), /ENOENT/);
  await access(freshTemporary);
});
