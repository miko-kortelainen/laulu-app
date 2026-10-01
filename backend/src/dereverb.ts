import { tool, type ToolContext } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { processAudio, type AudioTrack } from './audio.js';

export async function removeEcho(audioUrl: unknown): Promise<AudioTrack> {
  const url = await processAudio(audioUrl, 'cleaned');
  return { url: `${url}/source_cleaned.wav`, name: 'cleaned audio' };
}

export const removeEchoTool = tool({
  name: 'remove_echo_reverb',
  description:
    'Reduce echo and reverb locally with UVR-DeEcho-DeReverb. Call only when requested. ' +
    'Accepts an exact available audio URL from generated tracks, uploads, separated stems, or cleaned audio. ' +
    'To clean isolated vocals, call separate_stems first and use its vocalsUrl. Do not invent URLs. ' +
    'Returns one cleaned WAV; does not separate individual instruments or guarantee complete removal. ' +
    'The chat shows a player and download after success. Never claim success if the tool fails.',
  inputSchema: {
    type: 'object',
    properties: { audio_url: { type: 'string' } },
    required: ['audio_url'],
    additionalProperties: false,
  },
  callback: traceable(async (input: unknown, context: ToolContext) => {
    const audioUrl = input && typeof input === 'object' && 'audio_url' in input ? input.audio_url : undefined;
    const audio = await removeEcho(audioUrl);
    context.invocationState.cleanedAudio = audio;
    return { ...audio };
  }, {
    name: 'remove_echo_reverb', run_type: 'tool',
    processInputs: ({ args }) => ({ audio_url: args[0] && typeof args[0] === 'object' && 'audio_url' in args[0]
      ? args[0].audio_url : undefined }),
  }),
});
