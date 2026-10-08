import assert from 'node:assert/strict';
import childProcess, { type ExecFileException, type ExecFileOptions } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { promisify } from 'node:util';

const userId = '10000000-0000-4000-8000-000000000003';
const runFile = promisify(childProcess.execFile);

async function sampleAudio(channels = 1, duration = 1, format = 'wav'): Promise<Buffer> {
  const directory = await mkdtemp(path.join(tmpdir(), 'audio-test-'));
  const filename = path.join(directory, `sample.${format}`);
  try {
    await runFile('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i',
      `sine=frequency=440:sample_rate=22050:duration=${duration}`, '-ac', String(channels), '-f', format, filename]);
    return await readFile(filename);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('audio uploads validate files, preserve valid state, and end with their session', async (t) => {
  process.env.LANGSMITH_TRACING = 'false';
  process.env.MAX_AUDIO_JOBS = '2';
  let activeProcessors = 0;
  let peakProcessors = 0;
  const originalExecFile = childProcess.execFile;
  childProcess.execFile = t.mock.fn((file: string, args: readonly string[], options: ExecFileOptions,
    callback: (error: ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => void) => {
    activeProcessors++;
    peakProcessors = Math.max(peakProcessors, activeProcessors);
    return originalExecFile(file, args, options, (error, stdout, stderr) => {
      activeProcessors--;
      // Match the stderr attached by execFile's custom promise implementation.
      if (error) Object.assign(error, { stdout, stderr });
      callback(error, stdout, stderr);
    });
  }) as typeof childProcess.execFile;
  Object.defineProperty(childProcess.execFile, promisify.custom, {
    value: (file: string, args: readonly string[], options: ExecFileOptions) => new Promise((resolve, reject) => {
      childProcess.execFile(file, args, options, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      });
    }),
  });
  syncBuiltinESMExports();
  t.after(() => { childProcess.execFile = originalExecFile; syncBuiltinESMExports(); });
  const { audioDirectory, audioPath: userAudioPath, uploadAudio: uploadUserAudio } = await import('../src/audio.js');
  const { resetAgentSession, retainUploadSession } = await import('../src/agent.js');
  const audioPath = (url: unknown) => userAudioPath(url, userId);
  const uploadAudio = (name: unknown, data: unknown) => uploadUserAudio(name, data, userId);
  for (const url of ['https://example.com/song.mp3', '/etc/passwd', '/api/audio/../../.env',
    '/api/music/00000000-0000-0000-0000-000000000000.wav', '/api/audio/not-a-uuid.mp3',
    '/api/audio/00000000-0000-0000-0000-000000000000.wav/extra']) {
    assert.throws(() => audioPath(url), /choose a generated track/);
  }
  await assert.rejects(uploadAudio('track.exe', Buffer.from('audio')), /MP3, WAV/);
  await assert.rejects(uploadAudio('track.wav', Buffer.alloc(0)), /audio upload/);
  await assert.rejects(uploadAudio('track.wav', Buffer.alloc(50 * 1024 * 1024 + 1)), /audio upload/);
  const before = await readdir(path.join(audioDirectory, userId)).catch(() => []);
  await assert.rejects(uploadAudio('broken.wav', Buffer.from('not audio')), /Invalid data/);
  await assert.rejects(uploadAudio('surround.wav', await sampleAudio(3)), /mono or stereo/);
  await assert.rejects(uploadAudio('long.wav', await sampleAudio(1, 601)), /10 minutes/);
  await assert.rejects(uploadAudio('disguised.wav', await sampleAudio(1, 1, 'adts')), /Invalid argument/);
  assert.deepEqual(await readdir(path.join(audioDirectory, userId)), before);

  const input = await sampleAudio();
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = '';
    await assert.rejects(uploadAudio('track.wav', input), /install FFmpeg/);
    assert.deepEqual(await readdir(path.join(audioDirectory, userId)), before);
  } finally {
    process.env.PATH = previousPath;
  }
  const queued = await Promise.allSettled([
    uploadAudio('broken.wav', Buffer.from('not audio')),
    ...Array.from({ length: 4 }, (_, index) => uploadAudio(`queued ${index}.wav`, input)),
  ]);
  assert.deepEqual(queued.map((result) => result.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
    'a failed processor releases its slot and queued conversions finish');
  assert.equal(peakProcessors, 2, 'audio processors never exceed the configured limit');
  assert.equal(activeProcessors, 0);
  const audio = await uploadAudio('my voice.wav', input);
  const finishSession = retainUploadSession(userId);
  try {
    assert.equal(audio.name, 'my voice.wav');
    assert.deepEqual(await readFile(audioPath(audio.url)), input);
    for (const format of ['mp3', 'flac', 'ogg']) {
      const data = await sampleAudio(2, 1, format);
      const track = await uploadAudio(`stereo.${format}`, data);
      assert.deepEqual(await readFile(audioPath(track.url)), data);
    }
  } finally {
    finishSession();
    await resetAgentSession(userId);
    await assert.rejects(stat(audioPath(audio.url)), { code: 'ENOENT' });
  }
});
