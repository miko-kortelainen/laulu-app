import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createApiRateLimit } from '../src/rate-limit.js';
import { startTestServer } from './http-fixture.js';

test('API limits reject spoofed IPs, expire, and bound traffic across clients', async (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const app = express();
  app.use(createApiRateLimit());
  app.use((_req, res) => res.sendStatus(204));
  const { server, url } = await startTestServer(app);
  const call = (ip: string) => fetch(url, { headers: { 'X-Forwarded-For': ip } });
  try {
    for (let i = 0; i < 300; i++) {
      assert.equal((await call(`192.0.2.${i % 250 + 1}`)).status, 204);
    }
    const denied = await call('198.51.100.1');
    assert.equal(denied.status, 429, 'untrusted forwarding headers cannot rotate the client IP');
    assert.equal(denied.headers.get('retry-after'), '60');
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal((await denied.json()).code, 'rate_limited');
    now += 59_001;
    assert.equal((await call('198.51.100.1')).headers.get('retry-after'), '1');
    now += 999;

    app.set('trust proxy', ['loopback']);
    for (let client = 1; client <= 10; client++) {
      for (let i = 0; i < 300; i++) {
        assert.equal((await call(`192.0.2.${client}`)).status, 204, 'trusted proxy clients have separate allowances');
      }
    }
    assert.equal((await call('192.0.2.11')).status, 429, 'new IPs cannot bypass the server ceiling');
    now += 60_000;
    assert.equal((await call('192.0.2.11')).status, 204, 'expired counters release all clients');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
