import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { audioDirectory, audioPath as userAudioPath, uploadAudio as uploadUserAudio } from '../src/audio.js';
import { resetAgentSession, retainUploadSession } from '../src/agent.js';

const userId = '10000000-0000-4000-8000-000000000003';
const audioPath = (url: unknown) => userAudioPath(url, userId);
const uploadAudio = (name: unknown, data: unknown) => uploadUserAudio(name, data, userId);

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

test('audio uploads validate files, preserve valid state, and end with their session', async () => {
  process.env.LANGSMITH_TRACING = 'false';
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
