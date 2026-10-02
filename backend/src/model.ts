import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import dotenv from 'dotenv';
import { wrapOpenAI } from 'langsmith/wrappers/openai';
import OpenAI from 'openai';
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

export function createNebiusModel(modelId?: string): OpenAIModel {
  const apiKey = getApiKey() || 'sk-dummy-key';

  return new OpenAIModel({
    api: 'chat',
    modelId: modelId ?? getModelId(),
    client: wrapOpenAI(new OpenAI({
      apiKey,
      baseURL: getBaseUrl(),
      maxRetries: 0,
    })),
  });
}
