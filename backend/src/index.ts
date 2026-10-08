import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { BeforeModelCallEvent, BeforeToolCallEvent } from '@strands-agents/sdk';
import { endUploadSession, getChatContext, getOrCreateAgent, resetAgentSession, retainUploadSession } from './agent.js';
import { getModelConfig } from './model.js';
import { generateMusic, MusicPromptTokenLimitError, validateMusicModel, validateMusicPrompt } from './music.js';
import { AudioBusyError, audioDirectory, audioPath, startAudioUpload, uploadAudio } from './audio.js';
import { requireAuth } from './auth.js';
import { userDirectory } from './user-files.js';
import { deleteSong, listSongs, listSongRecovery, readSong, retrySongStorage, SongNotFoundError, SongStorageError } from './songs.js';
import { getUsage, QuotaError, reserveUsage } from './quotas.js';
import { cleanupLocalAudio, LocalAudioLimitError } from './local-audio.js';
import { acknowledgeOperation, busySessions, getOperation, operationId, listOperations, recoverOperations, sessionBusy, startOperation } from './operations.js';

export const app = express();
const PORT = process.env.PORT || 3001;

// The frontend and API share one origin in production and use the Vite proxy in development.
// Browsers from other origins cannot read API responses unless listed here.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',').map((origin) => origin.trim()).filter(Boolean);
app.use(cors({ origin: allowedOrigins }));
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api', requireAuth);
app.use(express.json());
function locked(handler: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId: string = res.locals.userId;
    if (sessionBusy(userId)) {
      res.status(409).json({ error: 'wait for the current action to finish.' });
      return;
    }
    busySessions.add(userId);
    try {
      await handler(req, res);
    } catch (error: unknown) {
      next(error);
    } finally {
      busySessions.delete(userId);
    }
  };
}
app.use('/api/audio', (req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  express.static(userDirectory(audioDirectory, res.locals.userId), { dotfiles: 'deny', index: false })(req, res, next);
});

function storageFailure(res: Response, error: unknown): void {
  if (error instanceof QuotaError) return quotaFailure(res, error);
  const invalidRange = error instanceof Error && error.name === 'InvalidRange';
  res.status(error instanceof SongNotFoundError ? 404 : invalidRange ? 416 : 502).json({
    error: error instanceof Error ? error.message : 'song storage failed. try again.',
    ...(error instanceof SongStorageError ? { songId: error.songId, retryUrl: `/api/songs/${error.songId}/retry` } : {}),
  });
}

function quotaFailure(res: Response, error: QuotaError): void {
  if (error.resetAt) res.set('Retry-After', String(Math.max(0, Math.ceil((Date.parse(error.resetAt) - Date.now()) / 1000))));
  res.status(error.status).json({ error: error.message, code: error.status === 429 ? 'quota_exceeded' : 'quota_unavailable',
    resource: error.resource, resetAt: error.resetAt });
}

app.get('/api/usage', async (_req, res) => {
  const usage = await getUsage(res.locals.userId).catch((error: unknown) => storageFailure(res, error));
  if (usage) res.set('Cache-Control', 'private, no-store').json(usage);
});

