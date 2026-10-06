import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import type { ToolContext } from '@strands-agents/sdk';
import { Client } from 'langsmith';
import { analyzeAudio as analyzeUserAudio, analyzeAudioTool } from '../src/analysis.js';
import { audioDirectory, prepareAnalysisAudio as prepareUserAnalysisAudio } from '../src/audio.js';
import { getOrCreateAgent, resetAgentSession } from '../src/agent.js';
import { getModelId } from '../src/model.js';
import { configureTestGateway, testGatewayURL } from './gateway-environment.js';
import { configureTestQuotas } from './quota-fixture.js';
import { QuotaError } from '../src/quotas.js';

const userId = '10000000-0000-4000-8000-000000000004';
const analyzeAudio = (url: unknown, question: unknown) => analyzeUserAudio(url, question, userId);
const prepareAnalysisAudio = (url: unknown) => prepareUserAnalysisAudio(url, userId);

const runFile = promisify(execFile);
const python = fileURLToPath(new URL('../audio-processing/.venv/bin/python', import.meta.url));

function wav(): Buffer {
  const data = Buffer.alloc(44 + 16_000 * 2);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16_000, 24);
  data.writeUInt32LE(32_000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  for (let i = 0; i < 16_000; i++) data.writeInt16LE(Math.round(8_000 * Math.sin(i * Math.PI / 20)), 44 + i * 2);
  return data;
}

