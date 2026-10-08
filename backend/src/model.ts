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

// Keep production beta conversations out of LangSmith even if an old setting enables tracing.
if (process.env.NODE_ENV === 'production') process.env.LANGSMITH_TRACING = 'false';

export function getModelId(): string {
  return (process.env.NEBIUS_MODEL || 'nvidia/nemotron-3-super-120b-a12b').trim();
}

export function getModelConfig() {
  return {
    baseURL: getAiGateway('nebius').baseURL,
    model: getModelId(),
  };
}

export function createNebiusModel(modelId?: string): OpenAIModel {
  const selectedModel = modelId ?? getModelId();
  const gateway = getAiGateway('nebius', selectedModel);

  return new OpenAIModel({
    api: 'chat',
    modelId: selectedModel,
    client: wrapOpenAI(new OpenAI({
      apiKey: 'byok',
      baseURL: gateway.baseURL,
      fetch: gateway.fetch,
      maxRetries: 0,
    })),
  });
}
