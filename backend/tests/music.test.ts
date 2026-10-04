import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import test from 'node:test';
import type { ToolContext } from '@strands-agents/sdk';
import { generateMusic, updateMusicFormTool, musicDirectory, MusicPromptTokenLimitError } from '../src/music.js';
import { configureTestGateway, testGatewayURL } from './gateway-environment.js';

test('music waits for confirmation, validates responses, and saves only valid audio', async () => {
  const prompt = 'Indie folk, warm acoustic guitar and soft brushed drums, relaxed at 82 BPM in G major. ' +
    'A 2-minute song with intimate alto vocals in English. Build into a bright chorus, then end softly.\n' +
    '[Intro] -> [Verse 1] -> [Chorus] -> [Outro]\n\n' +
    'Lyrics:\n[Verse 1]\nTiny paws in the morning dew,\nA world of green and a sky of blue.\n\n' +
    '[Chorus]\nStay with me (stay with me)';
  const originalFetch = globalThis.fetch;
  const originalTracing = process.env.LANGSMITH_TRACING;
  const fields = {
    genre: 'Indie folk', mood: 'warm and relaxed', key: 'G major', bpm: '82', duration: '2 minutes',
    instruments: 'warm acoustic guitar and soft brushed drums', vocals: 'intimate alto vocals in English',
    production: 'natural acoustic sound',
    lyrics: '[Verse 1]\nTiny paws in the morning dew,\nA world of green and a sky of blue.\n\n[Chorus]\nStay with me (stay with me)',
  };
  const restoreGateway = configureTestGateway();
  let calls = 0;
  let tokenCalls = 0;
  let expectedModel = 'lyria-3.5';
  let tokenResponse = async () => Response.json({ totalTokens: 100 });
  let response = new Response();
  globalThis.fetch = async (url, options) => {
    const request = new Request(url, options);
    assert.equal(request.method, 'POST');
    const headers = request.headers;
    assert.equal(headers.get('content-type'), 'application/json');
    assert.equal(headers.has('x-goog-api-key'), false);
    assert.equal(headers.get('cf-aig-authorization'), 'Bearer offline-gateway-token');
    if (request.url === `${testGatewayURL}/google-ai-studio/v1beta/models/${expectedModel}:countTokens`) {
      tokenCalls++;
      assert.deepEqual(JSON.parse(await request.text()), {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
      return tokenResponse();
    }
    calls++;
    assert.equal(request.url, `${testGatewayURL}/google-ai-studio/v1beta/interactions`);
    assert.deepEqual(JSON.parse(await request.text()), {
      model: expectedModel, input: prompt, store: false,
    });
    return response;
  };
  let savedPath: string | undefined;

  try {
    process.env.LANGSMITH_TRACING = 'false';
    const invocationState: Record<string, unknown> = {};
    const context = { invocationState } as ToolContext;
    const maximumLyrics = { ...fields, lyrics: 'a'.repeat(3_000) };
    assert.deepEqual(await updateMusicFormTool.invoke(maximumLyrics, context), {
      status: 'awaiting_confirmation', prompt: maximumLyrics,
    });
    assert.deepEqual(await updateMusicFormTool.invoke(fields, context), {
      status: 'awaiting_confirmation', prompt: fields,
    });
    assert.deepEqual(invocationState.musicPrompt, fields);
    assert.equal(calls, 0);
    assert.equal(tokenCalls, 0);
    await assert.rejects(updateMusicFormTool.invoke({ ...fields, bpm: 82 }, context), /music prompt field bpm/);
    for (const lyricRequest of [null, 0, false, {}, 'a'.repeat(10_001)]) {
      await assert.rejects(updateMusicFormTool.invoke({ ...fields, lyricRequest }, context), /music prompt/);
    }
    await assert.rejects(updateMusicFormTool.invoke({ ...fields, lyrics: 'a'.repeat(3_001) }, context), /3,000/);
    await assert.rejects(updateMusicFormTool.invoke(Object.fromEntries(Object.keys(fields).map((key) => [key, ''])), context), /music prompt/);
    assert.deepEqual(invocationState.musicPrompt, fields);
    assert.equal(calls, 0);
    await assert.rejects(generateMusic(' '.repeat(2)), /music prompt/);
    await assert.rejects(generateMusic('a'.repeat(10_001)), /music prompt/);
    for (const model of ['unsupported-model', '', null, 35]) {
      await assert.rejects(generateMusic(prompt, model), /choose Lyria/);
    }
    assert.equal(tokenCalls, 0);
    delete process.env.CF_AI_GATEWAY_TOKEN;
    await assert.rejects(generateMusic(prompt), /set CF_AI_GATEWAY_ACCOUNT_ID/);
    assert.equal(calls, 0);
    assert.equal(tokenCalls, 0);
    process.env.CF_AI_GATEWAY_TOKEN = 'offline-gateway-token';

    tokenResponse = async () => Response.json({ totalTokens: 131_073 });
    await assert.rejects(generateMusic(prompt), (error: unknown) => {
      assert.ok(error instanceof MusicPromptTokenLimitError, String(error));
      assert.match(error.message, /131,073.*131,072/);
      return true;
    });
    assert.equal(tokenCalls, 1);
    assert.equal(calls, 0);

    tokenResponse = async () => new Response('{}', { status: 429 });
    await assert.rejects(generateMusic(prompt), /token counting failed.*429/);
    tokenResponse = async () => new Response('invalid JSON');
    await assert.rejects(generateMusic(prompt), /token counting failed/);
    for (const totalTokens of [undefined, null, '100', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      tokenResponse = async () => Response.json({ totalTokens });
      await assert.rejects(generateMusic(prompt), /invalid count/);
    }
    tokenResponse = async () => { throw new TypeError('offline'); };
    await assert.rejects(generateMusic(prompt), /generation was not started.*offline/);
    tokenResponse = async () => { throw new DOMException('timeout', 'TimeoutError'); };
    await assert.rejects(generateMusic(prompt), /generation was not started.*timeout/);
    assert.equal(calls, 0);
    tokenResponse = async () => Response.json({ totalTokens: 100 });

    response = Response.json({ error: { code: 400, message: 'Prompt rejected by music service.', status: 'INVALID_ARGUMENT' } }, { status: 400 });
    const previousErrorCalls = calls;
    await assert.rejects(generateMusic(prompt), /music generation failed.*Prompt rejected by music service/);
    assert.equal(calls, previousErrorCalls + 1);
    response = Response.json({ status: 'failed', steps: [] });
    await assert.rejects(generateMusic(prompt), /completed track/);
    response = Response.json({ status: 'completed', steps: [] });
    await assert.rejects(generateMusic(prompt), /no audio/);
    for (const data of ['invalid!', 'AAAAA', 'A===', 'AA=A', 'AA==AAAA']) {
      response = Response.json({ status: 'completed', steps: [{
        type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/mpeg', data }],
      }] });
      await assert.rejects(generateMusic(prompt), /invalid MP3/);
    }

    const bytes = Buffer.concat([Buffer.from('ID3-offline-audio-fixture'), Buffer.alloc(4 * 1024 * 1024)]);
    response = Response.json({ status: 'completed', steps: [
      { type: 'thought', content: [{ type: 'text', text: 'ignore this' }] },
      { type: 'model_output', content: [{ type: 'text', text: '[[A0]]\n[[B1]]\n[:] Tiny paws in the morning dew,\n[:] A world of green and a sky of blue.\n[[C2]]' }] },
      { type: 'model_output', content: [
        { type: 'text', text: 'chorus' },
        { type: 'audio', mime_type: 'audio/mpeg', data: bytes.toString('base64') },
      ] },
    ] });
    tokenResponse = async () => Response.json({ totalTokens: 131_072 });
    const completedResponse = response;
    for (const model of [undefined, 'lyria-3-clip-preview']) {
      expectedModel = model ?? 'lyria-3.5';
      response = completedResponse.clone();
      const previousTokenCalls = tokenCalls;
      const previousCalls = calls;
      const track = await generateMusic(`  ${prompt}  `, model);
      assert.equal(tokenCalls, previousTokenCalls + 1);
      assert.equal(calls, previousCalls + 1);
      assert.match(track.url, /^\/api\/music\/[0-9a-f-]{36}\.mp3$/);
      savedPath = `${musicDirectory}${track.url.split('/').at(-1)}`;
      assert.deepEqual(await readFile(savedPath), bytes);
      assert.equal(track.lyrics, 'Tiny paws in the morning dew,\nA world of green and a sky of blue.\n\nchorus');
      await unlink(savedPath);
      savedPath = undefined;
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = originalTracing;
    restoreGateway();
    if (savedPath) await unlink(savedPath);
  }
});