app.get('/api/music/:filename', async (req, res) => {
  const match = /^([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.mp3$/i.exec(req.params.filename);
  if (!match) return res.status(404).json({ error: 'song not found.' });
  const range = req.get('range');
  if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
    return res.status(416).json({ error: 'invalid audio range.' });
  }
  const result = await readSong(res.locals.userId, match[1], range).catch((error: unknown) => storageFailure(res, error));
  if (!result) return;
  res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, no-store', 'Accept-Ranges': 'bytes' });
  if ('filename' in result) return res.sendFile(result.filename);
  if (result.contentRange) res.status(206).set('Content-Range', result.contentRange);
  res.send(result.audio);
});

app.get('/api/songs', async (_req, res) => {
  const songs = await listSongs(res.locals.userId).catch((error: unknown) => storageFailure(res, error));
  if (songs) res.set('Cache-Control', 'private, no-store').json({ songs });
});

app.get('/api/songs/recovery', async (_req, res) => {
  const songIds = await listSongRecovery(res.locals.userId).catch((error: unknown) => storageFailure(res, error));
  if (songIds) res.set('Cache-Control', 'private, no-store').json({ songIds });
});

const parseAudioUpload = express.raw({ type: 'application/octet-stream', limit: '50mb' });
app.post('/api/audio', locked(async (req, res) => {
  let releaseUpload: () => void;
  try {
    releaseUpload = startAudioUpload();
  } catch (error: unknown) {
    if (!(error instanceof AudioBusyError)) throw error;
    res.set('Retry-After', '5').status(503).json({ error: error.message });
    return;
  }
  let release: (() => void) | undefined;
  try {
    release = retainUploadSession(res.locals.userId);
    await new Promise<void>((resolve, reject) => {
      parseAudioUpload(req, res, (error: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    });
    const audio = await uploadAudio(req.query.name, req.body, res.locals.userId).catch((error: unknown) => {
      res.status(error instanceof LocalAudioLimitError ? 507 : 400).json({ error: error instanceof Error ? error.message : 'audio upload failed.' });
    });
    if (audio) res.json({ audio });
  } finally {
    release?.();
    releaseUpload();
  }
}));
app.use('/api/audio', (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const oversized = error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large';
  res.status(oversized ? 413 : 400).json({ error: oversized ? 'audio upload must be 50 MB or smaller.' : 'audio upload failed.' });
});

app.delete('/api/songs/:id', locked(async (req, res) => {
  await deleteSong(res.locals.userId, req.params.id as string).catch((error: unknown) => storageFailure(res, error));
  if (!res.headersSent) res.status(204).end();
}));

app.post('/api/songs/:id/retry', locked(async (req, res) => {
  const userId: string = res.locals.userId;
  const track = await retrySongStorage(userId, req.params.id as string).catch((error: unknown) => storageFailure(res, error));
  if (track) res.json({ track });
}));

function toolStatus(name: string, input: unknown): string {
  const lyricRequest = input && typeof input === 'object' && 'lyricRequest' in input ? input.lyricRequest : undefined;
  return name === 'update_music_form'
    ? typeof lyricRequest === 'string' && lyricRequest.trim() ? 'editing lyrics...' : 'editing fields...'
    : name === 'analyze_audio' ? 'analyzing audio...' : 'working...';
}

app.get('/api/operations', async (_req, res) => {
  const operations = await listOperations(res.locals.userId).catch((error: unknown) => storageFailure(res, error));
  if (operations) res.set('Cache-Control', 'private, no-store').json({ operations });
});
app.get('/api/operations/:id', async (req, res) => {
  const operation = await getOperation(res.locals.userId, operationId(req.params.id)).catch((error: unknown) => storageFailure(res, error));
  if (operation) res.set('Cache-Control', 'private, no-store').json({ operation });
});
app.post('/api/operations/:id/acknowledge', async (req, res) => {
  await acknowledgeOperation(res.locals.userId, operationId(req.params.id)).catch((error: unknown) => storageFailure(res, error));
  if (!res.headersSent) res.status(204).end();
});

// Chat endpoint
app.get('/api/context', (_req: Request, res: Response) => {
  res.json(getChatContext(res.locals.userId));
});

app.post('/api/chat', locked(async (req: Request, res: Response) => {
  const message: unknown = req.body?.message;
  const sessionId: string = res.locals.userId;
  const streamProgress = req.get('accept') === 'application/x-ndjson';
  const removeHooks: (() => void)[] = [];
  const send = (data: unknown): void => {
    if (res.destroyed) return;
    if (streamProgress) res.write(`${JSON.stringify(data)}\n`);
    else res.json(data);
  };

  if (!message || typeof message !== 'string' || message.trim() === '') {
    res.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const audioUrl: unknown = req.body?.audioUrl;
    if (audioUrl !== undefined) audioPath(audioUrl, sessionId);
    const musicPrompt = req.body?.musicPrompt === undefined ? '' : validateMusicPrompt(req.body.musicPrompt);
    const agent = getOrCreateAgent(sessionId);
    if (req.body?.operationId !== undefined) {
      const operation = await startOperation(sessionId, req.body.operationId, 'chat', async (onStatus) => {
        await reserveUsage(sessionId, 'chat');
        const hooks = [agent.addHook(BeforeModelCallEvent, () => onStatus('thinking...')),
          agent.addHook(BeforeToolCallEvent, ({ toolUse }) => onStatus(toolStatus(toolUse.name, toolUse.input)))];
        try {
          const result = await agent.invoke(message.trim() + (musicPrompt ? `\n\ncurrent music form:\n${musicPrompt}` : '') +
            (audioUrl ? `\n\navailable audio: ${audioUrl}` : ''));
          if (result.invocationState.quotaError instanceof QuotaError) throw result.invocationState.quotaError;
          return { reply: result.stopReason.startsWith('limit')
            ? 'stopped at the request limit. send a new message to continue.' : result.toString(),
            musicPrompt: result.invocationState.musicPrompt };
        } finally {
          for (const remove of hooks) remove();
        }
      });
      res.status(202).json({ operation });
      return;
    }
    await reserveUsage(sessionId, 'chat');
    if (streamProgress) {
      res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      removeHooks.push(agent.addHook(BeforeModelCallEvent, () => send({ status: 'thinking...' })));
      removeHooks.push(agent.addHook(BeforeToolCallEvent, ({ toolUse }) => {
        send({ status: toolStatus(toolUse.name, toolUse.input) });
      }));
    }
    const result = await agent.invoke(message.trim() + (musicPrompt ? `\n\ncurrent music form:\n${musicPrompt}` : '') + (audioUrl ? `\n\navailable audio: ${audioUrl}` : ''));
    const quotaError = result.invocationState.quotaError;
    if (quotaError instanceof QuotaError) {
      if (!res.headersSent) quotaFailure(res, quotaError);
      else send({ error: quotaError.message, code: quotaError.status === 429 ? 'quota_exceeded' : 'quota_unavailable',
        resource: quotaError.resource, resetAt: quotaError.resetAt });
      return;
    }
    const reply = result.stopReason.startsWith('limit')
      ? 'stopped at the request limit. send a new message to continue.'
      : result.toString();
    send({ reply, musicPrompt: result.invocationState.musicPrompt });
  } catch (error: unknown) {
    if (error instanceof QuotaError && !res.headersSent) {
      quotaFailure(res, error);
      return;
    }
    const message = error instanceof Error ? error.message : 'Failed to process message with agent';
    console.error('Agent invocation error:', error);
    if (!res.headersSent) res.status(500);
    send({
      error: message,
      reply: `Agent Error: ${message}`,
    });
  } finally {
    for (const removeHook of removeHooks) removeHook();
    if (streamProgress && req.body?.operationId === undefined) res.end();
  }
}));

// Only this explicit confirmation request can make a paid Lyria call.
app.post('/api/music', locked(async (req: Request, res: Response) => {
  const sessionId: string = res.locals.userId;
  let prompt: string;
  let model: ReturnType<typeof validateMusicModel>;
  try {
    prompt = validateMusicPrompt(req.body?.prompt);
    model = validateMusicModel(req.body?.model);
  } catch (error: unknown) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'invalid music prompt.' });
    return;
  }

  if (req.body?.operationId !== undefined) {
    const operation = await startOperation(sessionId, req.body.operationId, 'music', async () => ({
      track: await generateMusic(prompt, model, sessionId, req.body.operationId, { metadata: { thread_id: sessionId, ls_model_name: model } }),
    })).catch((error: unknown) => storageFailure(res, error));
    if (operation) res.status(202).json({ operation });
    return;
  }
  const track = await generateMusic(prompt, model, sessionId, undefined, { metadata: { thread_id: sessionId, ls_model_name: model } }).catch((error: unknown) => {
    if (error instanceof QuotaError || error instanceof SongStorageError) return storageFailure(res, error);
    res.status(error instanceof MusicPromptTokenLimitError ? 400 : 502)
      .json({ error: error instanceof Error ? error.message : 'music generation failed.' });
  });
  if (track) res.json({ track });
}));

// Reset endpoint
app.post('/api/session/end', async (_req, res) => {
  await endUploadSession(res.locals.userId).catch((error: unknown) => {
    res.status(500).json({ error: error instanceof Error ? error.message : 'session cleanup failed. try again.' });
  });
  if (!res.headersSent) res.status(204).end();
});

app.post('/api/reset', locked(async (req: Request, res: Response) => {
  const sessionId: string = res.locals.userId;
  await resetAgentSession(sessionId).catch((error: unknown) => {
    res.status(500).json({ error: error instanceof Error ? error.message : 'session cleanup failed. try again.' });
  });
  if (!res.headersSent) res.json({ status: 'ok' });
}));

if (process.env.NODE_ENV !== 'test') {
  const cleanup = () => Promise.all([recoverOperations(), cleanupLocalAudio()]).catch((error: unknown) => console.error('local audio cleanup failed:', error));
  void cleanup();
  setInterval(cleanup, 60 * 60_000).unref();
  app.listen(PORT, () => {
    const config = getModelConfig();
    console.log(`Backend running on http://localhost:${PORT}`);
    console.log(`Nebius Model: ${config.model}`);
    console.log(`AI Gateway: ${config.baseURL}`);
  });
}
