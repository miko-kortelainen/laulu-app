import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

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
    apiKey: apiKey,
    clientConfig: {
      baseURL: getBaseUrl(),
    },
  });
}

export function getOrCreateAgent(sessionId: string = 'default'): Agent {
  if (agents.has(sessionId)) {
    return agents.get(sessionId)!;
  }

  const model = createNebiusModel();
  const agent = new Agent({
    model: model,
    systemPrompt:
      'you are a helpful ai assistant powered by nvidia nemotron super on nebius token factory. ' +
      'answer directly in the user\'s language, with a relaxed, natural tone and everyday words. ' +
      'default to 2–4 short sentences. add detail only when the user asks or the answer needs it to be useful and accurate. ' +
      'skip canned greetings, praise, filler, repeated summaries, and unasked follow-up questions. ' +
      'use short paragraphs; use lists only when they make the answer easier to follow. ' +
      'always write conversational text in lowercase, including sentence starts, names, acronyms, headings, and list items. ' +
      'preserve required casing in code, commands, file paths, urls, and exact quotations. ' +
      'be honest about uncertainty and never pretend to be human.',
    printer: false,
  });

  agents.set(sessionId, agent);
  return agent;
}

export function resetAgentSession(sessionId: string = 'default') {
  agents.delete(sessionId);
}
