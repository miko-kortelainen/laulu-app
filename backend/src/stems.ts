import { tool, type ToolContext } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { processAudio } from './audio.js';

export interface SeparatedStems {
  vocalsUrl: string;
  instrumentalUrl: string;
}

export async function separateStems(audioUrl: unknown, userId: unknown): Promise<SeparatedStems> {
  const url = await processAudio(audioUrl, 'stems', userId);
  return { vocalsUrl: `${url}/source_vocals.wav`, instrumentalUrl: `${url}/source_instrumental.wav` };
}

export const separateStemsTool = tool({
  name: 'separate_stems',
  description:
    'Separate an available generated or uploaded audio track into vocals and instrumental WAV files locally. ' +
    'Uses MelBand Roformer | Vocals by Kimberley Jensen. Call only when the user requests stem separation, ' +
    'vocal isolation, or an instrumental version. Use the available audio URL supplied with the message or an exact URL from the conversation. ' +
    'If no audio is available, ask the user to upload a track or generate one. Do not invent URLs. ' +
    'This model returns vocals and instrumental only, not individual drums, bass, or other instruments. ' +
    'The chat shows players and download links after success; never claim success if the tool fails.',
  inputSchema: {
    type: 'object',
    properties: { audio_url: { type: 'string' } },
    required: ['audio_url'],
    additionalProperties: false,
  },
  callback: traceable(async (input: unknown, context: ToolContext) => {
    const audioUrl = input && typeof input === 'object' && 'audio_url' in input ? input.audio_url : undefined;
    const stems = await separateStems(audioUrl, context.invocationState.userId);
    context.invocationState.stems = stems;
    return { ...stems };
  }, {
    name: 'separate_stems', run_type: 'tool',
    processInputs: ({ args }) => ({ audio_url: args[0] && typeof args[0] === 'object' && 'audio_url' in args[0]
      ? args[0].audio_url : undefined }),
  }),
});
