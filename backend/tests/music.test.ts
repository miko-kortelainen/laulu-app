import assert from 'node:assert/strict';
import { readFile, unlink } from 'node:fs/promises';
import test from 'node:test';
import type { ToolContext } from '@strands-agents/sdk';
import { generateMusic, generateMusicTool, musicDirectory } from '../src/music.js';

test('music waits for confirmation, validates responses, and saves only valid audio', async () => {
  const prompt = 'Indie folk, warm acoustic guitar and soft brushed drums, relaxed at 82 BPM in G major. ' +
    'A 2-minute song with intimate alto vocals in English. Build into a bright chorus, then end softly.\n' +
    '[Intro] -> [Verse 1] -> [Chorus] -> [Outro]\n\n' +
    'Lyrics:\n[Verse 1]\nTiny paws in the morning dew,\nA world of green and a sky of blue.\n\n' +
    '[Chorus]\nStay with me (stay with me)';
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GEMINI_API_KEY;
  let calls = 0;
  let response = new Response();
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.deepEqual(JSON.parse(String(options?.body)), {
      model: 'lyria-3.5', input: prompt, store: false,
    });
    return response;
  };
  let savedPath: string | undefined;

  try {
    process.env.GEMINI_API_KEY = 'offline-test-key';
    const invocationState: Record<string, unknown> = {};
    const context = { invocationState } as ToolContext;
    assert.deepEqual(await generateMusicTool.invoke({ prompt }, context), {
      status: 'awaiting_confirmation', prompt,
    });
    assert.equal(invocationState.musicPrompt, prompt);
    assert.equal(calls, 0);
    await assert.rejects(generateMusicTool.invoke({ prompt: '' }, context), /music prompt/);
    await assert.rejects(generateMusic(' '.repeat(2)), /music prompt/);
    await assert.rejects(generateMusic('a'.repeat(10_001)), /music prompt/);
    delete process.env.GEMINI_API_KEY;
    await assert.rejects(generateMusic(prompt), /GEMINI_API_KEY/);
    assert.equal(calls, 0);
    process.env.GEMINI_API_KEY = 'offline-test-key';

    response = new Response('{}', { status: 429 });
    await assert.rejects(generateMusic(prompt), /HTTP 429/);
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
    const track = await generateMusic(invocationState.musicPrompt as string);
    assert.match(track.url, /^\/api\/music\/[0-9a-f-]{36}\.mp3$/);
    savedPath = `${musicDirectory}${track.url.split('/').at(-1)}`;
    assert.deepEqual(await readFile(savedPath), bytes);
    assert.equal(track.lyrics, 'Tiny paws in the morning dew,\nA world of green and a sky of blue.\n\nchorus');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
    if (savedPath) await unlink(savedPath);
  }
});
