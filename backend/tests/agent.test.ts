import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, AgentResult } from '@strands-agents/sdk';
import { getChatContext, getOrCreateAgent, resetAgentSession } from '../src/agent.js';
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
    resetAgentSession(userA);
    const replacement = getOrCreateAgent(userA);
    replacement.messages.push({ role: 'user', content: [] });
    t.mock.timers.tick(timeout / 2);
    assert.equal(getChatContext(userA).messages, 1, 'reset cancels the old expiration timer');
  } finally {
    resetAgentSession(userA);
    resetAgentSession(userB);
    restoreGateway();
    if (originalTracing === undefined) delete process.env.LANGSMITH_TRACING;
    else process.env.LANGSMITH_TRACING = originalTracing;
  }
});
