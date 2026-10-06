import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { Client } from 'langsmith';
import { getOrCreateAgent, resetAgentSession } from '../src/agent.js';
import { analyzeAudio } from '../src/analysis.js';
import { audioDirectory } from '../src/audio.js';
import { getAiGateway } from '../src/gateway.js';
import { generateLyrics } from '../src/lyrics.js';
import { getModelConfig } from '../src/model.js';
import { generateMusic, musicDirectory } from '../src/music.js';
import { configureTestSongStorage } from './song-fixture.js';

test('BYOK routes chat, lyrics, token counting, music, and analysis without provider credentials', async () => {
  const originalFetch = globalThis.fetch;
  const storage = configureTestSongStorage();
  const originalCreateRun = Client.prototype.createRun;
  const originalUpdateRun = Client.prototype.updateRun;
  Client.prototype.createRun = async () => {};
  Client.prototype.updateRun = async () => {};
  const variables = [
    'CF_AI_GATEWAY_ACCOUNT_ID', 'CF_AI_GATEWAY_ID', 'CF_AI_GATEWAY_TOKEN',
    'CF_AI_GATEWAY_NEBIUS_SLUG', 'CF_AI_GATEWAY_QWENCLOUD_SLUG',
    'NEBIUS_MODEL', 'LYRICS_MODEL', 'LANGSMITH_TRACING',
  ];
  const originalEnv = new Map(variables.map((name) => [name, process.env[name]]));
  const root = 'https://gateway.ai.cloudflare.com/v1/offline-account/offline-gateway';
  const calls: string[] = [];
  const session = randomUUID();
  const audioName = `${randomUUID()}.mp3`;
  const audioPath = `${audioDirectory}${session}/${audioName}`;
  const bytes = Buffer.from('ID3-offline-gateway-fixture');
  let musicPath: string | undefined;
  let fail = false;

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const database = await storage.databaseResponse(request);
    if (database) return database;
    calls.push(request.url);
    assert.equal(request.headers.get('cf-aig-authorization'), 'Bearer offline-gateway-token');
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(request.headers.has('x-goog-api-key'), false);
    assert.equal(request.headers.get('cf-aig-skip-cache'), 'true');
    assert.equal(request.headers.get('cf-aig-max-attempts'), '1');
    assert.equal(request.headers.get('cf-aig-no-wholesale'), 'true');
    assert.equal(request.method, 'POST');
    const body = JSON.parse(await request.text());
    const expectedCosts: Record<string, { per_token_in: number; per_token_out: number }> = {
      'nvidia/nemotron-3-super-120b-a12b': { per_token_in: 0.00000030, per_token_out: 0.00000090 },
      'zai-org/GLM-5.3-Flash': { per_token_in: 0.00000015, per_token_out: 0.00000050 },
      'qwen3.8-omni-flash': { per_token_in: 0.00000015, per_token_out: 0.00000047 },
    };
    const cost = request.headers.get('cf-aig-custom-cost');
    if (expectedCosts[body.model]) {
      assert.deepEqual(JSON.parse(cost ?? 'null'), expectedCosts[body.model]);
      assert.equal(body.stream_options.include_usage, true);
    } else {
      assert.equal(cost, null);
    }
    if (fail) return Response.json({ error: { message: 'offline gateway failure' } }, { status: 429 });

    if (request.url === `${root}/google-ai-studio/v1beta/models/lyria-3.5:countTokens`) {
      assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'instrumental folk' }] }]);
      return Response.json({ totalTokens: 10 });
    }
    if (request.url === `${root}/google-ai-studio/v1beta/interactions`) {
      assert.deepEqual(body, { model: 'lyria-3.5', input: 'instrumental folk', store: false });
      return Response.json({ status: 'completed', steps: [{ type: 'model_output', content: [
        { type: 'audio', mime_type: 'audio/mpeg', data: bytes.toString('base64') },
      ] }] });
    }
    assert.ok(request.url === `${root}/custom-my-nebius/v1/chat/completions` ||
      request.url === `${root}/custom-my-qwen/compatible-mode/v1/chat/completions`);
    assert.equal(body.stream, true);
    if (body.model === 'qwen3.8-omni-flash') {
      assert.equal(request.url, `${root}/custom-my-qwen/compatible-mode/v1/chat/completions`);
      assert.equal(body.messages[0].content[1].input_audio.data, `data:;base64,${bytes.toString('base64')}`);
    }
    const base = { id: randomUUID(), object: 'chat.completion.chunk', created: 0, model: body.model };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'offline answer' }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    for (const name of variables) delete process.env[name];
    assert.throws(() => getAiGateway('nebius'), /set CF_AI_GATEWAY_ACCOUNT_ID/);
    await assert.rejects(generateMusic('instrumental folk', undefined, session), /set CF_AI_GATEWAY_ACCOUNT_ID/);
    await assert.rejects(analyzeAudio(`/api/audio/${audioName}`, 'describe this', session), /set CF_AI_GATEWAY_ACCOUNT_ID/);
    await assert.rejects(generateLyrics({ genre: 'folk' }, 'write a verse'), /set CF_AI_GATEWAY_ACCOUNT_ID/);
    assert.throws(() => getOrCreateAgent(session), /set CF_AI_GATEWAY_ACCOUNT_ID/);
    assert.equal(calls.length, 0);
    process.env.CF_AI_GATEWAY_ACCOUNT_ID = 'offline-account';
    assert.throws(() => getAiGateway('nebius'), /set CF_AI_GATEWAY_ACCOUNT_ID/);
    process.env.CF_AI_GATEWAY_ID = 'offline-gateway';
    process.env.CF_AI_GATEWAY_TOKEN = 'offline-gateway-token';
    process.env.CF_AI_GATEWAY_NEBIUS_SLUG = 'my-nebius';
    process.env.CF_AI_GATEWAY_QWENCLOUD_SLUG = 'my-qwen';
    process.env.LANGSMITH_TRACING = 'false';

    const config = getModelConfig();
    assert.equal(config.baseURL, `${root}/custom-my-nebius/v1`);
    assert.equal(JSON.stringify(config).includes('offline-gateway-token'), false);
    assert.equal((await getOrCreateAgent(session).invoke('hello')).toString(), 'offline answer');
    assert.equal(await generateLyrics({ genre: 'folk' }, 'write a verse'), 'offline answer');

    const track = await generateMusic('instrumental folk', undefined, session);
    musicPath = `${musicDirectory}${session}/${track.url.split('/').at(-1)}`;
    assert.deepEqual(storage.objects.get(`users/${session}/${track.url.split('/').at(-1)}`), bytes);
    await assert.rejects(readFile(musicPath), /ENOENT/);
    musicPath = undefined;
    await mkdir(`${audioDirectory}${session}`, { recursive: true });
    await writeFile(audioPath, bytes);
    assert.equal(await analyzeAudio(`/api/audio/${audioName}`, 'describe this', session), 'offline answer');
    assert.equal(calls.length, 5);

    fail = true;
    await assert.rejects(generateMusic('instrumental folk', undefined, session), /token counting failed/);
    assert.equal(calls.length, 6);
    await assert.rejects(analyzeAudio(`/api/audio/${audioName}`, 'describe this', session), /offline gateway failure/);
    assert.equal(calls.length, 7);

    fail = false;
    const unknownModel = getAiGateway('nebius', 'unpriced-model');
    assert.ok(unknownModel);
    await unknownModel.fetch(`${unknownModel.baseURL}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'unpriced-model', stream: true }),
    });
  } finally {
    resetAgentSession(session);
    globalThis.fetch = originalFetch;
    storage.restore();
    Client.prototype.createRun = originalCreateRun;
    Client.prototype.updateRun = originalUpdateRun;
    for (const [name, value] of originalEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (musicPath) await unlink(musicPath);
    await unlink(audioPath).catch((error: unknown) => {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    });
  }
});
