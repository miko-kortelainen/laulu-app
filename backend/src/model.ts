import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import dotenv from 'dotenv';
import { wrapOpenAI } from 'langsmith/wrappers/openai';
import OpenAI from 'openai';
import path from 'path';
import { fileURLToPath } from 'url';
import { getAiGateway } from './gateway.js';

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
  const gateway = getAiGateway('nebius');
  if (gateway) return gateway.baseURL;
  return (process.env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1').trim();
}

export function getModelId(): string {
  return (process.env.NEBIUS_MODEL || 'nvidia/nemotron-3-super-120b-a12b').trim();
}

export function isApiKeyConfigured(): boolean {
  const key = getApiKey();
  if (getAiGateway('nebius')) return true;
  return Boolean(key && key !== 'your_nebius_api_key_here');
}

export function getModelConfig() {
  return {
    apiKeyConfigured: isApiKeyConfigured(),
    baseURL: getBaseUrl(),
    model: getModelId(),
  };
}

export function createNebiusModel(modelId?: string): OpenAIModel {
  const apiKey = getApiKey() || 'sk-dummy-key';
  const selectedModel = modelId ?? getModelId();
  const gateway = getAiGateway('nebius', selectedModel);

  return new OpenAIModel({
    api: 'chat',
    modelId: selectedModel,
    client: wrapOpenAI(new OpenAI({
      apiKey: gateway ? 'byok' : apiKey,
      baseURL: getBaseUrl(),
      fetch: gateway?.fetch,
      maxRetries: 0,
    })),
  });
}
