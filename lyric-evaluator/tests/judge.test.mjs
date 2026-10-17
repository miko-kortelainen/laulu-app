import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Client } from 'langsmith';
import { createJudge, criteria, readInput, reviewLyrics } from '../judge.mjs';
import { configuration, evaluateInput, recordReview } from '../server.mjs';
import { assessment, completion, input } from './fixtures.mjs';

test('input limits preserve text and reject invalid material before a judge call', () => {
  assert.deepEqual(readInput({ ...input, originalLyrics: 'KEEP\r\nTHIS.', unrelated: 'ignored' }), { ...input, originalLyrics: 'KEEP\r\nTHIS.' });
  for (const value of [null, [], {}, { ...input, lyrics: ' ' }, { ...input, lyrics: 4 }, { ...input, lyrics: 'a'.repeat(30001) }]) {
    assert.throws(() => readInput(value));
  }
  assert.equal(configuration({}).ready, false);
  assert.equal(configuration({ LANGSMITH_PROJECT: 'main-app' }).project, 'lyric-quality-evaluator');
  assert.throws(() => createJudge({ apiKey: ' ' }), /GEMINI_API_KEY/);
});

test('Gemini configuration requires server keys and defaults to Argon 4', () => {
  const config = configuration({ LANGSMITH_API_KEY: 'offline' });
  assert.equal(config.ready, false);
  assert.deepEqual(config.missing, ['GEMINI_API_KEY']);
  const ready = configuration({ GEMINI_API_KEY: 'offline-secret', LANGSMITH_API_KEY: 'offline-key' });
  assert.equal(ready.ready, true);
  assert.equal(ready.model, 'gemini-4-argon');
  assert.ok(!JSON.stringify(ready).includes('offline-secret'));
});

test('one Gemini judge call yields six validated scores and a deterministic mean', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    const request = new Request(url, options);
    calls++;
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/interactions');
    assert.equal(request.headers.has('authorization'), false);
    assert.equal(request.headers.get('x-goog-api-key'), 'offline-token');
    assert.equal(request.headers.has('cf-aig-authorization'), false);
    const body = await request.json();
    assert.equal(body.model, 'gemini-4-argon');
    assert.deepEqual(body.generation_config, { max_output_tokens: 32768, thinking_level: 'medium' });
    assert.equal(body.store, false);
    assert.equal(body.response_format.mime_type, 'application/json');
    assert.deepEqual(JSON.parse(body.input), input);
    assert.equal(body.system_instruction, readFileSync(new URL('../rubric.md', import.meta.url), 'utf8'));
    return Response.json(completion());
  };
  try {
    const client = createJudge({ apiKey: 'offline-token' });
    const result = await reviewLyrics(input, client, 'gemini-4-argon');
    assert.equal(calls, 1);
    assert.deepEqual(Object.keys(result.scores), criteria.map(([key]) => key));
    assert.equal(result.overall, 3.5);
    assert.deepEqual(result.strengths, assessment().strengths);
    await assert.rejects(reviewLyrics({ ...input, lyrics: '' }, client, 'mock-judge'));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('incomplete, malformed, or unsupported judgments never become fake scores', async () => {
  const invalidScore = assessment();
  invalidScore.scores.singability.score = 6;
  const inventedQuote = assessment();
  inventedQuote.scores.natural_phrasing.evidence = ['a line that is not in these lyrics'];
  const missingMetric = assessment();
  delete missingMetric.scores.narrative_coherence;
  for (const response of [completion({}, 'incomplete'), completion(invalidScore), completion(inventedQuote), completion(missingMetric),
    { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'not json' }] }] }]) {
    const client = { interactions: { create: async () => response } };
    await assert.rejects(reviewLyrics(input, client, 'mock-judge'));
  }
});

