const form = document.querySelector('#review-form');
const fields = document.querySelector('#fields');
const submit = document.querySelector('#submit');
const status = document.querySelector('#status');
const error = document.querySelector('#error');
const review = document.querySelector('.review');
let criteria = [];
let report;

function element(tag, text, className) {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

fetch('/api/config').then(async response => {
  if (!response.ok) throw new Error('Could not load evaluator settings. Reload the page to try again.');
  const config = await response.json();
  criteria = config.criteria;
  document.querySelector('#configuration').textContent = `judge / ${config.model}\nlangsmith / ${config.project}`;
  if (!config.ready) {
    const setup = document.querySelector('#setup');
    setup.textContent = `Before your first review, add ${config.missing.join(', ')} to lyric-evaluator/.env and restart the tool.`;
    setup.hidden = false;
  }
}).catch(cause => { error.textContent = cause.message; });

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled) return;
  if (criteria.length !== 6) {
    error.textContent = 'Evaluator settings are unavailable. Reload the page before submitting a paid review.';
    return;
  }
  const input = Object.fromEntries(new FormData(form));
  if (!input.originalLyrics.trim()) delete input.originalLyrics;
  error.textContent = '';
  status.textContent = report ? 'Reviewing this draft. Your previous review stays below until this finishes.' : 'Reading the draft and preparing your review…';
  fields.disabled = true;
  submit.disabled = true;
  review.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/evaluate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not complete the review. Your draft is unchanged.');
    if (!Number.isFinite(result.assessment?.overall) || criteria.length !== 6 ||
      !criteria.every(([key]) => Number.isInteger(result.assessment.scores?.[key]?.score))) {
      throw new Error('The server returned an incomplete review. Your draft is unchanged.');
    }
    showReview(result);
    report = { input, ...result };
    status.textContent = 'Review complete. Your lyrics are unchanged.';
  } catch (cause) {
    status.textContent = '';
    error.textContent = cause.message || 'Could not connect to the evaluator. Your draft is unchanged.';
  } finally {
    fields.disabled = false;
    submit.disabled = false;
    review.setAttribute('aria-busy', 'false');
  }
});

function showReview(result) {
  const assessment = result.assessment;
  const scores = document.querySelector('#scores');
  scores.replaceChildren();
  for (const [key, label] of criteria) {
    const grade = assessment.scores[key];
    const section = element('section', '', 'score');
    const title = element('div', '', 'score-title');
    title.append(element('h3', label), element('b', `${grade.score} / 5`));
    section.append(title, element('p', grade.comment));
    for (const quote of grade.evidence) section.append(element('blockquote', quote));
    scores.append(section);
  }
  document.querySelector('#overall-score').textContent = assessment.overall.toFixed(2);
  document.querySelector('#review-context').textContent = `Submitted ${new Date(result.reviewedAt).toLocaleString()}. Scores are editorial judgments, not objective measurements.`;
  for (const key of ['strengths', 'improvements']) {
    const list = document.querySelector(`#${key}`);
    list.replaceChildren(...assessment[key].map(text => element('li', text)));
    if (!assessment[key].length) list.append(element('li', 'No additional notes.'));
  }
  document.querySelector('#save-status').textContent = result.langsmith.saved
    ? `Saved to LangSmith · ${result.project}` : result.langsmith.message;
  const link = document.querySelector('#langsmith-link');
  const url = result.langsmith.url && new URL(result.langsmith.url);
  const allowed = url?.protocol === 'https:' && url.hostname.endsWith('.langchain.com');
  link.hidden = !allowed;
  if (allowed) link.href = url.href;
  document.querySelector('#empty').hidden = true;
  document.querySelector('#results').hidden = false;
}

document.querySelector('#download').addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'lyric-review.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
