import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { BeforeModelCallEvent, BeforeToolCallEvent } from '@strands-agents/sdk';
import { getChatContext, getOrCreateAgent, resetAgentSession } from './agent.js';
import { getModelConfig } from './model.js';
import { generateMusic, musicDirectory, MusicPromptTokenLimitError, validateMusicModel, validateMusicPrompt } from './music.js';
import { audioDirectory, audioPath, cleanedDirectory, stemsDirectory, uploadAudio } from './audio.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use('/api/music', express.static(musicDirectory));
app.use('/api/audio', express.static(audioDirectory));
app.use('/api/stems', express.static(stemsDirectory));
app.use('/api/cleaned', express.static(cleanedDirectory));

app.post('/api/audio', express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  const audio = await uploadAudio(req.query.name, req.body).catch((error: unknown) => {
    res.status(400).json({ error: error instanceof Error ? error.message : 'audio upload failed.' });
  });
  if (audio) res.json({ audio });
});
app.use('/api/audio', (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const oversized = error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large';
  res.status(oversized ? 413 : 400).json({ error: oversized ? 'audio upload must be 50 MB or smaller.' : 'audio upload failed.' });
});

const busySessions = new Set<string>();
app.use(['/api/chat', '/api/music', '/api/reset'], (req, res, next) => {
  if (req.method !== 'POST') return next();
  const sessionId: unknown = req.body?.sessionId ?? 'default';
  if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) {
    res.status(400).json({ error: 'invalid conversation session.' });
    return;
  }
  if (busySessions.has(sessionId)) {
    res.status(409).json({ error: 'wait for the current action to finish.' });
    return;
  }
  busySessions.add(sessionId);
  res.locals.sessionId = sessionId;
  next();
});

// Health & Status
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    config: getModelConfig(),
  });
});

// Chat endpoint
app.get('/api/context', (_req: Request, res: Response) => {
  res.json(getChatContext());
});

app.post('/api/chat', async (req: Request, res: Response) => {
  const message: unknown = req.body?.message;
  const sessionId: string = res.locals.sessionId;
  const streamProgress = req.get('accept') === 'application/x-ndjson';
  const removeHooks: (() => void)[] = [];
  const send = (data: unknown): void => {
    if (res.destroyed) return;
    if (streamProgress) res.write(`${JSON.stringify(data)}\n`);
    else res.json(data);
  };

  if (!message || typeof message !== 'string' || message.trim() === '') {
    busySessions.delete(sessionId);
    res.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const audioUrl: unknown = req.body?.audioUrl;
    if (audioUrl !== undefined) audioPath(audioUrl);
    const musicPrompt = req.body?.musicPrompt === undefined ? '' : validateMusicPrompt(req.body.musicPrompt);
    const agent = getOrCreateAgent(sessionId);
    if (streamProgress) {
      res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      removeHooks.push(agent.addHook(BeforeModelCallEvent, () => send({ status: 'thinking...' })));
      removeHooks.push(agent.addHook(BeforeToolCallEvent, ({ toolUse }) => {
        const input = toolUse.input;
        const lyricRequest = input && typeof input === 'object' && 'lyricRequest' in input ? input.lyricRequest : undefined;
        const status = toolUse.name === 'update_music_form'
          ? typeof lyricRequest === 'string' && lyricRequest.trim() ? 'editing lyrics...' : 'editing fields...'
          : toolUse.name === 'separate_stems' ? 'separating stems...'
          : toolUse.name === 'analyze_audio' ? 'analyzing audio...'
          : toolUse.name === 'remove_echo_reverb' ? 'removing echo and reverb...' : 'working...';
        send({ status });
      }));
    }
    const result = await agent.invoke(message.trim() + (musicPrompt ? `\n\ncurrent music form:\n${musicPrompt}` : '') + (audioUrl ? `\n\navailable audio: ${audioUrl}` : ''));
    const reply = result.stopReason.startsWith('limit')
      ? 'stopped at the request limit. send a new message to continue.'
      : result.toString();
    send({ reply, musicPrompt: result.invocationState.musicPrompt, stems: result.invocationState.stems, cleanedAudio: result.invocationState.cleanedAudio });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to process message with agent';
    console.error('Agent invocation error:', error);
    if (!res.headersSent) res.status(500);
    send({
      error: message,
      reply: `Agent Error: ${message}`,
    });
  } finally {
    for (const removeHook of removeHooks) removeHook();
    if (streamProgress) res.end();
    busySessions.delete(sessionId);
  }
});

// Only this explicit confirmation request can make a paid Lyria call.
app.post('/api/music', async (req: Request, res: Response) => {
  const sessionId: string = res.locals.sessionId;
  let prompt: string;
  let model: ReturnType<typeof validateMusicModel>;
  try {
    prompt = validateMusicPrompt(req.body?.prompt);
    model = validateMusicModel(req.body?.model);
  } catch (error: unknown) {
    busySessions.delete(sessionId);
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid music prompt.' });
    return;
  }

  const track = await generateMusic(prompt, model, { metadata: { thread_id: sessionId, ls_model_name: model } }).catch((error: unknown) => {
    res.status(error instanceof MusicPromptTokenLimitError ? 400 : 502)
      .json({ error: error instanceof Error ? error.message : 'music generation failed.' });
  });
  busySessions.delete(sessionId);
  if (track) res.json({ track });
});

// Reset endpoint
app.post('/api/reset', (req: Request, res: Response) => {
  const sessionId: string = res.locals.sessionId;
  resetAgentSession(sessionId);
  busySessions.delete(sessionId);
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  const config = getModelConfig();
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`Nebius Model: ${config.model}`);
  console.log(`AI Gateway: ${config.baseURL}`);
});
