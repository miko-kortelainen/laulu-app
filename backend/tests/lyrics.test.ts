import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Message, TextBlock, type ToolContext } from '@strands-agents/sdk';
import { Client } from 'langsmith';
import { getChatContext, getOrCreateAgent, resetAgentSession } from '../src/agent.js';
import { getModelId } from '../src/model.js';
import { updateMusicFormTool } from '../src/music.js';
import { countLyricCharacters, countLyricLines, lyricSections, validateLyricOutput } from '../src/lyrics.js';
import { configureTestGateway, testGatewayURL } from './gateway-environment.js';
import { configureTestQuotas } from './quota-fixture.js';

test('lyric contract counts sections without enforcing ambiguous section requirements', () => {
  const valid = '[Verse 1]\n' + Array(8).fill('Keep This Exact Line.').join('\n') +
    '\n\n[chorus]\n' + Array(4).fill('a short hook.').join('\n');
  assert.equal(countLyricCharacters(valid), valid.length);
  assert.equal(countLyricLines(valid), 12);
  assert.deepEqual(lyricSections(valid).map(({ name, lines }) => [name, lines.length]), [['verse', 8], ['chorus', 4]]);
  assert.equal(validateLyricOutput(valid), valid, 'valid supplied-style text survives unchanged');
  assert.equal(validateLyricOutput('No Tags Here\nKeep Me'), 'No Tags Here\nKeep Me', 'untagged text stays advisory');
  assert.equal(validateLyricOutput('[bridge]\nonly one line.'), '[bridge]\nonly one line.');
  const partialVerse = '[verse]\nline.\nline.\nline.';
  assert.equal(validateLyricOutput(partialVerse), partialVerse, 'usable partial sections remain accepted');
  const customChorus = '[chorus]\nline.\nline.';
  assert.equal(validateLyricOutput(customChorus), customChorus, 'custom section lengths remain advisory');
  assert.throws(() => validateLyricOutput(' \n\t '), /generated lyrics are empty/);
  assert.throws(() => validateLyricOutput('a'.repeat(3_001)), /exceed 3,000 characters/);
});

