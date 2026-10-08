import assert from 'node:assert/strict';
import childProcess, { execFileSync, type ExecFileException, type ExecFileOptions } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const userId = '10000000-0000-4000-8000-000000000003';

const python = fileURLToPath(new URL('../audio-processing/.venv/bin/python', import.meta.url));

function sampleAudio(): Buffer {
  return execFileSync(python, ['-c', `
import io, sys, numpy as np, soundfile as sf
audio = 6000 / 32768 * np.sin(np.arange(22050) * 2 * np.pi * 440 / 22050)
wav = io.BytesIO()
sf.write(wav, audio, 22050, format="WAV", subtype="PCM_16")
sys.stdout.buffer.write(wav.getvalue())
`]);
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
  await assert.rejects(uploadAudio('broken.wav', Buffer.from('not audio')), /Format not recognised/);
  assert.deepEqual(await readdir(path.join(audioDirectory, userId)), before);

  const input = sampleAudio();
  const queued = await Promise.allSettled([
    uploadAudio('broken.wav', Buffer.from('not audio')),
    ...Array.from({ length: 4 }, (_, index) => uploadAudio(`queued ${index}.wav`, input)),
  ]);
  assert.deepEqual(queued.map((result) => result.status), ['rejected', 'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
    'a failed processor releases its slot and queued conversions finish');
  assert.equal(peakProcessors, 2, 'Python processors never exceed the configured limit');
  assert.equal(activeProcessors, 0);
  const audio = await uploadAudio('my voice.wav', input);
  const finishSession = retainUploadSession(userId);
  try {
    assert.equal(audio.name, 'my voice.wav');
    assert.deepEqual(await readFile(audioPath(audio.url)), input);
  } finally {
    finishSession();
    await resetAgentSession(userId);
    await assert.rejects(stat(audioPath(audio.url)), { code: 'ENOENT' });
  }
});
