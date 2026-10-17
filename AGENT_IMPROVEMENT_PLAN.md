# Agent improvement plan

Status: Phase 1 has text checks, section counters, and offline regression coverage.
Section-length enforcement remains deferred until explicit scope and per-section requirements exist.
Phases 2 and 3 remain proposed.

## Purpose

Make agent behavior more reliable without extra agents, dependencies, or automatic paid retries.
Start with lyric output checks and duplicated prompt instructions.
Add specialist skills only after recurring failures show a need.

Source: [Harness²: Recursive Agent Harnessing for an Open World](https://arxiv.org/abs/2610.14224), version 1.
The repository copy is [2610.14224v1.pdf](2610.14224v1.pdf).
Relevant sections are §2.2.1, Appendix D.3, Appendix E.1, Appendix F, and Appendix H.
The paper evaluates professional tasks, not music quality. Its results do not establish gains for this project.

## Current behavior

- [agent.ts](backend/src/agent.ts) enforces model-call and token budgets.
- [music.ts](backend/src/music.ts) accepts structured form updates and limits lyric attempts per message.
- [lyrics.ts](backend/src/lyrics.ts) loads lyric instructions only for lyric requests.
- [analysis.ts](backend/src/analysis.ts) loads listening instructions outside the main agent context and limits analysis attempts.
- [index.ts](backend/src/index.ts) keeps audio generation behind an explicit user request to `/api/music`.
- The lyric and music tests use mocked provider responses. They do not establish real model instruction compliance.

Generated lyrics currently pass through a 3,000-character slice before the form update.
Code checks text types, empty output, and size limits.
Prompts carry section lengths, line formatting, creative guidance, and preservation instructions.

## Constraints

- Preserve manual edits and supplied lyric text, including casing and line breaks.
- Preserve the current form after lyric generation fails.
- Keep one lyric or analysis attempt per message.
- Keep existing token budgets, allowance handling, and audio confirmation behavior.
- Keep paid model calls disabled without explicit user authorization.
- Keep changes inside existing backend modules unless a separate responsibility requires a small module.
- Do not add a middleware framework, skill registry, or general script runner.

## Phase 1: Define and check the lyric output contract

Files: `backend/src/lyrics.ts`, `backend/src/music.ts`, `backend/prompts/lyrics.md`, and `backend/tests/lyrics.test.ts`.
Inspect callers and existing regression cases before edits.

- [x] Classify lyric rules as hard limits, format preferences, or creative guidance.
- [x] Record which rules apply to new drafts, revised sections, and untouched supplied text.
- [x] Add small deterministic functions for character counts and section-line counts.
- [x] Exclude blank lines and section tags from lyric-line counts.
- [ ] Enforce section lengths from explicit scope and per-section requirements. Deferred until these structured inputs exist.
- [x] Keep ambiguous scope and creative guidance advisory.
- [x] Return specific errors for enforceable contract failures before committing the form.
- [x] Preserve the existing form on those failures.
- [x] Add focused offline cases for the new checks and failure recovery.

The first implementation must preserve the accepted partial-output and 3,000-character truncation behavior.
That behavior can cut a line or section. Record this limitation in the affected code and documentation.
Any later replacement must define partial-output behavior and update its regression cases in the same change.

Do not apply lowercase or punctuation transformations to the whole lyric draft.
Do not infer revision scope with keyword matching.
Exact preservation outside an edit needs explicit scope or an exact comparison target.
Until that scope exists, do not claim that a validator guarantees targeted preservation.

Completion criteria:

- Hard checks have explicit inputs, outputs, and failure behavior.
- Valid supplied text survives unchanged.
- User format overrides take precedence over default section and style rules.
- Contract failures preserve the form without another paid attempt.
- Partial-output regression cases retain their accepted behavior.

## Phase 2: Reduce duplicated prompt instructions

Files: `backend/prompts/system.md`, `backend/prompts/music-form.md`, and `backend/prompts/lyrics.md`.
Inspect `backend/src/agent.ts`, `backend/src/music.ts`, and `backend/src/lyrics.ts` for prompt loading.

- [ ] Keep routing, tool selection, honest status reports, and chat behavior in `system.md`.
- [ ] Keep field meanings and the form-update contract in `music-form.md`.
- [ ] Keep lyric composition and revision guidance in `lyrics.md`.
- [ ] Keep listening guidance in `analysis.md`.
- [ ] Remove duplicate paragraphs where one authoritative instruction covers the same behavior.
- [ ] Preserve short reminders that prevent a documented recurring failure.
- [ ] Record prompt word counts before and after the change.
- [ ] Restart the backend or reset cached agents before any live comparison.

Keep universal tool rules available to the main agent.
Splitting files alone does not reduce context. Conditional loading must occur in the runtime.
Prompt word counts show text size, not exact provider tokens or proven performance gains.

Completion criteria:

- Each instruction has a clear owner.
- The main agent retains enough guidance to select and call its tools.
- Lyric and listening instructions retain their existing conditional loading.
- No new model call is necessary to retrieve existing guidance.

## Phase 3: Compare behavior before adopting changes

Use the same requests, initial forms, model configuration, and limits for each comparison.
Change one concern at a time.

| Case | Expected result |
| --- | --- |
| Change only the tempo | Only the tempo changes. No lyric call occurs. |
| Create a lyric draft | The tool updates the form. Applicable lyric checks pass. |
| Revise one chorus | Untouched text stays exact. |
| Supply mixed-case lyrics | Casing and line breaks stay exact. |
| Request a custom section length | The explicit request overrides default section lengths. |
| Request instrumental music | The form has empty lyrics and explicit instrumental direction. |
| Supply an artist reference | Generated directions use musical traits instead of artist names. |
| Ask for general music advice | The agent answers without changing the form. |
| Trigger a lyric failure | The form stays unchanged. No second lyric attempt occurs. |
| Trigger an analysis failure | Existing audio and form stay unchanged. No second analysis attempt occurs. |

- [ ] Extend existing offline backend tests for changed deterministic behavior.
- [ ] Run `npm --prefix backend run test:lyrics` for lyric changes.
- [ ] Run `npm --prefix backend run test:music` for form-boundary changes.
- [ ] Run `npm --prefix backend run test:agent` for agent configuration changes.
- [ ] Run `npm run build:backend` after TypeScript changes.
- [ ] Run `git diff --check` after edits.
- [ ] Report offline results separately from real model results.

Real model comparisons require explicit authorization for paid calls.
Record tool selection, form differences, preserved text, paid-call counts, and token use.
Repeat uncertain cases before attributing a difference to a prompt change.
Human review remains necessary for lyric quality, phrasing, and genre fit.

No frontend change is planned. Add frontend E2E coverage only if visible behavior changes beyond existing coverage.

## Deferred work

| Idea | Trigger for implementation | Smallest useful approach |
| --- | --- | --- |
| Genre or language skills | Repeated failures require a concrete specialist procedure. | Load one selected procedure during the relevant tool operation. |
| Tool-loop hooks | Repeated traces show that clear instructions fail on a mechanical rule. | Add one focused hook with a bounded failure path. |
| Success acknowledgments from code | Traces show false or repetitive form-update claims. | Derive the acknowledgment from the successful tool result or form differences. |
| Tempo and duration arithmetic | A requested feature needs exact bar or duration calculations. | Use a pure function with explicit tempo, meter, units, and tempo-change assumptions. |
| Signal measurements | Users need measured duration, peaks, or loudness. | Extend existing FFmpeg/ffprobe processing with explicit measurement definitions. |

Skill files need a runtime loading path and an explicit trigger.
A directory of Markdown files alone does not provide skills to this agent.

Syllable counts, stress, singability, and complete artist-name detection remain uncertain semantic tasks.
Do not represent generic regex checks or syllable heuristics as exact guarantees.

## Delivery order

1. Implement the scoped lyric checks with focused offline coverage.
2. Simplify duplicated prompts as a separate change.
3. Compare behavior before retaining either change.
4. Revisit deferred work only after evidence establishes a specific need.

Automatic harness rewriting, recursive candidate generation, and cross-user learning are outside this plan.
