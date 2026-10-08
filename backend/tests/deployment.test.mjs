import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('built server serves frontend routes and assets without exposing the API', async () => {
  process.env.NODE_ENV = 'test';
  process.env.LANGSMITH_TRACING = 'false';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input, options) => {
    assert.ok(new Request(input, options).url.startsWith('http://127.0.0.1:'), 'no external calls are permitted');
    return originalFetch(input, options);
  };
  const { app } = await import('../dist/index.js');
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const html = await readFile(new URL('../../frontend/dist/index.html', import.meta.url), 'utf8');
    for (const route of ['/', '/songs', '/profile', '/privacy', '/PRIVACY/', '/unknown-page']) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(await response.text(), html);
    }
    const script = /src="(\/assets\/[^\"]+\.js)"/.exec(html)?.[1];
    assert.ok(script, 'built frontend has a JavaScript bundle');
    const asset = await fetch(`${origin}${script}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), { status: 'ok' });
    assert.equal((await fetch(`${origin}/api/context`)).status, 401);
    assert.equal((await fetch(`${origin}/api/unknown`)).status, 401);
    assert.equal((await fetch(`${origin}/assets/missing.js`)).status, 404);
    assert.equal((await fetch(`${origin}/unknown`, { headers: { Accept: 'application/json' } })).status, 404);
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