function completion(model: string, delta: unknown, finishReason = 'stop'): Response {
  const base = { id: randomUUID(), object: 'chat.completion.chunk', created: 0, model };
  const chunks = [
    { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] },
    { ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
  ];
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('Nemotron delegates audio to Qwen, traces without bytes, and recovers from failures', async () => {
  const originalFetch = globalThis.fetch;
  const restoreGateway = configureTestGateway();
  const quotas = configureTestQuotas();
  const previousURL = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'https://offline-analysis.supabase.co';
  const originalTracing = process.env.LANGSMITH_TRACING;
  const originalCreate = Client.prototype.createRun;
  const originalUpdate = Client.prototype.updateRun;
  const runs: Parameters<Client['createRun']>[0][] = [];
  const updates = new Map<string, Parameters<Client['updateRun']>[1]>();
  const filename = `${randomUUID()}.wav`;
  const source = path.join(audioDirectory, userId, filename);
  const audioUrl = `/api/audio/${filename}`;
  const audio = wav();
  const sessionId = userId;
  const question = 'describe the instruments and suggest two changes';
  const observation = 'a repeating tone is audible; instrument identity is uncertain.';
  let mainCalls = 0;
  let qwenCalls = 0;
  let mode: 'success' | 'http' | 'empty' | 'truncated' | 'reasoning' | 'brokenStream' = 'success';
  await mkdir(path.join(audioDirectory, userId), { recursive: true });
  await writeFile(source, audio);
  process.env.LANGSMITH_TRACING = 'true';
  Client.prototype.createRun = async (run) => { runs.push(run); };
  Client.prototype.updateRun = async (id, run) => { updates.set(id, JSON.parse(JSON.stringify(run)) as typeof run); };
  globalThis.fetch = async (url, options) => {
    const httpRequest = new Request(url, options);
    const database = await quotas.databaseResponse(httpRequest.clone());
    if (database) return database;
    const request = await httpRequest.json();
    if (request.model === 'qwen3.8-omni-flash') {
      qwenCalls++;
      assert.equal(httpRequest.url, `${testGatewayURL}/custom-qwencloud/compatible-mode/v1/chat/completions`);
      assert.equal(httpRequest.headers.has('authorization'), false);
      assert.equal(httpRequest.headers.get('cf-aig-authorization'), 'Bearer offline-gateway-token');
      assert.equal(request.stream, true);
      assert.equal(request.stream_options.include_usage, true);
      assert.equal(request.max_tokens, 2048);
      assert.equal(request.reasoning_effort, 'none');
      const input = request.messages[0].content.find((part: { type: string }) => part.type === 'input_audio').input_audio;
      assert.equal(input.format, 'wav');
      assert.deepEqual(Buffer.from(input.data.split(',')[1], 'base64'), audio);
      assert.ok(request.messages[0].content[0].text.includes(question));
      assert.equal(request.tools, undefined);
      if (mode === 'http') return Response.json({ error: { message: 'offline quota exhausted' } }, { status: 429 });
      if (mode === 'brokenStream') return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return completion(request.model, mode === 'reasoning'
        ? { role: 'assistant', reasoning_content: 'thinking only' }
        : { role: 'assistant', content: mode === 'empty' ? '' : observation }, mode === 'truncated' ? 'length' : 'stop');
    }
    assert.equal(request.model, getModelId());
    assert.ok(request.tools.some((entry: { function: { name: string } }) => entry.function.name === 'analyze_audio'));
    mainCalls++;
    if (mainCalls % 2 === 1) {
      return completion(request.model, { role: 'assistant', tool_calls: [{ index: 0, id: `analysis-${mainCalls}`, type: 'function',
        function: { name: 'analyze_audio', arguments: JSON.stringify({ audio_url: audioUrl, question }) } }] }, 'tool_calls');
    }
    if (quotas.failures.resource) {
      assert.ok(JSON.stringify(request.messages).includes('allowance exhausted'));
      return completion(request.model, { role: 'assistant', content: 'audio analysis allowance exhausted.' });
    }
    assert.ok(JSON.stringify(request.messages).includes(observation));
    return completion(request.model, { role: 'assistant', content: observation });
  };
  try {
    const agent = getOrCreateAgent(sessionId);
    const result = await agent.invoke(`analyze this track\n\navailable audio: ${audioUrl}`);
    assert.equal(result.toString(), observation);
    assert.equal(mainCalls, 2);
    assert.equal(qwenCalls, 1);
    const root = runs.find((run) => run.name === 'musical-copilot');
    const tool = runs.find((run) => run.name === 'analyze_audio');
    const model = runs.find((run) => run.name === 'QwenOmni');
    assert.ok(root?.id && tool?.id && model?.id);
    assert.equal(tool.parent_run_id, root.id);
    assert.equal(model.parent_run_id, tool.id);
    assert.equal(model.run_type, 'llm');
    assert.equal(model.extra?.metadata?.thread_id, sessionId);
    assert.equal(updates.get(model.id)?.outputs?.usage_metadata?.total_tokens, 120);
    assert.equal(JSON.stringify(runs).includes(audio.toString('base64')), false);
    assert.equal(JSON.stringify(runs).includes('offline-gateway-token'), false);

    // Bad inputs and absent credentials never reach inference.
    const beforeValidation = qwenCalls;
    await assert.rejects(analyzeAudio('https://example.com/audio.wav', question), /choose a generated track/);
    await assert.rejects(analyzeAudio('/api/audio/../../secrets.wav', question), /choose a generated track/);
    await assert.rejects(analyzeAudio(`/api/audio/${randomUUID()}.wav`, question), /no longer exists/);
    await assert.rejects(analyzeAudio(audioUrl, ' '), /question must contain/);
    delete process.env.CF_AI_GATEWAY_TOKEN;
    await assert.rejects(analyzeAudio(audioUrl, question), /set CF_AI_GATEWAY_ACCOUNT_ID/);
    assert.equal(qwenCalls, beforeValidation);
    process.env.CF_AI_GATEWAY_TOKEN = 'offline-gateway-token';

    quotas.failures.resource = 'analysis';
    const deniedResult = await agent.invoke(`analyze again\n\navailable audio: ${audioUrl}`);
    assert.ok(deniedResult.invocationState.quotaError instanceof QuotaError, 'the agent result preserves the structured quota failure');
    assert.equal(qwenCalls, beforeValidation);
    const deniedState = { userId, quotaError: undefined as unknown };
    await assert.rejects(analyzeAudioTool.invoke({ audio_url: audioUrl, question }, { invocationState: deniedState } as ToolContext), QuotaError);
    assert.ok(deniedState.quotaError instanceof QuotaError, 'tool quota failures propagate to the HTTP stream');
    assert.equal(qwenCalls, beforeValidation, 'denied analysis never reaches Qwen');
    quotas.failures.resource = undefined;
    quotas.failures.unavailable = true;
    await assert.rejects(analyzeAudio(audioUrl, question), /usage database is unavailable/);
    assert.equal(qwenCalls, beforeValidation);
    quotas.failures.unavailable = false;

    // Failures preserve existing feature state and cannot trigger a second Qwen attempt.
    for (mode of ['http', 'empty', 'truncated', 'reasoning', 'brokenStream']) {
      const invocationState = { userId, musicPrompt: { genre: 'folk' }, cleanedAudio: { url: audioUrl, name: 'original' } };
      const beforeFailure = qwenCalls;
      await assert.rejects(analyzeAudioTool.invoke({ audio_url: audioUrl, question }, { invocationState } as ToolContext),
        mode === 'http' ? /offline quota exhausted/ : /complete answer/);
      assert.equal(qwenCalls, beforeFailure + 1);
      assert.deepEqual(invocationState.musicPrompt, { genre: 'folk' });
      assert.deepEqual(invocationState.cleanedAudio, { url: audioUrl, name: 'original' });
      await assert.rejects(analyzeAudioTool.invoke({ audio_url: audioUrl, question }, { invocationState } as ToolContext), /only one audio analysis attempt/);
      assert.equal(qwenCalls, beforeFailure + 1);
    }
    mode = 'success';
    const recovery = await agent.invoke(`analyze again\n\navailable audio: ${audioUrl}`);
    assert.equal(recovery.toString(), observation);
    assert.deepEqual(await readFile(source), audio);
  } finally {
    resetAgentSession(sessionId);
    globalThis.fetch = originalFetch;
    Client.prototype.createRun = originalCreate;
    Client.prototype.updateRun = originalUpdate;
    restoreGateway();
    quotas.restore();
    if (previousURL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousURL;
    if (originalTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = originalTracing;
    await rm(source, { force: true });
  }
});

test('FLAC, OGG, and a full ten-minute WAV fit inline analysis without replacing originals', { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'analysis-test-'));
  const sources: string[] = [];
  await mkdir(path.join(audioDirectory, userId), { recursive: true });
  try {
    for (const format of ['flac', 'ogg', 'wav']) {
      const filename = `${randomUUID()}.${format}`;
      const source = path.join(audioDirectory, userId, filename);
      sources.push(source);
      const duration = format === 'wav' ? 600 : 2;
      await runFile(python, ['-c',
        'import sys,numpy as np,soundfile as sf; rate=32000; duration=int(sys.argv[2]); audio=(0.2*np.sin(2*np.pi*220*np.arange(rate*duration)/rate)).astype("float32"); sf.write(sys.argv[1],audio,rate)',
        source, String(duration)]);
      const before = await stat(source);
      const prepared = await prepareAnalysisAudio(`/api/audio/${filename}`);
      assert.equal(prepared.format, 'mp3');
      assert.ok(prepared.data.length + 13 < 10_000_000);
      const output = path.join(directory, 'prepared.mp3');
      await writeFile(output, Buffer.from(prepared.data, 'base64'));
      const { stdout } = await runFile(python, ['-c',
        'import sys,soundfile as sf; info=sf.info(sys.argv[1]); print(info.duration)', output]);
      assert.ok(Math.abs(Number(stdout.trim()) - duration) < 0.1);
      const after = await stat(source);
      assert.equal(after.size, before.size);
      assert.equal(after.mtimeMs, before.mtimeMs);
    }
  } finally {
    for (const source of sources) await rm(source, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
