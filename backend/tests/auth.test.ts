import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { request } from 'node:http';
import test, { type TestContext } from 'node:test';
import { startTestServer } from './http-fixture.js';
import { isRecord } from '../src/validation.js';
import { userDirectory } from '../src/user-files.js';
import { TERMS_VERSION } from '../src/terms.js';
import { configureTestQuotas } from './quota-fixture.js';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

test('verified users own their API session and local media', async (t) => {
  const fixture = await createAuthFixture(t);
  try {
    await assertPublicAuth(fixture);
    await assertTermsOwnership(fixture);
    await assertConversationOwnership(fixture);
    await assertUploadOwnership(fixture);
    await assertReceivingUpload(fixture);
    await assertClosingUploadSlots(fixture);
  } finally {
    await fixture.cleanup();
  }
});

async function createAuthFixture(t: TestContext) {
  process.env.NODE_ENV = 'test';
  process.env.LANGSMITH_TRACING = 'false';
  process.env.MAX_AUDIO_JOBS = '2';
  process.env.SUPABASE_URL = 'https://offline-auth.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_offline';
  const quotas = configureTestQuotas();
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'offline', alg: 'ES256', use: 'sig' };
  const originalFetch = globalThis.fetch;
  const auth = configureAuthTransport(quotas, jwk);
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
  const { server, url } = await startTestServer(app);

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

  return { t, url, userA, userB, headersA, headersB, filename, directory, server, auth, quotas, token, getOrCreateAgent, getChatContext, retainUploadSession, audioPath, prepareAnalysisAudio, startAudioUpload,
    cleanup: async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await resetAgentSession(userA);
      await resetAgentSession(userB);
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      globalThis.fetch = originalFetch;
      quotas.restore();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

type AuthFixture = Awaited<ReturnType<typeof createAuthFixture>>;

async function assertPublicAuth(fixture: AuthFixture): Promise<void> {
  const { url, userA, headersA, filename, auth, token } = fixture;
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { status: 'ok' });
  const plans = await fetch(`${url}/api/plans`);
  assert.equal(plans.status, 200, 'pricing allowances are public');
  assert.equal(plans.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await plans.json(), []);
  auth.plansUnavailable = true;
  assert.equal((await fetch(`${url}/api/plans`)).status, 503, 'database failures never substitute fake allowances');
  auth.plansUnavailable = false;
  const allowed = await fetch(`${url}/api/health`, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  const foreign = await fetch(`${url}/api/health`, { headers: { Origin: 'https://example.com' } });
  assert.equal(foreign.headers.get('access-control-allow-origin'), null);
  for (const endpoint of ['terms', 'context', 'usage', 'chat', 'music', 'reset', 'session/end', 'audio', `audio/${filename}`]) {
    assert.equal((await fetch(`${url}/api/${endpoint}`)).status, 401);
  }
  assert.equal(auth.requests, 0);
  const missingEndpoint = await fetch(`${url}/api/unknown`, { headers: headersA });
  assert.equal(missingEndpoint.status, 404);
  assert.deepEqual(await missingEndpoint.json(), { error: 'endpoint not found.' });
  const valid = token(userA);
  for (const invalid of ['malformed', token(userA, { exp: 1 }), token(userA, { iss: 'https://another-project.supabase.co/auth/v1' }),
    token(userA, { aud: 'wrong' }), token(userA, { role: 'service_role' }), token(userA, { sub: '../../secrets' }),
    token(userA, { is_anonymous: true }), `${valid.slice(0, -8)}AAAAAAAA`]) {
    assert.equal((await fetch(`${url}/api/context`, { headers: { Authorization: `Bearer ${invalid}` } })).status, 401);
  }

}

async function assertTermsOwnership(fixture: AuthFixture): Promise<void> {
  const { url, userA, userB, headersA, headersB, auth, quotas } = fixture;
  assert.equal((await fetch(`${url}/api/terms`, { method: 'POST' })).status, 401);
  auth.acceptances.set(userA, new Set(['2026-10-12']));
  assert.deepEqual(await (await fetch(`${url}/api/terms`, { headers: headersA })).json(), { accepted: false, version: TERMS_VERSION });
  for (const endpoint of ['chat', 'music']) {
    const denied = await fetch(`${url}/api/${endpoint}`, { method: 'POST', headers: { ...headersA, Accept: 'application/x-ndjson' },
      body: JSON.stringify({ message: 'denied', operationId: randomUUID() }),
    });
    assert.equal(denied.status, 403, 'the previous terms version cannot authorize AI work');
    assert.equal((await denied.json()).code, 'terms_required');
    assert.equal(quotas.reservations.size, 0, 'deny before reserving paid usage');
  }
  for (const version of [undefined, '2026-10-12', 'old-version']) {
    assert.equal((await fetch(`${url}/api/terms`, { method: 'POST', headers: headersA,
      body: JSON.stringify({ version }),
    })).status, 400);
  }
  assert.deepEqual([...auth.acceptances.get(userA)!], ['2026-10-12'], 'invalid versions do not record acceptance');
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await fetch(`${url}/api/terms`, { method: 'POST', headers: headersA,
      body: JSON.stringify({ version: TERMS_VERSION, user_id: userB }),
    })).status, 204, 'recording acceptance is idempotent');
  }
  assert.deepEqual([...auth.acceptances.keys()], [userA], 'the verified user owns acceptance, regardless of the request body');
  assert.ok(auth.acceptances.get(userA)?.has(TERMS_VERSION));
  const terms = await fetch(`${url}/api/terms?user_id=${userB}`, { headers: headersA });
  assert.equal(terms.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await terms.json(), { accepted: true, version: TERMS_VERSION });
  assert.deepEqual(await (await fetch(`${url}/api/terms`, { headers: headersB })).json(), { accepted: false, version: TERMS_VERSION });
  auth.termsUnavailable = true;
  assert.equal((await fetch(`${url}/api/terms`, { headers: headersA })).status, 503);
  assert.equal((await fetch(`${url}/api/terms`, { method: 'POST', headers: headersB,
    body: JSON.stringify({ version: TERMS_VERSION }),
  })).status, 503);
  for (const endpoint of ['chat', 'music']) {
    assert.equal((await fetch(`${url}/api/${endpoint}`, { method: 'POST', headers: headersA,
      body: JSON.stringify({ message: 'denied' }),
    })).status, 503, 'a failed acceptance check cannot authorize AI work');
    assert.equal(quotas.reservations.size, 0);
  }
  auth.termsUnavailable = false;

}

