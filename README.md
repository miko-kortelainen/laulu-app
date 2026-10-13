# laulu / lau.lu

An AI music studio. Describe a song, refine its lyrics and sound, then generate it.

- Chat with a music copilot and edit the song brief.
- Generate full songs with Lyria 3.5 or 30-second clips with Lyria 3 Clip Preview.
- Set a song title in the music generation form. Blank titles are saved as `untitled`.
- Upload audio for analysis and production feedback.
- Save, play, download, and delete your own songs.

The frontend uses React, Vite, and Tailwind CSS. The backend uses Express, TypeScript, and the Strands Agents SDK.
Supabase provides authentication and metadata. Private Cloudflare R2 storage holds saved songs.
All hosted AI calls use Cloudflare AI Gateway BYOK: Nebius for chat and lyrics, Google for music, and QwenCloud for analysis.

## Local development

Requirements: Node.js 24, npm, and FFmpeg with `ffmpeg` and `ffprobe` on `PATH`.

1. Install dependencies from the repository root:

   ```bash
   npm run install:all
   ```

2. Create the environment files from the examples. Keep existing files if they already exist.

   ```bash
   cp backend/.env.example backend/.env
   cp frontend/.env.example frontend/.env.local
   ```

3. Configure the services described in the next sections.
4. Start the backend:

   ```bash
   npm run dev:backend
   ```

5. In another terminal, start the frontend:

   ```bash
   npm run dev:frontend
   ```

6. Open `http://localhost:5173`. The backend listens on port `3001`.

Restart the development servers after environment changes. Keep secrets out of Git and all `VITE_` variables.

### Configure authentication

1. Enable Supabase email/password authentication, open registration, and email confirmation.
2. Set the development Site URL to `http://localhost:5173` and allow `http://localhost:5173/` as a redirect URL.
3. Keep the standard email templates that use `{{ .ConfirmationURL }}`.
4. Configure custom SMTP before public use.
5. Set `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` in `backend/.env`.
6. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `frontend/.env.local` for the same project.
7. Run the SQL files in [supabase/migrations](supabase/migrations) in filename order, including the terms acceptance migration.
8. Set `SUPABASE_SECRET_KEY` in `backend/.env` for database access. Keep this key on the backend.

For public deployment, configure the production origin for email redirects.
Enable Supabase Turnstile enforcement and set `VITE_TURNSTILE_SITE_KEY` to the matching public site key.
Local development can leave the site key empty.

Users must confirm they are 18 or older and accept the current terms before using the studio.
The frontend checks terms acceptance with `GET /api/terms` and records it with `POST /api/terms`.
The backend uses the authenticated user ID and stores the terms version and acceptance time in Supabase.
Chat, analysis through chat, and music generation require current terms acceptance on the backend.
Age is self-declared; the app does not collect birth dates or verify identity documents.
Keep `TERMS_VERSION` in `backend/src/terms.ts` and `frontend/src/lib/terms.ts` in sync when the terms change.

### Configure generated-song storage