test('only lyric requests use the Qwen fallback, preserve form values, and commit completed lyrics', { timeout: 15_000 }, async () => {
  const originalFetch = globalThis.fetch;
  const originalDatabaseURL = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = 'https://offline-lyrics.supabase.co';
  const quotas = configureTestQuotas();
  const restoreGateway = configureTestGateway();
  const originalCreateRun = Client.prototype.createRun;
  const originalUpdateRun = Client.prototype.updateRun;
  const originalTracing = process.env.LANGSMITH_TRACING;
  const originalLyricsModel = process.env.LYRICS_MODEL;
  const runs: Parameters<Client['createRun']>[0][] = [];
  const sessionId = 'offline-lyrics-test';
  const brief = {
    genre: 'pop', mood: 'hopeful', key: 'D minor', bpm: '120', duration: '',
    instruments: 'piano', vocals: 'english vocals', production: 'dry',
    lyrics: '',
  };
  const lyrics = '[verse]\n' + Array(8).fill('you left your coat beside the door.').join('\n') +
    '\n[chorus]\n' + Array(4).fill('i keep a seat for you.').join('\n');
  let revisedLyrics = lyrics;
  const requests: { model: string; max_completion_tokens: number; messages: { role: string; content: string }[] }[] = [];
  let lyricRequest: string | undefined = 'write lyrics about waiting for someone';
  let lyricSkill: string | undefined = 'melodic-hip-hop-rnb';
  let failure: 'http' | 'empty' | 'truncated' | 'truncatedEmpty' | 'long' | undefined;
  let lyricOutput: string | undefined;
  let currentBrief = brief;
  let mainCalls = 0;
  let mainTurnCycle = 2;
  let looping = false;
  let mainInputTokens = 10;
  let mainOutputTokens = 5;
  let mainFailure = false;
  let contextOverflow = false;

  Client.prototype.createRun = async (run) => { runs.push(run); };
  Client.prototype.updateRun = async () => {};
  process.env.LANGSMITH_TRACING = 'true';
  delete process.env.LYRICS_MODEL;
  globalThis.fetch = async (url, options) => {
    const httpRequest = new Request(url, options);
    const database = await quotas.databaseResponse(httpRequest.clone());
    if (database) return database;
    assert.equal(httpRequest.url, `${testGatewayURL}/custom-nebius/v1/chat/completions`);
    const request = await httpRequest.json();
    requests.push(request);
    const isLyrics = request.model === 'Qwen/Qwen3.8-27B';
    if (isLyrics) assert.equal(request.max_completion_tokens, 32_768);
    else assert.ok(request.max_completion_tokens > 0 && request.max_completion_tokens <= 4096);
    const lyricSkillCall = isLyrics && !!lyricSkill && request.messages.at(-1)?.role !== 'tool';
    const toolCall = lyricSkillCall || (!isLyrics && (looping || ++mainCalls % mainTurnCycle !== 0));
    if (isLyrics) {
      assert.equal(request.reasoning_effort, undefined);
      assert.equal(request.temperature, 1);
      assert.equal(request.top_p, 0.95);
      assert.deepEqual(request.chat_template_kwargs, { enable_thinking: true });
      assert.deepEqual(request.tools?.map((entry: { function: { name: string } }) => entry.function.name), ['skills']);
      assert.ok(request.messages[0].content.startsWith(readFileSync(new URL('../prompts/lyrics.md', import.meta.url), 'utf8').trim()));
      for (const skillName of ['country-pop-rock-folk-indie', 'melodic-hip-hop-rnb', 'street-trap-drill-rap']) {
        assert.ok(request.messages[0].content.includes(`<name>${skillName}</name>`));
      }
      assert.deepEqual(JSON.parse(request.messages[1].content[0].text), { request: lyricRequest, brief: currentBrief });
      if (request.messages.at(-1)?.role === 'tool') {
        assert.ok(JSON.stringify(request.messages.at(-1)).includes('# Melodic Hip-Hop & R&B Lyric Craft'));
      }
      if (failure === 'http') return Response.json({ error: { message: 'offline lyric failure' } }, { status: 400 });
    } else {
      assert.equal(request.model, getModelId());
      if (mainFailure) return Response.json({ error: { message: 'offline throttling' } }, { status: 429 });
      if (contextOverflow) return Response.json({ error: { message: 'context length exceeded', code: 'context_length_exceeded' } }, { status: 400 });
    }
    const delta = lyricSkillCall
      ? { role: 'assistant', tool_calls: [{ index: 0, id: `skill-${requests.length}`, type: 'function',
          function: { name: 'skills', arguments: JSON.stringify({ skill_name: lyricSkill }) } }] }
      : toolCall
      ? { role: 'assistant', tool_calls: Array.from({ length: looping ? 3 : 1 }, (_, index) => ({
          index, id: `form-${requests.length}-${index}`, type: 'function',
          function: { name: 'update_music_form', arguments: JSON.stringify({ ...currentBrief, lyricRequest }) },
        })) }
      : { role: 'assistant', content: isLyrics
          ? failure === 'empty' || failure === 'truncatedEmpty' ? '' : failure === 'long' ? 'a'.repeat(10_001) : lyricOutput ?? (lyricRequest?.startsWith('change') ? revisedLyrics : lyrics)
          : 'the form is updated.' };
    const base = { id: `completion-${requests.length}`, object: 'chat.completion.chunk', created: 0, model: request.model };
    const chunks = [
      ...(isLyrics ? [{ ...base, choices: [{ index: 0,
        delta: { role: 'assistant', reasoning_content: 'a short plan before the lyrics.' }, finish_reason: null }] }] : []),
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : failure?.startsWith('truncated') ? 'length' : 'stop' }] },
      { ...base, choices: [], usage: { prompt_tokens: isLyrics ? 10 : mainInputTokens,
          completion_tokens: isLyrics ? 5000 : Math.min(mainOutputTokens, request.max_completion_tokens),
          total_tokens: isLyrics ? 5010 : mainInputTokens + Math.min(mainOutputTokens, request.max_completion_tokens) } },
    ];
    return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    let agent = getOrCreateAgent(sessionId);
    const draft = await agent.invoke(lyricRequest!);
    assert.deepEqual(draft.invocationState.musicPrompt, { ...brief, lyrics });
    assert.deepEqual(requests.map(({ model }) => model), [getModelId(), 'Qwen/Qwen3.8-27B', 'Qwen/Qwen3.8-27B', getModelId()]);
    lyricSkill = undefined;
    const formRun = runs.find((run) => run.name === 'update_music_form');
    const lyricRun = runs.find((run) => run.name === 'generate_lyrics');
    assert.ok(formRun?.id && lyricRun?.id);
    assert.equal(lyricRun.parent_run_id, formRun.id);
    assert.ok(runs.some((run) => run.run_type === 'llm' && run.parent_run_id === lyricRun.id));

    // Musical changes preserve manually edited lyrics without calling the lyric model.
    currentBrief = { ...brief, bpm: '140', lyrics: lyrics.replace('your coat', 'your jacket') };
    for (lyricRequest of [undefined, '', ' \n\t ']) {
      const before = requests.length;
      const tempo = await agent.invoke('change only the BPM to 140');
      assert.deepEqual(tempo.invocationState.musicPrompt, currentBrief);
      assert.equal(tempo.invocationState.lyricGenerationAttempted, undefined);
      assert.deepEqual(requests.slice(before).map(({ model }) => model), [getModelId(), getModelId()]);
    }

    lyricRequest = 'change only the chorus, preserve the verse';
    revisedLyrics = currentBrief.lyrics.replaceAll('i keep a seat for you.', 'i move the chair away.');
    const revision = await agent.invoke(lyricRequest);
    assert.deepEqual(revision.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });

    const savedBrief = currentBrief;
    const preservedVerse = '[Verse 1]\r\n' + Array(6).fill('Keep This EXACT Line!').join('\r\n');
    const fourLineChorus = '[chorus]\n' + Array(4).fill('a short hook.').join('\n');
    const sixLineChorus = '[chorus]\n' + Array(6).fill('a new hook.').join('\n');
    const longTaggedLyrics = '[verse]\n' + Array(8).fill('v'.repeat(300)).join('\n') +
      '\n[chorus]\n' + Array(4).fill('c'.repeat(200)).join('\n');
    assert.ok(longTaggedLyrics.length > 3_000);
    for (const example of [
      { request: 'change only the chorus, preserve the verse', output: preservedVerse + '\n' + fourLineChorus },
      { request: 'write a six-line chorus', output: preservedVerse + '\n' + sixLineChorus },
      { request: 'preserve verse, chorus 6 lines', supplied: lyrics, output: lyrics.split('\n[chorus]')[0] + '\n' + sixLineChorus },
      { request: 'kirjoita kuuden rivin kertosäe', output: preservedVerse + '\n' + sixLineChorus },
      { request: 'write lyrics about waiting', output: '[verse]\nline.\nline.\nline.', truncated: true },
      { request: 'write lyrics about waiting', output: longTaggedLyrics },
    ]) {
      currentBrief = { ...savedBrief, lyrics: example.supplied ?? preservedVerse + '\n' + fourLineChorus };
      const invocationState = { musicPrompt: currentBrief, userId: sessionId };
      lyricRequest = example.request;
      lyricOutput = example.output;
      failure = example.truncated ? 'truncated' : undefined;
      const requestCount = requests.length;
      await updateMusicFormTool.invoke({ ...currentBrief, lyricRequest }, { invocationState } as ToolContext);
      assert.deepEqual(invocationState.musicPrompt, { ...currentBrief, lyrics: example.output.slice(0, 3_000) }, example.request);
      assert.equal(requests.length - requestCount, 1, 'accept the output without another lyric attempt');
    }
    currentBrief = savedBrief;
    lyricRequest = 'change only the chorus, preserve the verse';
    lyricOutput = undefined;
    failure = undefined;

    // Usable text is accepted once, even when it exceeds the character or token limit.
    for (const mode of ['long', 'truncated'] as const) {
      const invocationState = { musicPrompt: currentBrief, userId: sessionId };
      failure = mode;
      const requestCount = requests.length;
      await updateMusicFormTool.invoke({ ...currentBrief, lyricRequest }, { invocationState } as ToolContext);
      assert.deepEqual(invocationState.musicPrompt, { ...currentBrief,
        lyrics: mode === 'long' ? 'a'.repeat(3_000) : revisedLyrics });
      assert.equal(requests.length - requestCount, 1);
    }

    // Provider errors and reasoning-only responses cannot overwrite valid state.
    for (const mode of ['http', 'empty', 'truncatedEmpty'] as const) {
      const invocationState = { musicPrompt: currentBrief, userId: sessionId };
      failure = mode;
      await assert.rejects(updateMusicFormTool.invoke({ ...currentBrief, lyricRequest }, { invocationState } as ToolContext),
        mode === 'http' ? /offline lyric failure/ : mode === 'empty' ? /generated lyrics are empty/ : /maximum token limit/);
      assert.deepEqual(invocationState.musicPrompt, currentBrief);
      const requestCount = requests.length;
      await assert.rejects(updateMusicFormTool.invoke({ ...currentBrief, lyricRequest }, { invocationState } as ToolContext),
        /only one lyric generation attempt/);
      assert.equal(requests.length, requestCount);
    }

    // Repeated and batched tool calls stop without making another paid lyric call.
    looping = true;
    failure = 'long';
    await resetAgentSession(sessionId);
    agent = getOrCreateAgent(sessionId);
    const loopStart = requests.length;
    const loop = await agent.invoke('generate lyrics');
    assert.ok(loop.stopReason === 'limitTurns' || loop.toString().includes('token budget'));
    assert.deepEqual(loop.invocationState.musicPrompt, { ...currentBrief, lyrics: 'a'.repeat(3_000) });
    assert.ok(requests.slice(loopStart).filter(({ model }) => model === getModelId()).length <= 3);
    assert.equal(requests.slice(loopStart).filter(({ model }) => model === 'Qwen/Qwen3.8-27B').length, 1);

    // A three-turn edit completes within the chat budgets.
    looping = false;
    failure = undefined;
    mainCalls = 0;
    mainTurnCycle = 3;
    mainInputTokens = 100;
    await resetAgentSession(sessionId);
    agent = getOrCreateAgent(sessionId);
    const extendedStart = requests.length;
    const extended = await agent.invoke('revise the song and finish the response');
    assert.equal(extended.stopReason, 'endTurn');
    assert.deepEqual(extended.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });
    assert.equal(requests.slice(extendedStart).filter(({ model }) => model === getModelId()).length, 3);
    assert.equal(requests.slice(extendedStart).filter(({ model }) => model === 'Qwen/Qwen3.8-27B').length, 1);

    // Full history is trimmed so a successful lyric edit can still receive its final reply.
    await resetAgentSession(sessionId);
    agent = getOrCreateAgent(sessionId);
    for (let index = 0; index < 8; index++) {
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('a'.repeat(3_000))] }),
        new Message({ role: 'assistant', content: [new TextBlock('a'.repeat(3_000))] }));
    }
    mainCalls = 0;
    mainTurnCycle = 2;
    mainInputTokens = 7875;
    mainOutputTokens = 376;
    lyricRequest = 'change the lyrics to be more ironic and funny';
    const fullHistoryStart = requests.length;
    const fullHistory = await agent.invoke('make the lyrics more ironic and funny');
    assert.equal(fullHistory.toString(), 'the form is updated.');
    assert.deepEqual(fullHistory.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });
    const fullHistoryRequests = requests.slice(fullHistoryStart).filter(({ model }) => model === getModelId());
    assert.equal(fullHistoryRequests.length, 2);
    const finalMessages = JSON.stringify(fullHistoryRequests[1].messages);
    assert.ok(finalMessages.includes('make the lyrics more ironic and funny'), 'keep the current user request');
    assert.ok(finalMessages.includes('i move the chair away.'), 'keep the revised lyrics in the tool result');
    assert.ok(agent.messages.length < 16, 'remove older history to leave room for the reply');
    mainOutputTokens = 5;

    // Token spend stops another main turn, and the next user message has a fresh budget.
    mainInputTokens = 20_000;
    mainTurnCycle = 2;
    looping = true;
    await resetAgentSession(sessionId);
    agent = getOrCreateAgent(sessionId);
    const budgetStart = requests.length;
    const budget = await agent.invoke('try again');
    assert.equal(budget.stopReason, 'limitTotalTokens');
    assert.deepEqual(budget.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });
    assert.equal(requests.slice(budgetStart).filter(({ model }) => model === getModelId()).length, 1);
    looping = false;
    mainInputTokens = 10;
    mainCalls = 0;
    await resetAgentSession(sessionId);
    agent = getOrCreateAgent(sessionId);
    const recovery = await agent.invoke('write the chorus again');
    assert.equal(recovery.stopReason, 'endTurn');
    assert.deepEqual(recovery.invocationState.musicPrompt, { ...currentBrief, lyrics: revisedLyrics });

    // An oversized request is rejected before inference, and a reset permits recovery.
    const oversizedStart = requests.length;
    const oversized = await agent.invoke('a'.repeat(100_000));
    assert.match(oversized.toString(), /token budget/);
    assert.equal(requests.length, oversizedStart);
    await resetAgentSession(sessionId);
    agent = getOrCreateAgent(sessionId);

    // Trimmed history must not inherit the previous prompt's obsolete token baseline.
    agent.messages.push(new Message({ role: 'user', content: [new TextBlock('hello')] }),
      new Message({ role: 'assistant', content: [new TextBlock('hello')],
        metadata: { usage: { inputTokens: 19900, outputTokens: 100, totalTokens: 20000 } } }));
    mainCalls = 0;
    lyricRequest = undefined;
    const trimmedStart = requests.length;
    await agent.invoke('change the tempo');
    assert.ok(requests.length > trimmedStart, 'fresh sizing allows short retained history');

    // Reported output usage shrinks the next provider request instead of overshooting the loop budget.
    mainOutputTokens = 3948;
    mainCalls = 0;
    lyricRequest = 'change the chorus';
    const outputStart = requests.length;
    await agent.invoke('change the tempo');
    assert.equal(requests[outputStart + 2].max_completion_tokens, 148);
    mainOutputTokens = 5;

    // Exhausted lyrics stop before Qwen, preserve the draft, and do not stop later field-only edits.
    quotas.failures.resource = 'lyrics';
    const deniedState = { musicPrompt: currentBrief, userId: sessionId };
    const deniedStart = requests.length;
    await assert.rejects(updateMusicFormTool.invoke({ ...currentBrief, lyricRequest }, { invocationState: deniedState } as ToolContext), /lyrics allowance exhausted/);
    assert.equal(requests.length, deniedStart);
    assert.deepEqual(deniedState.musicPrompt, currentBrief);
    lyricRequest = undefined;
    mainCalls = 0;
    const fieldsOnly = await agent.invoke('change only the BPM');
    assert.deepEqual(fieldsOnly.invocationState.musicPrompt, currentBrief);
    quotas.failures.resource = undefined;

    // Context-overflow recovery retries within one SDK turn, but never exceeds three HTTP calls.
    await resetAgentSession(sessionId);
    agent = getOrCreateAgent(sessionId);
    for (let index = 0; index < 8; index++) {
      agent.messages.push(new Message({ role: 'user', content: [new TextBlock('hello')] }),
        new Message({ role: 'assistant', content: [new TextBlock('hello')] }));
    }
    contextOverflow = true;
    const overflowStart = requests.length;
    const overflow = await agent.invoke('hello');
    assert.equal(requests.length - overflowStart, 3);
    assert.match(overflow.toString(), /token budget/);
    contextOverflow = false;

    // Neither the OpenAI client nor the agent retries a throttled model request.
    mainFailure = true;
    const failureStart = requests.length;
    await assert.rejects(agent.invoke('trigger throttling'), /offline throttling/);
    assert.equal(requests.length - failureStart, 1);

    // The frontend reset route discards the agent and all retained messages.
    assert.ok(agent.messages.length > 0);
    assert.equal(getChatContext(sessionId).messages, agent.messages.length);
    resetAgentSession(sessionId);
    assert.deepEqual(getChatContext(sessionId), { messages: 0, limit: 16 });
    const freshAgent = getOrCreateAgent(sessionId);
    assert.notEqual(freshAgent, agent);
    assert.equal(freshAgent.messages.length, 0);
  } finally {
    resetAgentSession(sessionId);
    globalThis.fetch = originalFetch;
    quotas.restore();
    if (originalDatabaseURL === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalDatabaseURL;
    restoreGateway();
    Client.prototype.createRun = originalCreateRun;
    Client.prototype.updateRun = originalUpdateRun;
    if (originalTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = originalTracing;
    if (originalLyricsModel === undefined) delete process.env.LYRICS_MODEL;
    else process.env.LYRICS_MODEL = originalLyricsModel;
  }
});
