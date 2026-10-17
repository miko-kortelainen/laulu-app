# Lyric review

A standalone local web interface for lyric quality reviews, with scores in a separate LangSmith project.
This tool does not import, start, or modify the music application.
It has its own dependencies and configuration.

## Start

Use Node.js 22.9 or newer.

```sh
cd lyric-evaluator
npm ci
cp .env.example .env
```

Add your Gemini API key and LangSmith API key to `.env`:

```text
GEMINI_API_KEY=your-gemini-api-key
LANGSMITH_API_KEY=your-langsmith-api-key
```

The evaluator calls the Gemini API directly through the official `@google/genai` SDK.
Keep both keys on the server. They are not sent to the browser.

Select the judge with `LYRIC_EVAL_MODEL`.
The default is `gemini-4-argon` ([Gemini 4 Argon](https://ai.google.dev/gemini-api/docs/models/gemini-4-argon)).
Use `LANGSMITH_ENDPOINT` and `LANGSMITH_WORKSPACE_ID` for the correct LangSmith environment.

```sh
npm start
```

Open **http://127.0.0.1:3002**.
The server binds to the local computer only. This version has no public-hosting authentication.

## Review lyrics

1. Enter the song brief and the intended task.
2. Paste the candidate lyrics.
3. For a revision, optionally add the original lyrics.
4. Select **review lyrics**.

Each submission makes one paid judge call. There are no automatic model retries or lyric rewrites.
The completion limit is 32,768 tokens, shared between model reasoning and the final JSON review.
Thinking is set to `medium`. The request timeout is 20 minutes.
This is a maximum, not a fixed token charge. Reasoning models can use much of this budget before answering.
Requests use `store: false` to disable Gemini interaction storage.
Input text, including optional originals, and the review go to the judge and LangSmith.
The tool does not reserve or change any main-app allowance.

The review contains six scores from 1 to 5. Higher always means better:

- AI cliché avoidance
- Natural phrasing
- Singability
- Structure and rhyme
- Narrative coherence
- Brief adherence

Each score has an explanation and up to two exact lyric excerpts.
The overall score is the unweighted mean, calculated in code.
LangSmith receives one run with seven feedback entries: the six criteria and the overall score.
The default project is `lyric-quality-evaluator`. Change it with `LYRIC_EVAL_PROJECT`.

The rubric is in [rubric.md](rubric.md).
AI cliché avoidance describes writing patterns. It does not detect AI authorship.
Singability is a text-only estimate. The tool does not hear a melody.
Scores are editorial judgments and need human calibration before they become quality thresholds.

If LangSmith fails, the interface still shows the review.
Use **download report** to keep it without another paid call.
The browser keeps drafts and results only while the page remains open.

For judge failures, the interface shows guidance for the returned HTTP status.
The server terminal records provider diagnostics with the Gemini API key redacted.
Incomplete-response diagnostics include the interaction status and available token counts, without lyric text or model reasoning.
After changing `.env`, restart the evaluator process before another review.

## Offline checks

```sh
npm test
```

The tests use mocked judge responses and mocked LangSmith writes.
They cover input limits, response shape, exact quote evidence, score arithmetic, Gemini authentication, and failure recovery.
HTTP tests cover concurrent requests and the local-origin boundary.
They do not establish judge quality or live provider compatibility.

For a browser check without paid calls:

```sh
node tests/preview.mjs
```

Open **http://127.0.0.1:4180**. The interface identifies the offline preview in its settings.
