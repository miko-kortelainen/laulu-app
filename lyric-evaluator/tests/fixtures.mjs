import { criteria } from '../judge.mjs';

export const input = {
  request: 'Review a short, unfinished English indie-folk lyric. Keep the voice conversational.',
  brief: 'A restrained vocal at 84 BPM. A couple clear out their flat after a separation.',
  lyrics: '[verse]\nyou kept the receipt.\ni kept the bent key.\nwe left the good plates\nfor whoever comes next.',
};

export function assessment() {
  return {
    scores: Object.fromEntries(criteria.map(([key], index) => [key, {
      score: index % 2 ? 3 : 4,
      comment: key === 'ai_slop_avoidance'
        ? 'The receipt and bent key give the scene concrete objects. The final line is less distinctive.'
        : 'Mock editorial assessment for interface and failure-recovery checks.',
      evidence: ['you kept the receipt.'],
    }])),
    strengths: ['The objects suggest a shared life without explaining the separation directly.'],
    improvements: ['Give the closing image a detail that belongs to this particular flat.'],
  };
}

export function completion(value = assessment(), status = 'completed') {
  return { id: 'offline-completion', object: 'interaction', model: 'gemini-4-argon', status,
    steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(value) }] }] };
}
