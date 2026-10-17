import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import { createEvaluatorServer } from '../server.mjs';
import { input } from './fixtures.mjs';

test('HTTP boundary rejects invalid input and overlapping or cross-origin paid requests', { timeout: 10000 }, async () => {
  let calls = 0;
  let finish;
  const server = createEvaluatorServer({ evaluate: async () => {
    calls++;
    await new Promise(resolve => { finish = resolve; });
    return { completed: true };
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (value, headers = {}) => fetch(`${base}/api/evaluate`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await post({})).status, 400);
    assert.equal((await post(input, { Origin: 'https://example.com' })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/evaluate`, { method: 'POST', headers: { Host: 'example.com', 'Content-Type': 'application/json' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      req.on('error', reject);
      req.end(JSON.stringify(input));
    });
    assert.equal(hostStatus, 403);
    assert.equal((await post(input, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post({ ...input, lyrics: 'a'.repeat(128001) })).status, 413);
    assert.equal(calls, 0);
    const pending = post(input);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await post(input)).status, 409);
    finish();
    assert.deepEqual(await (await pending).json(), { completed: true });
    assert.equal(calls, 1);
  } finally {
    finish?.();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
