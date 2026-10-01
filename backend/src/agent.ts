import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import dotenv from 'dotenv';
import { traceable } from 'langsmith/traceable';
import { wrapOpenAI } from 'langsmith/wrappers/openai';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateMusicTool } from './music.js';
import { separateStemsTool } from './stems.js';
import { removeEchoTool } from './dereverb.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure .env is loaded regardless of working directory
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

export function getApiKey(): string {
  // Re-check dotenv in case file was edited while process runs
  dotenv.config({ path: path.resolve(__dirname, '../.env'), override: true });
  return (process.env.NEBIUS_API_KEY || '').trim();
}

export function getBaseUrl(): string {
  return (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').trim();
}

export function getModelId(): string {
  return (process.env.NEBIUS_MODEL || 'nvidia/nemotron-3-super-120b-a12b').trim();
}

export function isApiKeyConfigured(): boolean {
  const key = getApiKey();
  return Boolean(key && key !== 'your_nebius_api_key_here');
}

export function getModelConfig() {
  return {
    apiKeyConfigured: isApiKeyConfigured(),
    baseURL: getBaseUrl(),
    model: getModelId(),
  };
}

// Map of sessionId -> Agent instance
const agents = new Map<string, Agent>();

export function createNebiusModel() {
  const apiKey = getApiKey() || 'sk-dummy-key';

  return new OpenAIModel({
    api: 'chat',
    modelId: getModelId(),
    client: wrapOpenAI(new OpenAI({
      apiKey,
      baseURL: getBaseUrl(),
    })),
  });
}

export function getOrCreateAgent(sessionId: string = 'default'): Agent {
  if (agents.has(sessionId)) {
    return agents.get(sessionId)!;
  }

  const model = createNebiusModel();
  const agent = new Agent({
    model: model,
    tools: [generateMusicTool, separateStemsTool, removeEchoTool],
    systemPrompt:
      'you are a helpful ai assistant powered by nvidia nemotron super on nebius token factory. ' +
      'answer directly in the user\'s language, with a relaxed, natural tone and everyday words. ' +
      'default to 2–4 short sentences. add detail only when the user asks or the answer needs it to be useful and accurate. ' +
      'skip canned greetings, praise, filler, repeated summaries, and unasked follow-up questions. ' +
      'use short paragraphs; use lists only when they make the answer easier to follow. ' +
      'the chat displays plain text, so do not use markdown formatting: no **bold**, *italics*, headings with #, or markdown tables. ' +
      'use plain labels and line breaks instead. write each music tool field in plain text too. ' +
      'always write conversational text in lowercase, including sentence starts, names, acronyms, headings, and list items. ' +
      'preserve required casing in code, commands, file paths, urls, exact quotations, supplied lyrics, and lyria section tags and the Lyrics: label. ' +
      'be honest about uncertainty and never pretend to be human. ' +
      'when the user asks to create music, follow the generate_music tool instructions to fill the editable lyria 3.5 song prompt fields. ' +
      'the user must approve it with the generate music button before audio is generated. ' +
      'tell them to review the prompt and click the button; never claim the track is already generated. ' +
      'keep that reply to one short sentence; the prompt is already shown separately, so do not repeat it or its lyrics in your reply. ' +
      'use the tool again for prompt changes. do not use it for general music advice. ' +
      'when the user requests vocal or instrumental separation, use separate_stems with the available audio url. ' +
      'when the user requests echo or reverb removal, use remove_echo_reverb with the requested track or stem url. ' +
      'if they request isolated clean vocals, separate first, then pass the returned vocalsUrl to remove_echo_reverb. ' +
      'these audio tools run locally. after success, keep the reply to one short sentence; audio players appear separately.',
    printer: false,
  });

  agent.invoke = traceable(agent.invoke.bind(agent), {
    name: 'musical-copilot',
    run_type: 'chain',
    metadata: { thread_id: sessionId },
  });

  agents.set(sessionId, agent);
  return agent;
}

export function resetAgentSession(sessionId: string = 'default') {
  agents.delete(sessionId);
}
