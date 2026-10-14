import { Agent, BeforeModelCallEvent, SlidingWindowConversationManager } from '@strands-agents/sdk';
import { traceable } from 'langsmith/traceable';
import { readFileSync } from 'node:fs';
import { createNebiusModel } from './model.js';
import { updateMusicFormTool } from './music.js';
import { analyzeAudioTool } from './analysis.js';
import { audioDirectory, clearUploadedAudio, retainLocalAudio } from './local-audio.js';
import { userDirectory } from './user-files.js';

interface AgentSession {
  agent?: Agent;
  idleTimer?: NodeJS.Timeout;
  activeInvocations: number;
  releaseUploads?: () => void;
  closing?: boolean;
  uploadsEnded?: boolean;
}

const agents = new Map<string, AgentSession>();
const contextWindowSize = 16;
const idleTimeoutMs = 30 * 60 * 1000;

function scheduleExpiration(sessionId: string, session: AgentSession): void {
  if (session.activeInvocations > 0 || agents.get(sessionId) !== session) return;
  clearTimeout(session.idleTimer);
  if (session.uploadsEnded) {
    void endUploadSession(sessionId).catch((error: unknown) => console.error('logout upload cleanup failed:', error));
  }
  session.idleTimer = setTimeout(() => {
    void resetAgentSession(sessionId).catch((error: unknown) => console.error('session upload cleanup failed:', error));
  }, idleTimeoutMs).unref();
}

export function getChatContext(sessionId: string): { messages: number; limit: number } {
  return { messages: agents.get(sessionId)?.agent?.messages.length ?? 0, limit: contextWindowSize };
}

export function retainUploadSession(sessionId: string): () => void {
  const directory = userDirectory(audioDirectory, sessionId);
  const session = agents.get(sessionId) ?? { activeInvocations: 0 };
  if (session.closing) throw new Error('wait for the session cleanup to finish.');
  session.releaseUploads ??= retainLocalAudio(directory);
  session.uploadsEnded = false;
  agents.set(sessionId, session);
  session.activeInvocations++;
  clearTimeout(session.idleTimer);
  return () => {
    session.activeInvocations--;
    scheduleExpiration(sessionId, session);
  };
}

export function getOrCreateAgent(sessionId: string): Agent {
  const existing = agents.get(sessionId);
  if (existing?.closing) throw new Error('wait for the session cleanup to finish.');
  if (existing?.agent) {
    scheduleExpiration(sessionId, existing);
    return existing.agent;
  }

  const model = createNebiusModel();
  const agent = new Agent({
    model: model,
    tools: [updateMusicFormTool, analyzeAudioTool],
    systemPrompt: readFileSync(new URL('../prompts/system.md', import.meta.url), 'utf8').trim(),
    printer: false,
    retryStrategy: null,
    conversationManager: new SlidingWindowConversationManager({ windowSize: contextWindowSize }),
  });
  agent.addHook(BeforeModelCallEvent, async event => {
    const calls = typeof event.invocationState.chatModelCalls === 'number' ? event.invocationState.chatModelCalls : 0;
    const usage = event.agent.metrics.latestAgentInvocation?.usage;
    const outputRemaining = 2048 - (usage?.outputTokens ?? 0);
    const input = await model.countTokens(agent.messages, {
      systemPrompt: agent.systemPrompt, toolSpecs: agent.tools.map(tool => tool.toolSpec),
    }).catch(() => undefined);
    const totalRemaining = 8000 - (usage?.totalTokens ?? 0) - (input ?? 8000);
    if (calls >= 3 || input === undefined || !Number.isFinite(input) || input < 0 || outputRemaining < 1 || totalRemaining < 1) {
      event.cancel = 'this request reached its token budget. shorten your message or start a new chat to continue.';
      return;
    }
    event.invocationState.chatModelCalls = calls + 1;
    // shortcut: input sizing is estimated; use native token counting when Nebius supports it.
    model.updateConfig({ maxTokens: Math.min(2048, outputRemaining, Math.floor(totalRemaining)) });
  });

  const session: AgentSession = existing ?? { activeInvocations: 0 };
  session.agent = agent;
  const invoke = agent.invoke.bind(agent);
  agent.invoke = traceable(async (...args: Parameters<Agent['invoke']>) => {
    session.activeInvocations++;
    clearTimeout(session.idleTimer);
    try {
      return await invoke(args[0], {
        ...args[1],
        invocationState: { ...args[1]?.invocationState, userId: sessionId },
        limits: { turns: 3, outputTokens: 2048, totalTokens: 8000 },
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

export async function endUploadSession(sessionId: string): Promise<void> {
  const session = agents.get(sessionId);
  if (session?.closing) throw new Error('wait for the session cleanup to finish.');
  if (session?.activeInvocations) {
    session.uploadsEnded = true;
    return;
  }
  const releaseUploads = session?.releaseUploads;
  if (session) session.closing = true;
  releaseUploads?.();
  await clearUploadedAudio(sessionId).catch((error: unknown) => {
    if (session) {
      if (releaseUploads) session.releaseUploads = retainLocalAudio(userDirectory(audioDirectory, sessionId));
      session.uploadsEnded = false;
      session.closing = false;
      scheduleExpiration(sessionId, session);
    }
    throw error;
  });
  if (session) {
    session.releaseUploads = undefined;
    session.uploadsEnded = false;
    session.closing = false;
  }
}

export async function resetAgentSession(sessionId: string): Promise<void> {
  const session = agents.get(sessionId);
  if (session?.activeInvocations || session?.closing) throw new Error('wait for the current action to finish.');
  clearTimeout(session?.idleTimer);
  if (session?.releaseUploads) await endUploadSession(sessionId);
  agents.delete(sessionId);
}
