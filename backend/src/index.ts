import express, { Request, Response } from 'express';
import cors from 'cors';
import { getOrCreateAgent, resetAgentSession, getModelConfig } from './agent.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health & Status
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    config: getModelConfig(),
  });
});

// Chat endpoint
app.post('/api/chat', async (req: Request, res: Response) => {
  const { message, sessionId = 'default' } = req.body;

  if (!message || typeof message !== 'string' || message.trim() === '') {
    res.status(400).json({ error: 'Message is required.' });
    return;
  }

  try {
    const agent = getOrCreateAgent(sessionId);
    const result = await agent.invoke(message.trim());
    res.json({ reply: result.toString() });
  } catch (error: any) {
    console.error('Agent invocation error:', error);
    res.status(500).json({
      error: error.message || 'Failed to process message with agent',
      reply: `Agent Error: ${error.message || 'Unknown error'}`,
    });
  }
});

// Reset endpoint
app.post('/api/reset', (req: Request, res: Response) => {
  const { sessionId = 'default' } = req.body;
  resetAgentSession(sessionId);
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  const config = getModelConfig();
  console.log(`Backend running on http://localhost:${PORT}`);
  console.log(`Nebius Model: ${config.model}`);
  console.log(`API key configured: ${config.apiKeyConfigured ? 'Yes' : 'No'}`);
});
