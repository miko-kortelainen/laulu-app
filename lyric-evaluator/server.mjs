import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'langsmith';
import { createJudge, criteria, readInput, reviewLyrics } from './judge.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']],
]);

export function configuration(env = process.env) {
  const missing = ['GEMINI_API_KEY', 'LANGSMITH_API_KEY'].filter(key => !env[key]?.trim());
  return {
    ready: missing.length === 0, missing, criteria,
    model: env.LYRIC_EVAL_MODEL?.trim() || 'gemini-4-argon',
    project: env.LYRIC_EVAL_PROJECT?.trim() || 'lyric-quality-evaluator',
  };
}

export async function recordReview(client, { input, assessment, model, project, started }) {
  const runId = randomUUID();
  await client.createRun({
    id: runId, name: 'lyric-quality-review', run_type: 'chain', project_name: project,
    inputs: input, outputs: assessment, start_time: started, end_time: Date.now(),
    extra: { metadata: { judge_model: model, rubric_version: '1' } },
  });
  await Promise.all([
    ...criteria.map(([key]) => client.createFeedback({
      runId, key, score: assessment.scores[key].score, comment: assessment.scores[key].comment,
      feedbackConfig: { type: 'continuous', min: 1, max: 5 },
    })),
    client.createFeedback({ runId, key: 'overall', score: assessment.overall,
      comment: 'Unweighted mean of the six criteria.', feedbackConfig: { type: 'continuous', min: 1, max: 5 } }),
  ]);
  const url = await client.getRunUrl({ runId, projectOpts: { projectName: project } }).catch(() => null);
  return { saved: true, runId, url };
}

export async function evaluateInput(value) {
  const input = readInput(value);
  const config = configuration();
  if (!config.ready) throw new Error(`Add ${config.missing.join(', ')} to lyric-evaluator/.env, then restart this tool.`);
  const judge = createJudge({ apiKey: process.env.GEMINI_API_KEY });
  const client = new Client({ autoBatchTracing: false });
  const started = Date.now();
  const assessment = await reviewLyrics(input, judge, config.model).catch(error => {
    if (error instanceof Error && ('status' in error || ['APIConnectionError', 'APIConnectionTimeoutError'].includes(error.name))) {
      const details = JSON.stringify({ status: error.status, code: error.code, param: error.param, requestId: error.requestID, message: error.message });
      console.error('lyric judge request failed:', details.replaceAll(process.env.GEMINI_API_KEY.trim(), '[redacted]'));
      const remedies = {
        400: 'The judge rejected the request. Check the selected model and its JSON-output support.',
        401: 'Gemini authentication failed. Check GEMINI_API_KEY.',
        403: 'Gemini access was denied. Check the API key permissions and model access.',
        404: 'The judge model was not found. Check LYRIC_EVAL_MODEL and Gemini model access.',
        422: 'The judge rejected the request settings. Check the selected model and its JSON-output support.',
        429: 'The judge service limit was reached. Check the provider quota or try again later.',
      };
      const message = error.name === 'APIConnectionTimeoutError' ? 'The judge request timed out.'
        : remedies[error.status] || (error.status ? `The judge service failed (HTTP ${error.status}). Try again later.` : 'Could not reach Gemini. Check the network connection.');
      throw new Error(`${message} No automatic retry was made.`);
    }
    if (error instanceof SyntaxError) throw new Error('The judge returned invalid JSON. No automatic retry was made.');
    throw error;
  });
  const langsmith = await recordReview(client, { input, assessment, model: config.model, project: config.project, started })
    .catch(() => ({ saved: false, message: 'Your review is ready, but saving to LangSmith failed. Download the report to keep these scores.' }));
  return { assessment, langsmith, model: config.model, project: config.project, reviewedAt: new Date().toISOString() };
}

export function createEvaluatorServer({ evaluate = evaluateInput, status = configuration } = {}) {
  let busy = false;
  const server = createServer(async (req, res) => {
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const host = req.headers.host;
    if (![ `127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}` ].includes(host) ||
      (req.headers.origin && req.headers.origin !== `http://${host}`)) return send(403, { error: 'Use this tool from its local address.' });
    if (req.method === 'GET' && req.url === '/api/config') return send(200, status());
    const asset = req.method === 'GET' && assets.get(req.url);
    if (asset) {
      const body = await readFile(new URL(`./public/${asset[0]}`, import.meta.url)).catch(() => null);
      if (!body) return send(500, { error: 'Could not load the interface.' });
      res.writeHead(200, {
        'Content-Type': `${asset[1]}; charset=utf-8`, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      });
      return res.end(body);
    }
    if (req.method !== 'POST' || req.url !== '/api/evaluate') return send(404, { error: 'Not found.' });
    if (req.headers['content-type']?.split(';')[0] !== 'application/json') return send(415, { error: 'Send JSON input.' });
    if (busy) return send(409, { error: 'A review is already running. Wait for it to finish.' });
    busy = true;
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length <= 128000) chunks.push(chunk);
      }
      if (length > 128000) return send(413, { error: 'This request is too large. Shorten the brief or lyrics.' });
      let input;
      try { input = readInput(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { return send(400, { error: error instanceof SyntaxError ? 'Send valid JSON input.' : error.message }); }
      const result = await evaluate(input);
      send(200, result);
    } catch (error) {
      send(502, { error: error instanceof Error ? error.message : 'Could not complete the review.' });
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 15000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3002);
  createEvaluatorServer().listen(port, '127.0.0.1', () => console.log(`Lyric evaluator: http://127.0.0.1:${port}`));
}
