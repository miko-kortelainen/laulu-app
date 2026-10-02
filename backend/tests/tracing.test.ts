import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'langsmith';
import { getOrCreateAgent, resetAgentSession } from '../src/agent.js';
import { generateMusic } from '../src/music.js';

test('agent traces contain model and tool runs, errors, and conversation metadata', async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateRun = Client.prototype.createRun;
  const originalUpdateRun = Client.prototype.updateRun;
  const originalTracing = process.env.LANGSMITH_TRACING;
  const runs: Parameters<Client['createRun']>[0][] = [];
  const updates = new Map<string, Parameters<Client['updateRun']>[1]>();
  const sessionId = 'offline-tracing-test';
  const prompt = {
    genre: 'folk', mood: 'gentle', key: 'G major', bpm: '80', duration: '',
    instruments: 'acoustic guitar', vocals: 'instrumental only, no vocals',
    production: 'natural', lyrics: '',
  };
  let modelCalls = 0;
  let fail = false;
  const revisedPrompt = { ...prompt, key: 'D minor', bpm: '140' };

  Client.prototype.createRun = async function (run) { runs.push(run); };
  Client.prototype.updateRun = async function (id, run) {
    updates.set(id, JSON.parse(JSON.stringify(run)) as typeof run);
  };
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/chat\/completions$/);
    const request = JSON.parse(String(options?.body));
    assert.ok(request.tools.some((entry: { function: { name: string } }) => entry.function.name === 'update_music_form'));
    modelCalls++;
    if (fail) return Response.json({ error: { message: 'offline model failure' } }, { status: 400 });
    const toolCall = modelCalls === 1 || modelCalls === 3;
    const delta = toolCall
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'music-1', type: 'function',
          function: { name: 'update_music_form', arguments: JSON.stringify(modelCalls === 3 ? revisedPrompt : prompt) } }] }
      : { role: 'assistant', content: 'review the prompt and click generate music.' };
    const base = { id: `completion-${modelCalls}`, object: 'chat.completion.chunk',
      created: 0, model: 'offline-model' };
    const chunks = [
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }] },
      { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const stream = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    process.env.LANGSMITH_TRACING = 'true';
    const agent = getOrCreateAgent(sessionId);
    const result = await agent.invoke('prepare a folk song');
    assert.deepEqual(result.invocationState.musicPrompt, prompt);
    assert.equal(modelCalls, 2);
    const root = runs.find((run) => run.name === 'musical-copilot');
    assert.ok(root?.id);
    assert.equal(root.extra?.metadata?.thread_id, sessionId);
    const children = runs.filter((run) => run.parent_run_id === root.id);
    assert.equal(children.filter((run) => run.run_type === 'llm').length, 2);
    const tool = children.find((run) => run.name === 'update_music_form');
    assert.ok(tool?.id);
    assert.deepEqual(tool.inputs, prompt);
    assert.equal(tool.extra?.metadata?.thread_id, sessionId);
    assert.equal(updates.get(root.id)?.outputs?.outputs?.stopReason, 'endTurn');
    assert.equal(updates.get(root.id)?.outputs?.outputs?.lastMessage?.content?.[0]?.text, result.toString());
    assert.deepEqual(updates.get(tool.id)?.outputs, { status: 'awaiting_confirmation', prompt });
    for (const model of children.filter((run) => run.run_type === 'llm')) {
      assert.equal(model.extra?.metadata?.thread_id, sessionId);
      assert.equal(updates.get(model.id!)?.outputs?.usage_metadata?.total_tokens, 15);
    }

    const revision = await agent.invoke('change only the BPM to 140\n\ncurrent music form:\n' + JSON.stringify({ ...prompt, key: 'D minor' }));
    assert.deepEqual(revision.invocationState.musicPrompt, revisedPrompt);
    assert.equal(modelCalls, 4);

    await assert.rejects(generateMusic('', 'lyria-3.5', { metadata: { thread_id: sessionId } }), /music prompt/);
    const audio = runs.find((run) => run.name === 'generate_audio');
    assert.ok(audio?.id);
    assert.equal(audio.extra?.metadata?.thread_id, sessionId);
    assert.match(updates.get(audio.id)?.error ?? '', /music prompt/);

    fail = true;
    await assert.rejects(agent.invoke('trigger a model failure'), /offline model failure/);
    const failed = runs.filter((run) => run.name === 'musical-copilot').at(-1);
    assert.ok(failed?.id);
    assert.match(updates.get(failed.id)?.error ?? '', /offline model failure/);

    process.env.LANGSMITH_TRACING = 'false';
    fail = false;
    const runCount = runs.length;
    const advice = await agent.invoke('continue');
    assert.equal(advice.toString(), result.toString());
    assert.equal(advice.invocationState.musicPrompt, undefined);
    assert.equal(runs.length, runCount);
  } finally {
    resetAgentSession(sessionId);
    globalThis.fetch = originalFetch;
    Client.prototype.createRun = originalCreateRun;
    Client.prototype.updateRun = originalUpdateRun;
    if (originalTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = originalTracing;
  }
});
