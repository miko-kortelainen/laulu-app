import { Agent, SlidingWindowConversationManager } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { readFileSync } from 'node:fs';
import { createNebiusModel } from './model.js';
import { updateMusicFormTool } from './music.js';
import { separateStemsTool } from './stems.js';
import { removeEchoTool } from './dereverb.js';
import { analyzeAudioTool } from './analysis.js';

interface AgentSession {
  agent: Agent;
  idleTimer?: NodeJS.Timeout;
  activeInvocations: number;
}

const agents = new Map<string, AgentSession>();
const contextWindowSize = 40;
const idleTimeoutMs = 30 * 60 * 1000;

function scheduleExpiration(sessionId: string, session: AgentSession): void {
  if (session.activeInvocations > 0 || agents.get(sessionId) !== session) return;
  clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => agents.delete(sessionId), idleTimeoutMs).unref();
}

export function getChatContext(sessionId: string): { messages: number; limit: number } {
  return { messages: agents.get(sessionId)?.agent.messages.length ?? 0, limit: contextWindowSize };
}

export function getOrCreateAgent(sessionId: string): Agent {
  const existing = agents.get(sessionId);
  if (existing) {
    scheduleExpiration(sessionId, existing);
    return existing.agent;
  }

  const model = createNebiusModel();
  model.updateConfig({ maxTokens: 4096 });
  const agent = new Agent({
    model: model,
    tools: [updateMusicFormTool, separateStemsTool, removeEchoTool, analyzeAudioTool],
    systemPrompt: readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8').trim(),
    printer: false,
    retryStrategy: null,
    conversationManager: new SlidingWindowConversationManager({ windowSize: contextWindowSize }),
  });

  const session: AgentSession = { agent, activeInvocations: 0 };
  const invoke = agent.invoke.bind(agent);
  agent.invoke = traceable(async (...args: Parameters<Agent['invoke']>) => {
    session.activeInvocations++;
    clearTimeout(session.idleTimer);
    try {
      return await invoke(args[0], {
        ...args[1],
        invocationState: { ...args[1]?.invocationState, userId: sessionId },
        limits: { turns: 6, outputTokens: 12_288, totalTokens: 30_000 },
      });
    } finally {
      session.activeInvocations--;
      scheduleExpiration(sessionId, session);
    }
  }, {
    name: 'musical-copilot',
    run_type: 'chain',
    metadata: { thread_id: sessionId },
  });

  agents.set(sessionId, session);
  scheduleExpiration(sessionId, session);
  return agent;
}

export function resetAgentSession(sessionId: string) {
  clearTimeout(agents.get(sessionId)?.idleTimer);
  agents.delete(sessionId);
}
