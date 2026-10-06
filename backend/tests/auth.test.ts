import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { userDirectory } from '../src/user-files.js';

test('verified users own their API session and local media', async () => {
  process.env.NODE_ENV = 'test';
  process.env.LANGSMITH_TRACING = 'false';
  process.env.SUPABASE_URL = 'https://offline-auth.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_offline';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'offline', alg: 'ES256', use: 'sig' };
  const originalFetch = globalThis.fetch;
  let authRequests = 0;
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    if (request.url.startsWith(process.env.SUPABASE_URL!)) {
      authRequests++;
      assert.equal(request.url, `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
      return Response.json({ keys: [jwk] });
    }
    assert.ok(request.url.startsWith('http://127.0.0.1:'), 'no provider calls are permitted');
    return originalFetch(input, options);
  };
  const { app } = await import('../src/index.js');
  const { getOrCreateAgent, getChatContext, resetAgentSession } = await import('../src/agent.js');
  const { audioDirectory, audioPath, prepareAnalysisAudio } = await import('../src/audio.js');
  const userA = randomUUID();
  const userB = randomUUID();
  const filename = `${randomUUID()}.wav`;
  const directory = userDirectory(audioDirectory, userA);
  await mkdir(directory, { recursive: true });
  await writeFile(`${directory}/${filename}`, Buffer.from('private fixture'));
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
    for (const endpoint of ['context', 'chat', 'music', 'reset', 'audio', `audio/${filename}`, 'stems/fixture', 'cleaned/fixture']) {
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
    const pendingChat = fetch(`${url}/api/chat`, { method: 'POST', headers: headersA, body: JSON.stringify({ message: 'pending' }) });
    await started;
    assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersA })).status, 409);
    assert.equal((await fetch(`${url}/api/songs/${randomUUID()}`, { method: 'DELETE', headers: headersA })).status, 409);
    assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersB })).status, 200);
    cancel(new Error('offline request cancellation'));
    assert.equal((await pendingChat).status, 500);
    assert.equal((await fetch(`${url}/api/reset`, { method: 'POST', headers: headersA })).status, 200);

    const ownFile = await fetch(`${url}/api/audio/${filename}`, { headers: headersA });
    assert.equal(ownFile.status, 200);
    assert.equal(await ownFile.text(), 'private fixture');
    assert.equal(ownFile.headers.get('cache-control'), 'private, no-store');
    assert.equal((await fetch(`${url}/api/audio/${filename}`, { headers: headersB })).status, 404);
    assert.notEqual(audioPath(`/api/audio/${filename}`, userA), audioPath(`/api/audio/${filename}`, userB));
    await assert.rejects(prepareAnalysisAudio(`/api/audio/${filename}`, userB), /no longer exists/);
    assert.throws(() => audioPath(`/api/audio/${filename}`, '../../secrets'), /valid audio owner/);
    assert.throws(() => audioPath('/api/audio/../../.env', userA), /choose a generated track/);
  } finally {
    resetAgentSession(userA);
    resetAgentSession(userB);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});