1. Create a private Cloudflare R2 bucket with public access disabled.
2. Create credentials with object read/write access for that bucket.
3. Set `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in `backend/.env`.

Saved songs use private R2 objects and Supabase metadata. Playback and downloads require authentication.
If storage fails, use **retry saving** to save the existing audio without another generation call.
Apply [the song title migration](supabase/migrations/20261013123303_song_titles.sql) before deploying the title field.
It adds `songs.title`, sets existing song titles to `untitled`, and updates the metadata save function.

### Configure usage quotas

Set positive `GLOBAL_CHAT_DAILY`, `GLOBAL_ANALYSIS_DAILY`, and `GLOBAL_GENERATION_DAILY` limits in `backend/.env`.
The example values are `200`, `30`, and `20`. Missing or zero values disable the corresponding paid operation.

New users receive 20 chat messages, 10 analyses, 5 songs per UTC day, and 512 MiB of song storage by default.
The `QUOTA_*` values configure new users. Existing user allowances live in `public.user_quotas`.
Shared limits also apply. Daily usage resets at midnight UTC.

### Configure sandbox pricing and checkout

The public `/pricing` page shows free, starter, pro, and ultra plans.
Paid prices come from Paddle's localized price preview. Checkout requires login and uses the Paddle sandbox only.
The monthly plan allowances shown are 30, 80, and 180 songs. Sandbox purchases do not activate these allowances;
the existing free beta limits remain in effect. Subscription webhooks and paid-plan enforcement are not implemented.

Set these public values in `frontend/.env.local`:

```dotenv
VITE_PADDLE_CLIENT_TOKEN=test_your_public_client_token
VITE_PADDLE_STARTER_PRICE_ID=pri_01m4tvkjam9nptz0f1ngrbr9mj
VITE_PADDLE_PRO_PRICE_ID=pri_01m4tvmm85j15s4vjd9ykmsa0d
VITE_PADDLE_ULTRA_PRICE_ID=pri_01m4tvnr6xfnyk1nwtyt5vma9e
```

These existing sandbox prices are $9, $19, and $39 USD per month, with no trial.
The ultra price belongs to the Paddle product named `Advanced`.
The page includes applicable tax for the detected location; checkout confirms the total for the billing address.
Use a `test_` client token from Paddle's sandbox authentication settings. Never put a Paddle API key in a `VITE_` variable.
Set the default payment link in the sandbox checkout settings to a URL that serves this app, such as `http://localhost:5173/pricing`.
Sandbox checkout uses [Paddle test cards](https://developer.paddle.com/concepts/payment-methods/credit-debit-card#test-cards).
Restart the frontend after changing its environment values.

### Configure Cloudflare AI Gateway

1. Enable authentication on the gateway.
2. Create the custom providers:

   | Provider | Default slug | Base URL |
   | --- | --- | --- |
   | Nebius | `nebius` | `https://api.tokenfactory.nebius.com` |
   | QwenCloud | `qwencloud` | `https://maas.qwencloudapi.com` |

   Use these root URLs. The backend adds each provider's API path.
   Google uses the built-in `google-ai-studio` provider.

3. Store each provider key in the gateway's **Provider Keys** with the `default` alias.
4. Set `CF_AI_GATEWAY_ACCOUNT_ID`, `CF_AI_GATEWAY_ID`, and `CF_AI_GATEWAY_TOKEN` in `backend/.env`.
   The token needs the **AI Gateway - Run** permission.
5. If the custom provider slugs differ, set `CF_AI_GATEWAY_NEBIUS_SLUG` and `CF_AI_GATEWAY_QWENCLOUD_SLUG`.
   Omit the `custom-` prefix.

Provider keys stay in Cloudflare. The backend requires the gateway for every hosted AI call.
Chat, lyric generation, audio analysis, and music generation incur provider charges.
The **generate song** button starts music generation from the edited brief.

## Storage and recovery

Uploads accept mono or stereo MP3, WAV, FLAC, and OGG files, up to 50 MB and 10 minutes.
Uploads stay local and expire after a new session, logout, inactivity, or a backend restart.
Saved songs remain available until you delete them. Chat history does not persist across backend restarts.

Run one backend instance. Keep `backend/generated-music/` on persistent storage for unfinished songs and operation recovery.
Unknown provider outcomes retain their allowance charge and never trigger automatic paid retries.

## Project layout

| Path | Contents |
| --- | --- |
| `frontend/src/features/` | Chat, authentication, saved songs, profile, and pricing |
| `frontend/src/components/ui/` | Shared UI components |
| `backend/src/` | HTTP API, agents, audio, storage, and quotas |
| `backend/prompts/` | Chat, song brief, lyrics, and analysis instructions |
| `supabase/migrations/` | Database migrations |

Restart the backend after prompt changes.

## Checks

Run commands from the repository root:

```bash
npm run build
npm --prefix frontend run lint
npm --prefix frontend run test:all
npm --prefix backend run test:auth
npm --prefix backend run test:music
npm --prefix backend run test:lyrics
npm --prefix backend run test:analysis
npm --prefix backend run test:audio
npm --prefix backend run test:songs
```

Frontend checks require the `agent-browser` CLI. These checks use mocked services and make no paid AI calls.
Audio checks require FFmpeg. Additional backend checks are listed in [backend/package.json](backend/package.json).

## Deployment

See [COOLIFY.md](COOLIFY.md) for deployment at `studio.lau.lu`, environment configuration, persistent storage, and backups.
The Docker image includes FFmpeg and serves both the frontend and API.
Production tracing is disabled. Development tracing is optional through `LANGSMITH_*` values in the backend environment example.
