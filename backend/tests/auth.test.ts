import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { userDirectory } from '../src/user-files.js';
import { configureTestQuotas } from './quota-fixture.js';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

test('verified users own their API session and local media', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.LANGSMITH_TRACING = 'false';
  process.env.MAX_AUDIO_JOBS = '2';
  process.env.SUPABASE_URL = 'https://offline-auth.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_offline';
  const quotas = configureTestQuotas();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'offline', alg: 'ES256', use: 'sig' };
  const originalFetch = globalThis.fetch;
  let authRequests = 0;
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const database = await quotas.databaseResponse(request.clone());
    if (database) return database;
    if (request.url.startsWith(process.env.SUPABASE_URL!)) {
      authRequests++;
      assert.equal(request.url, `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
      return Response.json({ keys: [jwk] });
    }
    assert.ok(request.url.startsWith('http://127.0.0.1:'), 'no provider calls are permitted');
    return originalFetch(input, options);
  };
  const { app } = await import('../src/index.js');
  const { getOrCreateAgent, getChatContext, resetAgentSession, retainUploadSession } = await import('../src/agent.js');
  const { audioDirectory, audioPath, prepareAnalysisAudio, startAudioUpload } = await import('../src/audio.js');
  const userA = randomUUID();
  const userB = randomUUID();
  const filename = `${randomUUID()}.wav`;
  const directory = userDirectory(audioDirectory, userA);
  const finishUpload = retainUploadSession(userA);
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${filename}`, Buffer.from('private fixture'));
  finishUpload();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;

  function token(userId: string, overrides: Record<string, unknown> = {}): string {
    const header = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: 'offline' })).toString('base64url');
    const claims = Buffer.from(JSON.stringify({ iss: `${process.env.SUPABASE_URL}/auth/v1`,
      aud: 'authenticated', role: 'authenticated', sub: userId,
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...overrides,
    })).toString('base64url');
    const body = `${header}.${claims}`;
    return `${body}.${sign('sha256', Buffer.from(body), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  }
  const headersA = { Authorization: `Bearer ${token(userA)}`, 'Content-Type': 'application/json' };
  const headersB = { Authorization: `Bearer ${token(userB)}`, 'Content-Type': 'application/json' };

  try {
    assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { status: 'ok' });
    const allowed = await fetch(`${url}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    const foreign = await fetch(`${url}/api/health`, { headers: { Origin: 'https://example.com' } });
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    for (const endpoint of ['context', 'usage', 'chat', 'music', 'reset', 'session/end', 'audio', `audio/${filename}`]) {
      assert.equal((await fetch(`${url}/api/${endpoint}`)).status, 401);
    }
    assert.equal(authRequests, 0);
    const valid = token(userA);
    for (const invalid of ['malformed', token(userA, { exp: 1 }), token(userA, { iss: 'https://another-project.supabase.co/auth/v1' }),
      token(userA, { aud: 'wrong' }), token(userA, { role: 'service_role' }), token(userA, { sub: '../../secrets' }),
      token(userA, { is_anonymous: true }), `${valid.slice(0, -8)}AAAAAAAA`]) {
      assert.equal((await fetch(`${url}/api/context`, { headers: { Authorization: `Bearer ${invalid}` } })).status, 401);
    }

    const agentA = getOrCreateAgent(userA);
    const agentB = getOrCreateAgent(userB);
    assert.notEqual(agentA, agentB);
    agentA.messages.push({ role: 'user', content: [{ type: 'textBlock', text: 'private message' }] });
    assert.deepEqual(await (await fetch(`${url}/api/context`, { headers: headersA })).json(), { messages: 1, limit: 40 });
    assert.deepEqual(await (await fetch(`${url}/api/context`, { headers: headersB })).json(), { messages: 0, limit: 40 });
    const ownFile = await fetch(`${url}/api/audio/${filename}`, { headers: headersA });
    assert.equal(ownFile.status, 200);
    assert.equal(await ownFile.text(), 'private fixture');
    assert.equal(ownFile.headers.get('cache-control'), 'private, no-store');
    assert.equal((await fetch(`${url}/api/audio/${filename}`, { headers: headersB })).status, 404);
    const reset = await fetch(`${url}/api/reset`, { method: 'POST', headers: headersB, body: JSON.stringify({ sessionId: userA }) });
    assert.equal(reset.status, 200);
    assert.equal(getChatContext(userA).messages, 1);

    let start!: () => void;
    let cancel!: (error: Error) => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    agentA.invoke = () => {
      start();
      return new Promise<never>((_resolve, reject) => { cancel = reject; });
    };
    for (const failure of ['quota', 'global', 'unavailable', 'invalid'] as const) {
      const exhausted = failure === 'quota' || failure === 'global';
      quotas.failures.resource = exhausted ? 'chat' : undefined;
      quotas.failures.scope = failure === 'global' ? 'global' : undefined;
      quotas.failures.unavailable = failure === 'unavailable';
      quotas.failures.invalid = failure === 'invalid';
      const denied = await fetch(`${url}/api/chat`, { method: 'POST', headers: { ...headersA, Accept: 'application/x-ndjson' },
        body: JSON.stringify({ message: 'denied', userId: userB }),
      });
      assert.equal(denied.status, exhausted ? 429 : 503);
      assert.equal(denied.headers.get('content-type')?.includes('application/json'), true, 'deny before streaming headers');
      const body = await denied.json();
      assert.equal(body.code, exhausted ? 'quota_exceeded' : 'quota_unavailable');
      if (failure === 'global') assert.match(body.error, /app-wide daily chat allowance exhausted/);
      if (exhausted) {
        assert.equal(body.resource, 'chat');
        assert.ok(denied.headers.get('retry-after'));
      }
      assert.equal(quotas.reservations.size, 0, 'no model invocation or reservation on quota failure');
    }
    quotas.failures.resource = undefined;
    quotas.failures.unavailable = false;
    quotas.failures.invalid = false;
    const pendingChat = fetch(`${url}/api/chat`, { method: 'POST', headers: headersA, body: JSON.stringify({ message: 'pending' }) });
    await started;
    assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersA })).status, 409);
    assert.equal((await fetch(`${url}/api/audio?name=track.wav`, { method: 'POST', headers: { ...headersA, 'Content-Type': 'application/octet-stream' }, body: 'audio' })).status, 409);
    assert.equal((await fetch(`${url}/api/songs/${randomUUID()}`, { method: 'DELETE', headers: headersA })).status, 409);
    assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersB })).status, 200);
    cancel(new Error('offline request cancellation'));
    assert.equal((await pendingChat).status, 500);
    const usageBeforeReset = await (await fetch(`${url}/api/usage?userId=${userB}`, { headers: headersA })).json();
    assert.equal(usageBeforeReset.chat.used, 1, 'failed paid requests consume one allowance');
    const originalRm = fs.rm;
    const failure = t.mock.method(fs, 'rm', async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]) === `${directory}/${filename}`) throw new Error('offline upload cleanup failure');
      return originalRm(...args);
    });
    syncBuiltinESMExports();
    const failedReset = await fetch(`${url}/api/reset`, { method: 'POST', headers: headersA });
    assert.equal(failedReset.status, 500);
    assert.match((await failedReset.json()).error, /upload cleanup failure/);
    assert.equal(getChatContext(userA).messages, 1, 'failed cleanup preserves the conversation for retry');
    assert.equal(await fs.readFile(`${directory}/${filename}`, 'utf8'), 'private fixture');
    failure.mock.restore();
    syncBuiltinESMExports();
    assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersA })).status, 200);
    assert.deepEqual(await (await fetch(`${url}/api/usage`, { headers: headersA })).json(), usageBeforeReset, 'conversation reset does not reset usage');
    assert.equal((await (await fetch(`${url}/api/usage`, { headers: headersB })).json()).chat.used, 0);

    assert.equal((await fetch(`${url}/api/audio/${filename}`, { headers: headersA })).status, 404, 'session reset deletes uploads before it succeeds');
    assert.equal((await fetch(`${url}/api/audio/${filename}`, { headers: headersB })).status, 404);
    assert.notEqual(audioPath(`/api/audio/${filename}`, userA), audioPath(`/api/audio/${filename}`, userB));
    await assert.rejects(prepareAnalysisAudio(`/api/audio/${filename}`, userB), /no longer exists/);
    assert.throws(() => audioPath(`/api/audio/${filename}`, '../../secrets'), /valid audio owner/);
    assert.throws(() => audioPath('/api/audio/../../.env', userA), /choose a generated track/);
    const finishLogout = retainUploadSession(userA);
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/${filename}`, 'logout fixture');
    finishLogout();
    assert.equal((await fetch(`${url}/api/session/end`, { method: 'POST', headers: headersB })).status, 204);
    assert.equal(await fs.readFile(`${directory}/${filename}`, 'utf8'), 'logout fixture', 'logout cleanup is owner-scoped');
    assert.equal((await fetch(`${url}/api/session/end`, { method: 'POST', headers: headersA })).status, 204);
    assert.equal((await fetch(`${url}/api/audio/${filename}`, { headers: headersA })).status, 404);

    for (const abort of [true, false]) {
      const finishSession = retainUploadSession(userA);
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/${filename}`, 'in-flight upload fixture');
      finishSession();
      const receiving = new Promise<void>((resolve) => {
        server.once('request', (incoming) => incoming.once('data', () => resolve()));
      });
      const upload = request(`${url}/api/audio?name=invalid.exe`, {
        method: 'POST',
        headers: { ...headersA, 'Content-Type': 'application/octet-stream', 'Content-Length': '100' },
      });
      upload.on('error', (error: NodeJS.ErrnoException) => assert.equal(error.code, 'ECONNRESET'));
      try {
        upload.write('partial');
        await receiving;
        assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersA })).status, 409);
        assert.equal((await fetch(`${url}/api/session/end`, { method: 'POST', headers: headersA })).status, 204);
        assert.equal(await fs.readFile(`${directory}/${filename}`, 'utf8'), 'in-flight upload fixture',
          'logout preserves uploads while the request body is still arriving');
        if (abort) {
          upload.destroy();
        } else {
          const response = once(upload, 'response');
          upload.end('x'.repeat(93));
          const [reply] = await response;
          assert.equal(reply.statusCode, 400);
          reply.resume();
        }
        const deadline = Date.now() + 1000;
        while (await fs.stat(directory).catch(() => undefined)) {
          assert.ok(Date.now() < deadline, 'logout deletes uploads after the request ends or aborts');
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersA })).status, 200,
          'body failures release the request lock for the next action');
      } finally {
        upload.destroy();
      }
    }

    const finishClosingSession = retainUploadSession(userA);
    await mkdir(directory, { recursive: true });
    finishClosingSession();
    let cleanupStarted!: () => void;
    let finishCleanup!: () => void;
    const startedCleanup = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const pendingCleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
    const originalRmdir = fs.rmdir;
    const pausedCleanup = t.mock.method(fs, 'rmdir', async (...args: Parameters<typeof fs.rmdir>) => {
      if (String(args[0]) === directory) {
        cleanupStarted();
        await pendingCleanup;
      }
      return originalRmdir(...args);
    });
    syncBuiltinESMExports();
    const endingSession = fetch(`${url}/api/session/end`, { method: 'POST', headers: headersA });
    try {
      await startedCleanup;
      for (let attempt = 0; attempt < 3; attempt++) {
        const rejected = await fetch(`${url}/api/audio?name=track.wav`, { method: 'POST',
          headers: { ...headersA, 'Content-Type': 'application/octet-stream' }, body: 'audio' });
        assert.equal(rejected.status, 400, 'session cleanup failures release the server-wide upload slot');
      }
    } finally {
      finishCleanup();
      await endingSession;
      pausedCleanup.mock.restore();
      syncBuiltinESMExports();
    }

    const releases = [startAudioUpload(), startAudioUpload()];
    assert.throws(startAudioUpload, /audio uploads are busy/);
    const busy = await fetch(`${url}/api/audio?name=track.wav`, { method: 'POST',
      headers: { ...headersA, 'Content-Type': 'application/octet-stream' }, body: 'audio' });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '5');
    assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersA })).status, 200,
      'a rejected upload releases the request lock');
    for (const release of releases) release();
    for (const release of releases) release();
    startAudioUpload()();
    startAudioUpload()();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await resetAgentSession(userA);
    await resetAgentSession(userB);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    quotas.restore();
    await rm(directory, { recursive: true, force: true });
  }
});
