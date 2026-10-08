import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent, AgentResult } from '@strands-agents/sdk';
import { endUploadSession, getChatContext, getOrCreateAgent, resetAgentSession, retainUploadSession } from '../src/agent.js';
import { audioDirectory, clearUploadedAudio } from '../src/local-audio.js';
import { configureTestGateway } from './gateway-environment.js';

test('idle agents expire independently while active invocations remain available', async (t) => {
  const restoreGateway = configureTestGateway();
  const originalTracing = process.env.LANGSMITH_TRACING;
  process.env.LANGSMITH_TRACING = 'false';
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no network calls are permitted'); });
  const timeout = 30 * 60 * 1000;
  const userA = 'idle-agent-a';
  const userB = 'idle-agent-b';
  let blocked: Promise<void> | undefined;
  let fail = false;
  let started = () => {};
  t.mock.method(Agent.prototype, 'invoke', async () => {
    started();
    await blocked;
    if (fail) throw new Error('offline invocation failure');
    return new AgentResult({ stopReason: 'endTurn', lastMessage: { role: 'assistant', content: [] }, invocationState: {} });
  });

  try {
    const first = getOrCreateAgent(userA);
    const other = getOrCreateAgent(userB);
    first.messages.push({ role: 'user', content: [] });
    other.messages.push({ role: 'user', content: [] });
    t.mock.timers.tick(timeout - 1);
    assert.equal(getOrCreateAgent(userA), first, 'agent access renews its timeout');
    assert.equal(getChatContext(userB).messages, 1);
    t.mock.timers.tick(1);
    assert.equal(getChatContext(userB).messages, 0, 'context reads do not prevent expiration');
    assert.notEqual(getOrCreateAgent(userB), other);
    assert.equal(getChatContext(userA).messages, 1, 'users expire independently');
    t.mock.timers.tick(timeout - 1);
    assert.equal(getChatContext(userA).messages, 0);

    const active = getOrCreateAgent(userA);
    active.messages.push({ role: 'user', content: [] });
    let finish!: () => void;
    blocked = new Promise<void>((resolve) => { finish = resolve; });
    const invocationStarted = new Promise<void>((resolve) => { started = resolve; });
    const pending = active.invoke('offline request');
    await invocationStarted;
    t.mock.timers.tick(timeout * 2);
    assert.equal(getOrCreateAgent(userA), active, 'active requests survive the timeout');
    t.mock.timers.tick(timeout * 2);
    assert.equal(getChatContext(userA).messages, 1, 'access during invocation must not arm expiration');
    finish();
    await pending;
    t.mock.timers.tick(timeout - 1);
    assert.equal(getChatContext(userA).messages, 1, 'successful requests receive a full idle timeout');
    t.mock.timers.tick(1);
    assert.equal(getChatContext(userA).messages, 0);

    const failed = getOrCreateAgent(userA);
    failed.messages.push({ role: 'user', content: [] });
    fail = true;
    t.mock.timers.tick(timeout - 1);
    await assert.rejects(failed.invoke('fail'), /offline invocation failure/);
    t.mock.timers.tick(timeout - 1);
    assert.equal(getChatContext(userA).messages, 1, 'failed requests also renew expiration');
    t.mock.timers.tick(1);
    assert.equal(getChatContext(userA).messages, 0);

    getOrCreateAgent(userA);
    t.mock.timers.tick(timeout / 2);
    await resetAgentSession(userA);
    const replacement = getOrCreateAgent(userA);
    replacement.messages.push({ role: 'user', content: [] });
    t.mock.timers.tick(timeout / 2);
    assert.equal(getChatContext(userA).messages, 1, 'reset cancels the old expiration timer');
  } finally {
    await resetAgentSession(userA);
    await resetAgentSession(userB);
    restoreGateway();
    if (originalTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = originalTracing;
  }
});

test('uploads end with their session, including upload-only sessions and active uploads', async (t) => {
  const userId = randomUUID();
  const directory = path.join(audioDirectory, userId);
  const filename = path.join(directory, 'fixture.wav');
  const timeout = 30 * 60 * 1000;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('no model calls are permitted'); });
  try {
    const finish = retainUploadSession(userId);
    await mkdir(directory, { recursive: true });
    await writeFile(filename, 'session audio');
    t.mock.timers.tick(timeout * 2);
    assert.equal(await readFile(filename, 'utf8'), 'session audio', 'active uploads pause session expiration');
    await assert.rejects(resetAgentSession(userId), /current action/);
    finish();
    t.mock.timers.tick(timeout - 1);
    assert.equal(await readFile(filename, 'utf8'), 'session audio');
    t.mock.timers.tick(1);
    // Wait for the asynchronous disk cleanup started by the expiration callback.
    const deadline = Date.now() + 1000;
    while (await stat(directory).catch(() => undefined)) {
      assert.ok(Date.now() < deadline, 'expired session uploads must be deleted');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    // Wait for serialized cleanup to finish before starting another session.
    await clearUploadedAudio(userId);
    const finishNext = retainUploadSession(userId);
    await mkdir(directory, { recursive: true });
    await writeFile(filename, 'next session');
    finishNext();
    await resetAgentSession(userId);
    await assert.rejects(stat(directory), { code: 'ENOENT' });
    const finishLogout = retainUploadSession(userId);
    await mkdir(directory, { recursive: true });
    await writeFile(filename, 'active upload');
    await endUploadSession(userId);
    assert.equal(await readFile(filename, 'utf8'), 'active upload', 'logout preserves files still in use');
    finishLogout();
    const logoutDeadline = Date.now() + 1000;
    while (await stat(directory).catch(() => undefined)) {
      assert.ok(Date.now() < logoutDeadline, 'logout deletes uploads as soon as the active job finishes');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await clearUploadedAudio(userId);
  } finally {
    await resetAgentSession(userId);
    await rm(directory, { recursive: true, force: true });
  }
});
