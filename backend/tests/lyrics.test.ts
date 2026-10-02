import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { ToolContext } from '@strands-agents/sdk';
import { Client } from 'langsmith';
import { getOrCreateAgent, resetAgentSession } from '../src/agent.js';
import { getModelId } from '../src/model.js';
import { updateMusicFormTool } from '../src/music.js';

test('only lyric requests use GLM, preserve form values, and commit completed lyrics', { timeout: 15_000 }, async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateRun = Client.prototype.createRun;
  const originalUpdateRun = Client.prototype.updateRun;
  const originalTracing = process.env.LANGSMITH_TRACING;
  const originalLyricsModel = process.env.LYRICS_MODEL;
  const runs: Parameters<Client['createRun']>[0][] = [];
  const sessionId = 'offline-lyrics-test';
  const brief = {
    genre: 'pop', mood: 'hopeful', key: 'D minor', bpm: '120', duration: '',
    instruments: 'piano', vocals: 'english vocals', production: 'dry',
    structure: '[verse] -> [chorus]', lyrics: '',
  };
  const lyrics = '[verse]\n' + Array(8).fill('you left your coat beside the door.').join('\n') +
    '\n[chorus]\n' + Array(4).fill('i keep a seat for you.').join('\n');
  let revisedLyrics = lyrics;
  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  let lyricRequest: string | undefined = 'write lyrics about waiting for someone';
  let failure: 'http' | 'empty' | 'truncated' | 'truncatedEmpty' | 'long' | undefined;
  let currentBrief = brief;
  let mainCalls = 0;
  let mainTurnCycle = 2;
  let looping = false;
  let mainInputTokens = 10;
  let mainFailure = false;

  Client.prototype.createRun = async (run) => { runs.push(run); };
  Client.prototype.updateRun = async () => {};
  process.env.LANGSMITH_TRACING = 'true';
  process.env.LYRICS_MODEL = 'zai-org/GLM-5.3-Flash';
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/chat\/completions$/);
    const request = JSON.parse(String(options?.body));
    requests.push(request);
    const isLyrics = request.model === 'zai-org/GLM-5.3-Flash';
    assert.equal(request.max_completion_tokens, isLyrics ? 8192 : 4096);
    const toolCall = !isLyrics && (looping || ++mainCalls % mainTurnCycle !== 0);
    if (isLyrics) {
      assert.equal(request.reasoning_effort, 'low');
      assert.equal(request.tools?.length ?? 0, 0);
      assert.equal(request.messages[0].content, readFileSync(new URL('../prompts/lyrics.md', import.meta.url), 'utf8').trim());
      assert.deepEqual(JSON.parse(request.messages.at(-1).content[0].text), { request: lyricRequest, brief: currentBrief });
      if (failure === 'http') return Response.json({ error: { message: 'offline lyric failure' } }, { status: 400 });
    } else {
      assert.equal(request.model, getModelId());
      if (mainFailure) return Response.json({ error: { message: 'offline throttling' } }, { status: 429 });
    }
    const delta = toolCall
      ? { role: 'assistant', tool_calls: Array.from({ length: looping ? 3 : 1 }, (_, index) => ({
          index, id: `form-${requests.length}-${index}`, type: 'function',
          function: { name: 'update_music_form', arguments: JSON.stringify({ ...currentBrief, lyricRequest }) },
        })) }
      : { role: 'assistant', content: isLyrics
          ? failure === 'empty' || failure === 'truncatedEmpty' ? '' : failure === 'long' ? 'a'.repeat(10_001) : lyricRequest?.startsWith('change') ? revisedLyrics : lyrics
          : 'the form is updated.' };
    const base = { id: `completion-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: request.model };
    const chunks = [
      ...(isLyrics ? [{ ...base, choices: [{ index: 0,
        delta: { role: 'assistant', reasoning_content: 'a short plan before the lyrics.' }, finish_reason: null }] }] : []),
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : failure?.startsWith('truncated') ? 'length' : 'stop' }] },
      { ...base, choices: [], usage: { prompt_tokens: isLyrics ? 10 : mainInputTokens,
          completion_tokens: isLyrics ? 5000 : 5, total_tokens: isLyrics ? 5010 : mainInputTokens + 5 } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    const agent = getOrCreateAgent(sessionId);
    const draft = await agent.invoke(lyricRequest!);
    assert.deepEqual(draft.invocationState.musicPrompt, { ...brief, lyrics });
    assert.deepEqual(requests.map(({ model }) => model), [getModelId(), 'zai-org/GLM-5.3-Flash', getModelId()]);
    const formRun = runs.find((run) => run.name === 'update_music_form');
    const lyricRun = runs.find((run) => run.name === 'generate_lyrics');
    assert.ok(formRun?.id && lyricRun?.id);
    assert.equal(lyricRun.parent_run_id, formRun.id);
    assert.ok(runs.some((run) => run.run_type === 'llm' && run.parent_run_id === lyricRun.id));

    // Musical changes preserve manually edited lyrics without calling the lyric model.
    currentBrief = { ...brief, bpm: '140', lyrics: lyrics.replace('your coat', 'your jacket') };
    lyricRequest = undefined;
    const before = requests.length;
    const tempo = await agent.invoke('change only the BPM to 140');
    assert.deepEqual(tempo.invocationState.musicPrompt, currentBrief);
    assert.deepEqual(requests.slice(before).map(({ model }) => model), [getModelId(), getModelId()]);

    lyricRequest = 'change only the chorus, preserve the verse';
    revisedLyrics = currentBrief.lyrics.replaceAll('i keep a seat for you.', 'i move the chair away.');
    const revision = await agent.invoke(lyricRequest);
    assert.deepEqual(revision.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });

    // Usable text is accepted once, even when it exceeds the character or token limit.
    for (const mode of ['long', 'truncated'] as const) {
      const invocationState = { musicPrompt: currentBrief };
      failure = mode;
      const requestCount = requests.length;
      await updateMusicFormTool.invoke({ ...currentBrief, lyricRequest }, { invocationState } as ToolContext);
      assert.deepEqual(invocationState.musicPrompt, { ...currentBrief,
        lyrics: mode === 'long' ? 'a'.repeat(3_000) : revisedLyrics });
      assert.equal(requests.length - requestCount, 1);
    }

    // Provider errors and reasoning-only responses cannot overwrite valid state.
    for (const mode of ['http', 'empty', 'truncatedEmpty'] as const) {
      const invocationState = { musicPrompt: currentBrief };
      failure = mode;
      await assert.rejects(updateMusicFormTool.invoke({ ...currentBrief, lyricRequest }, { invocationState } as ToolContext),
        mode === 'http' ? /offline lyric failure/ : mode === 'empty' ? /music prompt/ : /maximum token limit/);
      assert.deepEqual(invocationState.musicPrompt, currentBrief);
      const requestCount = requests.length;
      await assert.rejects(updateMusicFormTool.invoke({ ...currentBrief, lyricRequest }, { invocationState } as ToolContext),
        /only one lyric generation attempt/);
      assert.equal(requests.length, requestCount);
    }

    // Repeated and batched tool calls stop without making another paid lyric call.
    looping = true;
    failure = 'long';
    const loopStart = requests.length;
    const loop = await agent.invoke('generate lyrics');
    assert.equal(loop.stopReason, 'limitTurns');
    assert.deepEqual(loop.invocationState.musicPrompt, { ...currentBrief, lyrics: 'a'.repeat(3_000) });
    assert.equal(requests.slice(loopStart).filter(({ model }) => model === getModelId()).length, 6);
    assert.equal(requests.slice(loopStart).filter(({ model }) => model === 'zai-org/GLM-5.3-Flash').length, 1);

    // A longer request completes within the increased turn and total-token budgets.
    looping = false;
    failure = undefined;
    mainCalls = 0;
    mainTurnCycle = 6;
    mainInputTokens = 4_000;
    const extendedStart = requests.length;
    const extended = await agent.invoke('revise the song and finish the response');
    assert.equal(extended.stopReason, 'endTurn');
    assert.deepEqual(extended.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });
    assert.equal(requests.slice(extendedStart).filter(({ model }) => model === getModelId()).length, 6);
    assert.equal(requests.slice(extendedStart).filter(({ model }) => model === 'zai-org/GLM-5.3-Flash').length, 1);

    // Token spend stops another main turn, and the next user message has a fresh budget.
    mainInputTokens = 30_000;
    mainTurnCycle = 2;
    looping = true;
    const budgetStart = requests.length;
    const budget = await agent.invoke('try again');
    assert.equal(budget.stopReason, 'limitTotalTokens');
    assert.deepEqual(budget.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });
    assert.equal(requests.slice(budgetStart).filter(({ model }) => model === getModelId()).length, 1);
    looping = false;
    mainInputTokens = 10;
    mainCalls = 0;
    const recovery = await agent.invoke('write the chorus again');
    assert.equal(recovery.stopReason, 'endTurn');
    assert.deepEqual(recovery.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });

    // Neither the OpenAI client nor the agent retries a throttled model request.
    mainFailure = true;
    const failureStart = requests.length;
    await assert.rejects(agent.invoke('trigger throttling'), /offline throttling/);
    assert.equal(requests.length - failureStart, 1);
  } finally {
    resetAgentSession(sessionId);
    globalThis.fetch = originalFetch;
    Client.prototype.createRun = originalCreateRun;
    Client.prototype.updateRun = originalUpdateRun;
    if (originalTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = originalTracing;
    if (originalLyricsModel === undefined) delete process.env.LYRICS_MODEL;
    else process.env.LYRICS_MODEL = originalLyricsModel;
  }
});
