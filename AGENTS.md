# Repository guidelines

These instructions apply to the entire monorepo.

## Structure

- Keep frontend code in `frontend/` and backend code in `backend/`.
- Keep frontend features in `frontend/src/features/<feature>/`.
- Keep each feature's UI, state hook, and API functions together.
- Keep `App.tsx` limited to application composition.
- Keep shared UI components in `frontend/src/components/ui/`.
- Keep shared utilities in `frontend/src/lib/`.
- Keep HTTP routes in `backend/src/index.ts` and agent configuration in `backend/src/agent.ts`.
- Import specific files directly. Do not add barrel files or dependencies between unrelated features.

## Minimal, readable code

- Read the affected flow and its callers before editing.
- Reuse existing code, native platform features, and installed dependencies first.
- Write the smallest complete solution.
- Remove dead code and obsolete imports from the affected files.
- Give each module one clear responsibility.
- Split a file when it mixes responsibilities, not to meet an arbitrary line limit.
- Keep small related functions together. Do not create folders for single files.
- Use descriptive names, early returns, and explicit types at module boundaries.
- Use `unknown` for untrusted values and caught errors. Do not add `any`.
- Separate logical sections with blank lines.
- Keep JSX and conditional class names readable.
- Comment only non-obvious decisions and constraints.
- Do not add speculative abstractions, generic frameworks, or configuration for hypothetical needs.
- Do not add dependencies when existing code or the platform covers the requirement.

## Async code and state

- Use `async` functions and `await` for asynchronous operations.
- Handle expected promise failures with a focused `.catch()` at the operation boundary.
- Do not replace error handling with an unhandled `await`.
- Avoid broad `try/catch` blocks around unrelated operations.
- Preserve existing error handling inside library components.
- Keep API calls out of presentational components.
- Keep feature state and user actions in the feature hook.
- Check HTTP status and response data before committing state.
- Preserve valid state when an operation fails.
- Prevent overlapping actions that modify the same conversation.
- Report failures clearly. Do not silently substitute fake success or demo data.

## Components and styling

- Treat `components/ui/` as the shared component library.
- Configure library components through their existing props first.
- Do not remove library APIs merely because this app uses one variant.
- Share application components when multiple callers need the same behavior.
- Keep feature-specific components inside their feature.
- Preserve keyboard access, focus states, labels, and disabled states.
- Use the existing Tailwind system and `cn()` helper for conditional classes.
- Preserve consistent spacing, alignment, typography, and colors.
- Keep agent prose short, natural, and lowercase.
- Preserve required casing in code, commands, paths, URLs, and exact quotations.

## Scope and checks

- Preserve unrelated changes and established behavior.
- Keep secrets in environment variables. Do not print or commit `.env` contents.
- Do not make paid model calls without explicit user authorization.
- Keep package manifests and lockfiles consistent.
- Update documentation when file structure or behavior changes.
- Obey user limits on tests, builds, and other checks.
- Use only end-to-end tests for the frontend. Do not add frontend unit or component tests.
- Cover real user flows, visible results, and failure recovery in frontend end-to-end tests.
- If checks are permitted, run only those required for the changed behavior.
- Do not add tests for trivial changes or duplicate existing coverage.
- State which checks ran and which checks remain unrun.

## Commands

Run these commands from the repository root:

- `npm run dev:frontend`: start the frontend.
- `npm run dev:backend`: start the backend.
- `npm run build:frontend`: compile and build the frontend.
- `npm run build:backend`: compile the backend.
- `npm --prefix frontend run lint`: run the frontend linter.
