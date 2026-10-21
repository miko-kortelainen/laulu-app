<img src="assets/laulu-wordmark.svg" alt="laulu" width="280" />

An AI music studio at **lau.lu**. Describe a song, refine its lyrics and sound with an AI copilot, and generate full tracks or 30-second previews.

## Features

- **Music Copilot**: Chat with an AI agent to shape your song brief and generate genre-aware lyrics.
- **Song Generation**: Create full tracks with **Lyria 3.5** or 30-second previews with **Lyria 3 Clip Preview**.
- **Audio Analysis**: Upload MP3, WAV, FLAC, or OGG files (up to 50 MB / 10 min) for mix and production feedback.
- **Song Library**: Stream, download, title, favourite, and manage your generated tracks.

## Tech Stack

| Layer | Technology |
| --- | --- |
| **Frontend** | React, Vite, Tailwind CSS |
| **Backend** | Express, TypeScript, Strands Agents SDK, FFmpeg |
| **Database & Auth** | Supabase (PostgreSQL, Auth, Cloudflare Turnstile) |
| **Audio Storage** | Cloudflare R2 (private buckets, signed byte-range streaming) |
| **AI Gateway** | Cloudflare AI Gateway (BYOK): Nebius (chat), QwenCloud (lyrics & analysis), Google AI Studio (Lyria) |
| **Billing** | Paddle Sandbox |

## Quick Start

**Requirements**: Node.js 24, npm, and FFmpeg (`ffmpeg` and `ffprobe` on `PATH`).

1. **Install dependencies**:

   ```bash
   npm run install:all
   ```

2. **Create environment files**:

   ```bash
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env.local
   ```

3. **Configure services & database**:
   Fill in `backend/.env` and `frontend/.env.local` (see [Service Configuration](docs/services.md) and [Quotas & Billing](docs/billing-and-quotas.md)), then push database migrations:

   ```bash
   supabase migration list
   supabase db push --dry-run
   supabase db push
   ```

4. **Start the development servers**:

   ```bash
   npm run dev:backend   # API on http://localhost:3001
   npm run dev:frontend  # App on http://localhost:5173
   ```

## Project Layout

| Path | Contents |
| --- | --- |
| `frontend/src/features/` | Chat, authentication, saved songs, profile, and pricing |
| `frontend/src/components/ui/` | Shared UI components |
| `backend/src/` | HTTP API, agents, audio processing, storage, rate limits, and quotas |
| `backend/prompts/` | System prompts and genre lyric skills |
| `backend/tests/` | Offline regression and integration tests |
| `supabase/migrations/` | PostgreSQL schema and quota/billing functions |

## Checks

Run from the repository root:

```bash
# Build & lint
npm run build
npm --prefix frontend run lint

# Frontend E2E (Playwright, mocked services, no paid calls)
npx --prefix frontend playwright install chromium
npm --prefix frontend run test:e2e

# Backend test suites
npm --prefix backend run test:auth
npm --prefix backend run test:music
npm --prefix backend run test:lyrics
npm --prefix backend run test:analysis
npm --prefix backend run test:audio
npm --prefix backend run test:songs
npm --prefix backend run test:billing
npm --prefix backend run test:gateway
npm --prefix backend run test:local-audio
npm --prefix backend run test:operations
```

See [`backend/package.json`](backend/package.json) for additional suites (`test:agent`, `test:rate-limit`, `test:tracing`, `test:deployment`, `test:quotas:db`).

## Documentation

- [Service Configuration & Runtime](docs/services.md) — Supabase auth, R2 storage, Cloudflare AI Gateway, rate limits, and recovery
- [Quotas & Paddle Billing](docs/billing-and-quotas.md) — Global/plan allowances, token budgets, and sandbox checkout
- [Coolify Deployment](docs/coolify.md) — Production container setup, Doppler secrets, and persistent volumes for `studio.lau.lu`
