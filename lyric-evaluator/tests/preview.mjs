// Offline browser fixture. It cannot call a model or write to LangSmith.
import { createEvaluatorServer } from '../server.mjs';
import { criteria } from '../judge.mjs';
import { assessment } from './fixtures.mjs';

createEvaluatorServer({
  status: () => ({ ready: true, criteria, model: 'mock judge — offline preview', project: 'offline-preview' }),
  evaluate: async input => {
    if (input.request.includes('fail')) throw new Error('Offline judge failure. Your draft is unchanged.');
    await new Promise(resolve => setTimeout(resolve, 400));
    const report = assessment();
    for (const grade of Object.values(report.scores)) grade.evidence = [input.lyrics.split('\n').find(line => line && !line.startsWith('['))];
    return { assessment: { ...report, overall: 3.5 }, model: 'mock judge', project: 'offline-preview', reviewedAt: new Date().toISOString(),
      langsmith: { saved: false, message: 'Offline preview. No model calls or LangSmith writes occurred.' } };
  },
}).listen(4180, '127.0.0.1', () => console.log('Offline evaluator preview: http://127.0.0.1:4180'));
