import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('built server serves frontend routes and assets without exposing the API', async () => {
  process.env.NODE_ENV = 'test';
  process.env.LANGSMITH_TRACING = 'false';
  process.env.SUPABASE_URL = 'https://offline-auth.supabase.co';
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
      assertSecurityHeaders(response);
      assert.equal(await response.text(), html);
    }
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert.ok(script, 'built frontend has a JavaScript bundle');
    const asset = await fetch(`${origin}${script}`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/);
    assertSecurityHeaders(asset);
    assert.deepEqual(await (await fetch(`${origin}/api/health`)).json(), { status: 'ok' });
    const unauthorized = await fetch(`${origin}/api/context`);
    assert.equal(unauthorized.status, 401);
    assertSecurityHeaders(unauthorized);
    assert.equal((await fetch(`${origin}/api/unknown`)).status, 401);
    const missing = await fetch(`${origin}/assets/missing.js`);
    assert.equal(missing.status, 404);
    assertSecurityHeaders(missing);
    assert.equal((await fetch(`${origin}/unknown`, { headers: { Accept: 'application/json' } })).status, 404);
    const spoofedHttps = await fetch(`${origin}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(spoofedHttps.headers.get('strict-transport-security'), null, 'development does not enable HSTS');
    process.env.NODE_ENV = 'production';
    const production = await fetch(`${origin}/api/health`);
    assert.equal(production.headers.get('strict-transport-security'), 'max-age=31536000', 'production supports TLS termination at the proxy');
  } finally {
    process.env.NODE_ENV = 'test';
    globalThis.fetch = originalFetch;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

function assertSecurityHeaders(response) {
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(response.headers.get('x-powered-by'), null);
  const policy = response.headers.get('content-security-policy');
  assert.ok(policy);
  // Express uses a stricter policy for its final HTML error responses.
  if (response.status === 404) {
    assert.equal(policy, "default-src 'none'");
    return;
  }
  const directives = new Map(policy.split('; ').map(value => {
    const [name, ...sources] = value.split(/\s+/);
    return [name, sources];
  }));
  assert.deepEqual(directives.get('default-src'), ["'self'"]);
  for (const directive of ['object-src', 'base-uri', 'frame-ancestors']) {
    assert.deepEqual(directives.get(directive), ["'none'"]);
  }
  assert.deepEqual(directives.get('script-src'), ["'self'", 'https://cdn.paddle.com', 'https://challenges.cloudflare.com']);
  assert.ok(directives.get('style-src').includes('https://fonts.googleapis.com'));
  assert.ok(directives.get('font-src').includes('https://fonts.gstatic.com'));
  assert.deepEqual(directives.get('frame-src'), ['https://*.paddle.com', 'https://challenges.cloudflare.com']);
  assert.ok(directives.get('connect-src').includes('https://offline-auth.supabase.co'));
  assert.ok(directives.get('connect-src').includes('https://*.paddle.com'));
  assert.ok(directives.get('media-src').includes("'self'"));
}
