import type { RequestHandler } from 'express';

export function createApiRateLimit(): RequestHandler {
  // shortcut: counters are per process, use a shared limiter before adding backend instances.
  const requests = new Map<string, number>();
  let total = 0;
  let resetsAt = 0;

  return (req, res, next) => {
    const now = Date.now();
    if (now >= resetsAt) {
      requests.clear();
      total = 0;
      resetsAt = now + 60_000;
    }

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const count = requests.get(ip) ?? 0;
    if (count >= 300 || total >= 3000) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((resetsAt - now) / 1000))));
      res.set('Cache-Control', 'no-store');
      res.status(429).json({ error: 'too many requests. try again shortly.', code: 'rate_limited' });
      return;
    }

    requests.set(ip, count + 1);
    total++;
    next();
  };
}