test('reasoning-only and truncated completions give distinct diagnostics without grading or retries', async () => {
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => { logs.push(args); };
  try {
    for (const [response, expected] of [
      [{ ...completion({}, 'incomplete'), usage: { total_output_tokens: 0, total_thought_tokens: 32768 } }, /32,768-token completion limit/],
      [{ status: 'completed', steps: [{ type: 'thought', summary: 'private reasoning text' }] }, /reasoning without a final review/],
      [{ status: 'failed', errors: [{ message: 'provider refusal details' }] }, /failed to complete/],
      [{ status: 'completed', steps: [] }, /complete final review/],
    ]) {
      let calls = 0;
      const client = { interactions: { create: async () => { calls++; return response; } } };
      await assert.rejects(reviewLyrics(input, client, 'gemini-4-argon'), expected);
      assert.equal(calls, 1);
    }
    assert.equal(logs[0][1].status, 'incomplete');
    assert.equal(logs[0][1].outputTokens, 0);
    assert.equal(logs[0][1].reasoningTokens, 32768);
    assert.equal(logs[1][1].hasReasoning, true);
    assert.ok(!JSON.stringify(logs).includes('private reasoning text'));
    assert.ok(!JSON.stringify(logs).includes('provider refusal details'));
  } finally { console.error = originalError; }
});

test('LangSmith receives the inspected report shape and one feedback entry per metric', async () => {
  let recorded;
  const feedback = [];
  const client = {
    createRun: async run => { recorded = run; },
    createFeedback: async grade => { feedback.push(grade); },
    getRunUrl: async () => 'https://smith.langchain.com/offline-review',
  };
  const result = await recordReview(client, { input, assessment: { ...assessment(), overall: 3.5 }, model: 'mock-judge', project: 'separate-evaluator', started: 1 });
  assert.equal(result.saved, true);
  assert.equal(recorded.project_name, 'separate-evaluator');
  assert.deepEqual(recorded.inputs, input);
  assert.equal(recorded.outputs.overall, 3.5);
  assert.equal(feedback.length, 7);
  assert.ok(feedback.every(grade => grade.runId === recorded.id));
  assert.equal(feedback.find(grade => grade.key === 'overall').score, 3.5);
});

test('provider errors give specific guidance, redact credentials, and never retry', async () => {
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const keys = ['GEMINI_API_KEY', 'LANGSMITH_API_KEY'];
  const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.GEMINI_API_KEY = 'offline-secret-token';
  process.env.LANGSMITH_API_KEY = 'offline-key';
  const logs = [];
  console.error = (...args) => { logs.push(args.join(' ')); };
  try {
    for (const [status, expected] of [[400, /JSON-output support/], [401, /authentication failed/], [403, /access was denied/],
      [404, /LYRIC_EVAL_MODEL/], [422, /request settings/], [429, /provider quota/], [502, /HTTP 502/]]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return Response.json({ error: { message: 'provider failure with offline-secret-token', code: status } },
          { status, headers: { 'x-request-id': 'offline-request' } });
      };
      await assert.rejects(evaluateInput(input), expected);
      assert.equal(calls, 1);
    }
    assert.ok(logs.every(log => !log.includes('offline-secret-token') && log.includes('[redacted]')));
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    for (const key of keys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});

test('LangSmith failure preserves the finished review without another judge call', async () => {
  const originalFetch = globalThis.fetch;
  const originalCreateRun = Client.prototype.createRun;
  const keys = ['GEMINI_API_KEY', 'LANGSMITH_API_KEY'];
  const originalEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.GEMINI_API_KEY = 'offline-token';
  process.env.LANGSMITH_API_KEY = 'offline-key';
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json(completion()); };
  Client.prototype.createRun = async () => { throw new Error('offline LangSmith failure'); };
  try {
    const result = await evaluateInput(input);
    assert.equal(result.assessment.overall, 3.5);
    assert.equal(result.langsmith.saved, false);
    assert.match(result.langsmith.message, /review is ready/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    Client.prototype.createRun = originalCreateRun;
    for (const key of keys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});