async function assertConversationOwnership(fixture: AuthFixture): Promise<void> {
  const { t, url, userA, userB, headersA, headersB, filename, directory, getOrCreateAgent, getChatContext } = fixture;
  const agentA = getOrCreateAgent(userA);
  const agentB = getOrCreateAgent(userB);
  assert.notEqual(agentA, agentB);
  agentA.messages.push({ role: 'user', content: [{ type: 'textBlock', text: 'private message' }] });
  assert.deepEqual(await (await fetch(`${url}/api/context`, { headers: headersA })).json(), { messages: 1, limit: 16 });
  assert.deepEqual(await (await fetch(`${url}/api/context`, { headers: headersB })).json(), { messages: 0, limit: 16 });
  const ownFile = await fetch(`${url}/api/audio/${filename}`, { headers: headersA });
  assert.equal(ownFile.status, 200);
  assert.equal(await ownFile.text(), 'private fixture');
  assert.equal(ownFile.headers.get('cache-control'), 'private, max-age=3600');
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
  await assertChatQuotas(fixture);
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

}

async function assertUploadOwnership(fixture: AuthFixture): Promise<void> {
  const { url, userA, userB, headersA, headersB, filename, directory, retainUploadSession, audioPath, prepareAnalysisAudio } = fixture;
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

}

async function assertReceivingUpload(fixture: AuthFixture): Promise<void> {
  const { url, userA, headersA, filename, directory, server, retainUploadSession } = fixture;
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

}

async function assertClosingUploadSlots(fixture: AuthFixture): Promise<void> {
  const { t, url, userA, headersA, directory, retainUploadSession, startAudioUpload } = fixture;
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
}

