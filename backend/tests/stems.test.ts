import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ToolContext } from '@strands-agents/sdk';
import { audioDirectory, audioPath, separateStemsTool, stemsDirectory, uploadAudio } from '../src/stems.js';

const python = fileURLToPath(new URL('../stem-separation/.venv/bin/python', import.meta.url));

function sampleAudio(): Buffer {
  return execFileSync(python, ['-c', `
import io, sys, numpy as np, soundfile as sf
audio = 6000 / 32768 * np.sin(np.arange(22050) * 2 * np.pi * 440 / 22050)
wav = io.BytesIO()
sf.write(wav, audio, 22050, format="WAV", subtype="PCM_16")
sys.stdout.buffer.write(wav.getvalue())
`]);
}

test('uploads decode, local tool returns two playable stems, and failures preserve valid state', async () => {
  process.env.LANGSMITH_TRACING = 'false';
  for (const url of ['https://example.com/song.mp3', '/etc/passwd', '/api/audio/../../.env',
    '/api/music/00000000-0000-0000-0000-000000000000.wav', '/api/audio/not-a-uuid.mp3']) {
    assert.throws(() => audioPath(url), /choose a generated track/);
  }
  await assert.rejects(uploadAudio('track.exe', Buffer.from('audio')), /MP3, WAV/);
  await assert.rejects(uploadAudio('track.wav', Buffer.alloc(0)), /audio upload/);
  await assert.rejects(uploadAudio('track.wav', Buffer.alloc(50 * 1024 * 1024 + 1)), /audio upload/);
  const before = await readdir(audioDirectory).catch(() => []);
  await assert.rejects(uploadAudio('broken.wav', Buffer.from('not audio')), /Format not recognised/);
  assert.deepEqual(await readdir(audioDirectory), before);

  const input = sampleAudio();
  const audio = await uploadAudio('my voice.wav', input);
  let outputDirectory: string | undefined;
  try {
    assert.equal(audio.name, 'my voice.wav');
    assert.deepEqual(await readFile(audioPath(audio.url)), input);
    const invocationState: Record<string, unknown> = {};
    const context = { invocationState } as ToolContext;
    const result = await separateStemsTool.invoke({ audio_url: audio.url }, context);
    assert.deepEqual(invocationState.stems, result);
    assert.ok(result && typeof result === 'object' && !Array.isArray(result));
    assert.equal(typeof result.vocalsUrl, 'string');
    assert.equal(typeof result.instrumentalUrl, 'string');
    const vocalsUrl = String(result.vocalsUrl);
    assert.match(vocalsUrl, /^\/api\/stems\/[0-9a-f-]{36}\/source_vocals\.wav$/);
    assert.equal(result.instrumentalUrl, vocalsUrl.replace('vocals', 'instrumental'));
    outputDirectory = path.join(stemsDirectory, vocalsUrl.split('/')[3]);
    execFileSync(python, ['-c', `
import sys, numpy as np, soundfile as sf
for stem in ("vocals", "instrumental"):
    filename = f"{sys.argv[1]}/source_{stem}.wav"
    info = sf.info(filename)
    samples, rate = sf.read(filename)
    assert info.format == "WAV" and info.subtype == "FLOAT" and info.frames == 44100 and rate == 44100
    assert np.isfinite(samples).all()
    peak = np.abs(samples).max()
    assert peak == 0 or 0.7 - 1e-6 <= peak <= 0.9 + 1e-6
`, outputDirectory]);
    await assert.rejects(separateStemsTool.invoke({ audio_url: '/etc/passwd' }, context), /choose a generated track/);
    assert.deepEqual(invocationState.stems, result);
    assert.deepEqual(await readFile(audioPath(audio.url)), input);
  } finally {
    await rm(audioPath(audio.url), { force: true });
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  }
});
