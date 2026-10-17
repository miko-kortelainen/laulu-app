import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

export const criteria = [
  ['ai_slop_avoidance', 'AI cliché avoidance'],
  ['natural_phrasing', 'Natural phrasing'],
  ['singability', 'Singability'],
  ['structure_and_rhyme', 'Structure & rhyme'],
  ['narrative_coherence', 'Narrative coherence'],
  ['brief_adherence', 'Brief adherence'],
];

const rubric = readFileSync(new URL('./rubric.md', import.meta.url), 'utf8');
const completionTokens = 32768;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function readInput(value) {
  if (!isRecord(value)) throw new Error('Enter a request, a brief, and lyrics.');
  const input = {};
  for (const [key, limit] of [['request', 10000], ['brief', 10000], ['lyrics', 30000], ['originalLyrics', 30000]]) {
    if (key === 'originalLyrics' && value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || (key !== 'originalLyrics' && !value[key].trim()) || value[key].length > limit) {
      throw new Error(`${key} must be text${key === 'originalLyrics' ? '' : ' with some content'}, at most ${limit.toLocaleString('en-US')} characters.`);
    }
    input[key] = value[key];
  }
  return input;
}

function readAssessment(value, lyrics) {
  if (!isRecord(value) || !isRecord(value.scores)) throw new Error('The judge returned an invalid review.');
  const scores = {};
  for (const [key] of criteria) {
    const grade = value.scores[key];
    if (!isRecord(grade) || !Number.isInteger(grade.score) || grade.score < 1 || grade.score > 5 ||
      typeof grade.comment !== 'string' || !grade.comment.trim() || !Array.isArray(grade.evidence) ||
      grade.evidence.length > 2 || grade.evidence.some(quote => typeof quote !== 'string' || !quote.trim() || !lyrics.includes(quote))) {
      throw new Error(`The judge returned an invalid score or unsupported quote for ${key}.`);
    }
    scores[key] = { score: grade.score, comment: grade.comment, evidence: grade.evidence };
  }
  for (const key of ['strengths', 'improvements']) {
    if (!Array.isArray(value[key]) || value[key].length > 3 || value[key].some(item => typeof item !== 'string' || !item.trim())) {
      throw new Error(`The judge returned invalid ${key}.`);
    }
  }
  const overall = Math.round(criteria.reduce((sum, [key]) => sum + scores[key].score, 0) / criteria.length * 100) / 100;
  return { scores, overall, strengths: value.strengths, improvements: value.improvements };
}

export function createJudge({ apiKey }) {
  if (!apiKey?.trim()) throw new Error('Set GEMINI_API_KEY in lyric-evaluator/.env.');
  return new GoogleGenAI({ apiKey: apiKey.trim(), vertexai: false });
}

export async function reviewLyrics(input, client, model) {
  const response = await client.interactions.create({
    // Reasoning tokens and the final JSON share this completion budget.
    model, input: JSON.stringify(readInput(input)), system_instruction: rubric, store: false,
    generation_config: { max_output_tokens: completionTokens, thinking_level: 'medium' },
    response_format: { type: 'text', mime_type: 'application/json' },
  }, { timeout: 1_200_000, maxRetries: 0 });
  const steps = Array.isArray(response.steps) ? response.steps : [];
  const output = steps.findLast(step => step.type === 'model_output');
  const content = output?.content?.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
  const hasReasoning = steps.some(step => step.type === 'thought');
  if (response.status !== 'completed' || !content.trim()) {
    console.error('lyric judge returned an incomplete response:', {
      model, status: response.status ?? null,
      outputTokens: response.usage?.total_output_tokens,
      reasoningTokens: response.usage?.total_thought_tokens,
      contentCharacters: content.length, hasReasoning,
    });
    let message;
    if (response.status === 'incomplete') message = `The judge reached its ${completionTokens.toLocaleString('en-US')}-token completion limit before finishing the review.`;
    else if (response.status === 'failed') message = 'The judge failed to complete this review.';
    else if (hasReasoning && !content.trim()) message = 'The judge returned reasoning without a final review.';
    else message = 'The judge did not return a complete final review.';
    throw new Error(`${message} No automatic retry was made.`);
  }
  const value = JSON.parse(content);
  return readAssessment(value, input.lyrics);
}
