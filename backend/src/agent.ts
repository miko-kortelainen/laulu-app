import { Agent } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import dotenv from 'dotenv';
import { traceable } from 'langsmith/traceable';
import { wrapOpenAI } from 'langsmith/wrappers/openai';
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { updateMusicFormTool } from './music.js';
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
    tools: [updateMusicFormTool, separateStemsTool, removeEchoTool],
    systemPrompt: readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8').trim(),
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