function configureAuthTransport(quotas: ReturnType<typeof configureTestQuotas>, jwk: object): AuthTransportState {
  const originalFetch = globalThis.fetch;
  const auth = { requests: 0, acceptances: new Map<string, Set<string>>(), termsUnavailable: false, plansUnavailable: false };
  globalThis.fetch = async (input, options) => {
    const request = new Request(input, options);
    const database = await quotas.databaseResponse(request.clone());
    if (database) return database;
    const requestUrl = new URL(request.url);
    if (requestUrl.origin === process.env.SUPABASE_URL && requestUrl.pathname === '/rest/v1/rpc/get_plan_limits') {
      assert.equal(request.headers.get('apikey'), 'sb_secret_offline');
      return auth.plansUnavailable ? Response.json({ message: 'offline plans failure' }, { status: 503 }) : Response.json([]);
    }
    if (requestUrl.origin === process.env.SUPABASE_URL && requestUrl.pathname === '/rest/v1/terms_acceptances') {
      return testTermsResponse(request, requestUrl, auth);
    }
    if (request.url.startsWith(process.env.SUPABASE_URL!)) {
      auth.requests++;
      assert.equal(request.url, `${process.env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
      return Response.json({ keys: [jwk] });
    }
    assert.ok(request.url.startsWith('http://127.0.0.1:'), 'no provider calls are permitted');
    return originalFetch(input, options);
  };
  return auth;
}

interface AuthTransportState {
  requests: number;
  acceptances: Map<string, Set<string>>;
  termsUnavailable: boolean;
  plansUnavailable: boolean;
}

function recordTestTerms(acceptance: unknown, auth: AuthTransportState): Response {
  assert.ok(isRecord(acceptance));
  assert.ok(typeof acceptance.user_id === 'string');
  assert.equal(acceptance.version, TERMS_VERSION);
  const versions = auth.acceptances.get(acceptance.user_id) ?? new Set<string>();
  if (versions.has(TERMS_VERSION)) return Response.json({ code: '23505' }, { status: 409 });
  versions.add(TERMS_VERSION);
  auth.acceptances.set(acceptance.user_id, versions);
  return new Response(null, { status: 201 });
}

async function assertChatQuotas(fixture: AuthFixture): Promise<void> {
  const { quotas, url, headersA, userB } = fixture;
  for (const failure of ['quota', 'global', 'unavailable', 'invalid'] as const) {
    const exhausted = failure === 'quota' || failure === 'global';
    quotas.failures.resource = exhausted ? 'chat' : undefined;
    quotas.failures.scope = failure === 'global' ? 'global' : undefined;
    quotas.failures.unavailable = failure === 'unavailable';
    quotas.failures.invalid = failure === 'invalid';
    const denied = await fetch(`${url}/api/chat`, { method: 'POST', headers: { ...headersA, Accept: 'application/x-ndjson' },
      body: JSON.stringify({ message: 'denied', userId: userB }),
    });
    await assertQuotaResponse(denied, failure);
    assert.equal(quotas.reservations.size, 0, 'no model invocation or reservation on quota failure');
  }
  quotas.failures.resource = undefined;
  quotas.failures.unavailable = false;
  quotas.failures.invalid = false;
}

async function testTermsResponse(request: Request, requestUrl: URL, auth: AuthTransportState): Promise<Response> {
  if (auth.termsUnavailable) return Response.json({ message: 'offline terms failure' }, { status: 503 });
  if (request.method === 'POST') return recordTestTerms(await request.json(), auth);
  assert.equal(requestUrl.searchParams.get('version'), `eq.${TERMS_VERSION}`);
  const userId = requestUrl.searchParams.get('user_id')?.replace(/^eq\./, '') ?? '';
  return Response.json(auth.acceptances.get(userId)?.has(TERMS_VERSION) ? [{ version: TERMS_VERSION }] : []);
}

async function assertQuotaResponse(denied: Response, failure: string): Promise<void> {
  const exhausted = failure === 'quota' || failure === 'global';
  assert.equal(denied.status, exhausted ? 429 : 503);
  assert.equal(denied.headers.get('content-type')?.includes('application/json'), true, 'deny before streaming headers');
  const body = await denied.json();
  assert.equal(body.code, exhausted ? 'quota_exceeded' : 'quota_unavailable');
  if (failure === 'global') assert.match(body.error, /app-wide daily chat allowance exhausted/);
  if (exhausted) {
    assert.equal(body.resource, 'chat');
    assert.ok(denied.headers.get('retry-after'));
  }
}
