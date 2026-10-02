import { Agent } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { readFileSync } from 'node:fs';
import { createNebiusModel } from './model.js';
import { updateMusicFormTool } from './music.js';
import { separateStemsTool } from './stems.js';
import { removeEchoTool } from './dereverb.js';

// Map of sessionId -> Agent instance
const agents = new Map<string, Agent>();

export function getOrCreateAgent(sessionId: string = 'default'): Agent {
  if (agents.has(sessionId)) {
    return agents.get(sessionId)!;
  }

  const model = createNebiusModel();
  model.updateConfig({ maxTokens: 4096 });
  const agent = new Agent({
    model: model,
    tools: [updateMusicFormTool, separateStemsTool, removeEchoTool],
    systemPrompt: readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8').trim(),
    printer: false,
    retryStrategy: null,
  });

  const invoke = agent.invoke.bind(agent);
  agent.invoke = traceable((...args: Parameters<Agent['invoke']>) => invoke(args[0], {
    ...args[1],
    limits: { turns: 4, outputTokens: 8192, totalTokens: 20_000 },
  }), {
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
