# Nebius Nemotron Super AI Chatbot

A simple full-stack AI chatbot built with:
- **Frontend:** Vite + React + Tailwind CSS v4
- **Backend:** Node.js + TypeScript (Express)
- **AI Agent Framework:** [Strands Agents SDK](https://github.com/strands-agents/sdk-typescript) (`@strands-agents/sdk`)
- **LLM / Inference:** [Nebius Token Factory](https://tokenfactory.nebius.com) running NVIDIA Nemotron Super (`nvidia/nemotron-3-super-120b-a12b`)

---

## Architecture Overview

```
├── backend/
│   ├── prompts/
│   │   ├── system.md      # Agent behavior and reply style
│   │   ├── music-form.md  # Music form tool instructions
│   │   ├── lyrics.md      # Dedicated lyric agent instructions
│   │   └── analysis.md    # Detailed Qwen listening analysis instructions
│   ├── src/
│   │   ├── agent.ts       # Strands Agent setup with OpenAIModel pointing to Nebius Token Factory
│   │   ├── auth.ts        # Supabase access token verification
│   │   ├── database.ts    # Server-only Supabase database client
│   │   ├── quotas.ts      # Durable paid-operation allowances and storage reservations
│   │   ├── user-files.ts  # Per-user local audio directories
│   │   ├── model.ts       # Shared Nebius configuration and model setup
│   │   ├── gateway.ts     # Required Cloudflare AI Gateway BYOK routing
│   │   ├── lyrics.ts      # Dedicated GLM lyric agent
│   │   ├── music.ts       # Music prompt tool and confirmed Lyria 3.5 generation
│   │   ├── songs.ts       # Generated-song ownership, metadata, and storage recovery
│   │   ├── r2.ts          # Private Cloudflare R2 object reads and writes
│   │   ├── audio.ts       # Audio uploads, validation, and analysis conversion
│   │   ├── analysis.ts    # QwenCloud listening analysis tool
│   │   └── index.ts       # Express server with /api/chat and /api/health endpoints
│   ├── audio-processing/ # Python upload validation and analysis conversion
│   ├── .env.example       # Sample environment variables
│   ├── .env               # Active Cloudflare gateway configuration
│   ├── package.json
│   └── tsconfig.json
│
└── frontend/
    ├── src/
    │   ├── App.tsx        # Application composition
    │   ├── features/chat/ # Chat page, message UI, state hook, and API functions
    │   ├── features/auth/ # Login, registration, email confirmation, and recovery
    │   ├── features/songs/ # Saved-song page, state hook, and API functions
    │   ├── components/ui/ # Shared component library
    │   ├── lib/           # Shared utilities
    │   ├── index.css      # Tailwind CSS styles
    │   └── main.tsx
    ├── vite.config.ts     # Vite config with Tailwind & proxy to backend (:3001)
    └── package.json
```

---

## Quick Start

### Configure authentication

Authentication uses Supabase Auth. This step needs no custom tables, SQL migration, or backend secret key.

1. Open the existing Supabase project.
2. Enable email/password authentication and open registration.
3. Enable **Confirm email**.
4. Set the development Site URL to `http://localhost:5173`.
5. Add `http://localhost:5173/` to the allowed redirect URLs.
6. Add the exact production origin and redirect URL before deployment.
7. Configure custom SMTP for users outside the Supabase project team.
8. Keep the standard confirmation and recovery templates that use `{{ .ConfirmationURL }}`.

The browser handles the email callback through the Supabase SDK. It supports confirmation, resend, and password recovery.
[Supabase password authentication](https://supabase.com/docs/guides/auth/passwords) and [SMTP configuration](https://supabase.com/docs/guides/auth/auth-smtp).

Create `frontend/.env.local` from `frontend/.env.example`. Enter the project URL and publishable key:

```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

Add the same project values to the existing `backend/.env`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
```

Restart both development servers after an environment change.
The frontend shows a configuration error if its values are absent.
Protected backend endpoints reject requests if server authentication is not configured.

Each user has a separate in-memory conversation and separate local audio directories.
The backend deletes idle conversations after 30 minutes. Agent access renews this timeout, but context reads do not.
Running agent requests pause the timeout. The timeout restarts when each request finishes or fails.
After expiration, the next chat request starts a new conversation. Saved songs remain available, but the backend deletes session uploads.
Login persists across reloads. Logout clears the current browser session and stops its pending requests and audio playback.
Logout also deletes uploaded audio. If a job is active, the backend deletes its uploads when the job finishes.
Use the profile link to see your email, confirmation status, account creation date, and last sign-in date.
React Router serves chat at `/`, your saved songs at `/songs`, and your profile at `/profile`.
Navigation preserves the current conversation and music form.
Configure production hosting to serve `index.html` for frontend routes such as `/profile` and `/songs`.
Keep `/api/` requests on the backend.
Local audio playback and downloads use authenticated requests.
Existing audio without an owner remains on disk but has no public route.
Generated songs use private R2 storage and Supabase metadata. Uploads stay in local user directories for the current session.
Use **my songs** to see your newest 100 saved songs, creation dates, prompts, and lyrics.
Select **listen** to play a song or download its MP3. Only the selected song loads audio.
The page reads songs for the signed-in user. It loads the list again when you return or select **refresh**.
Select **delete** and confirm to permanently remove a saved song. If deletion fails, the song stays in the list for another attempt.
The page also lists **unsaved songs**, including after a reload or backend restart when recovery audio is available.
Select **retry saving** to store the existing audio without another generation call.
If saving fails, the song stays in the unsaved list. A successful save moves it to the saved list.
Older local songs are not included. Paid operations also require [usage quota setup](#configure-usage-quotas).

### Configure signup protection

1. Open **Cloudflare Dashboard → Turnstile → Add widget**. Choose **Managed** and add your production hostname.
2. Copy the public site key into `frontend/.env.local` as `VITE_TURNSTILE_SITE_KEY`.
3. In **Supabase Dashboard → Authentication → Bot and Abuse Protection**, enable CAPTCHA protection.
4. Select **Turnstile**, enter the widget's secret key, and save. Keep this secret out of frontend files.
5. Rebuild the frontend. Check registration, login, confirmation resend, and password recovery on the production hostname.

The frontend sends the verification token to Supabase. Supabase validates it before accepting the authentication request.
Each request needs a fresh token. Expired or failed verification disables submission; select **retry verification** after a verification error.
Password updates from a recovery session need no additional challenge.
The widget is omitted when its site key is absent, for local development. Public deployment requires both the site key and Supabase CAPTCHA enforcement.
See [Supabase CAPTCHA protection](https://supabase.com/docs/guides/auth/auth-captcha).

### Configure generated-song storage

1. In the Supabase SQL Editor, run [the songs migration](supabase/migrations/20261005113828_songs.sql) on the same project.
2. Create a private Cloudflare R2 bucket.
3. Disable public access through `r2.dev` and custom domains.
4. Create R2 credentials with object read/write access for that bucket.
5. Add these values to `backend/.env`:

```env
SUPABASE_SECRET_KEY=sb_secret_your_server_key
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_BUCKET_NAME=your_private_bucket
R2_ACCESS_KEY_ID=your_bucket_access_key
R2_SECRET_ACCESS_KEY=your_bucket_secret
```

Keep these credentials on the backend. Restart the backend after the configuration change.
Generation stops before the model call if credentials are absent or the metadata table is unavailable.

Each `songs.owner_id` references `auth.users.id`. The backend gets this ID from verified access-token claims.
The R2 key is `users/<owner-id>/<song-id>.mp3`. The database constraint requires the same owner and song ID in this key.
Row-level security permits users to read only their own ready songs. Direct client writes are disabled.
See the [Supabase RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security).

The backend inserts pending metadata, uploads the MP3, then marks the song ready.
It stores the prompt, model, lyrics, size, and creation time with the song.
Playback and downloads keep the authenticated `/api/music/<song-id>.mp3` address and read the private object through Express.
R2 supports single byte ranges through this endpoint. The browser needs no R2 URL or bucket CORS configuration.
See the [Cloudflare S3 SDK example](https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/).

These endpoints require the user's bearer token:

| Endpoint | Result |
| --- | --- |
| `GET /api/songs` | The user's newest 100 ready songs, including stable URLs and lyrics |
| `GET /api/songs/recovery` | IDs of local songs with unfinished storage |
| `POST /api/songs/<song-id>/retry` | Store an unfinished song without another model call |
| `DELETE /api/songs/<song-id>` | Delete the user's saved song, its R2 object, and local recovery copies |
| `GET /api/music/<song-id>.mp3` | Private playback or download after an ownership check |

A failed save returns HTTP 502 with `songId` and `retryUrl`. The generation button changes to **retry saving**.
This action stores the existing song. It does not call the music model again.
The retry returns `{ track }`, with the same URL and lyrics as a successful generation.
Repeated retries of a ready song return that song without another upload.

Deletion checks the verified owner before it removes the R2 object or local copies.
It deletes metadata last. If cleanup fails, the metadata remains so deletion can be retried.
If the R2 object was already deleted, the song can remain listed while playback is unavailable until deletion succeeds.
Deletion uses the same per-user action lock as generation and chat. No database migration is required.
The recovery endpoint also finds unfinished local saves after a backend restart or lost response.

Keep `backend/generated-music/` on persistent disk until unfinished saves succeed.
The backend retains at most five unfinished saves per user before it blocks further generation.
If the local recovery write fails, the backend still attempts the R2 save.
If both saves fail, it retains the song in memory for storage retry and reports this condition.
Keep the backend running until that retry succeeds. Memory recovery does not survive a restart.
Successful storage deletes the local recovery audio and metadata.
Local processing downloads each owned song into a separate temporary file.
The backend checks its size and renames the completed download before use. It deletes the file after processing, including failure.
The current implementation needs one backend instance because its request locks and recovery files are local.
Recovery retention, song deletion, pagination, and a saved-song interface are separate work.
Existing owned local songs keep their private playback and processing URLs. They are not imported or included in the saved-song list automatically.
Account deletion requires song cleanup first. The ownership foreign key prevents database rows from becoming ownerless.

Offline checks: `npm --prefix backend run test:songs` and `npm --prefix backend run test:music`.
These checks mock Supabase, R2, and model responses. They make no paid calls.
The database policy checks are in `supabase/tests/songs.sql`.
After local Supabase setup and migration, run `npx supabase test db supabase/tests/songs.sql --local`.

### Configure usage quotas

1. Open the same Supabase project, then select **SQL Editor → New query**.
2. Run [the quota migration](supabase/migrations/20261006150319_usage_quotas.sql) after the songs migration, then run [the global usage migration](supabase/migrations/20261007130543_global_usage_limits.sql).
   Then run [the beta allowance migration](supabase/migrations/20261008141601_beta_allowances.sql) with the updated backend.
3. Keep `SUPABASE_SECRET_KEY` in `backend/.env`. Chat and analysis now require this server-only key too.
4. Add these allowance defaults to `backend/.env`, or use the same built-in values:

```env
QUOTA_CHAT_DAILY=20
QUOTA_ANALYSIS_DAILY=10
QUOTA_GENERATION_DAILY=5
QUOTA_STORAGE_BYTES=536870912
MAX_GENERATED_SONG_BYTES=26214400
GLOBAL_CHAT_DAILY=0
GLOBAL_ANALYSIS_DAILY=0
GLOBAL_GENERATION_DAILY=0
```

5. Replace the three `GLOBAL_*_DAILY` values with your chosen shared daily attempt limits, then restart the backend.

The global limits apply across all users. Their defaults are `0`, so paid operations stay disabled until you set positive values.
These are operation limits, not dollar budgets. Chat includes bounded agent turns and delegated lyric generation.
Both per-user and global allowances must permit each request. The same database transaction reserves both before the paid call.
Backend restarts, conversation resets, and account deletion do not restore the shared allowance.
Each operation resets at midnight UTC. Changing a global environment value takes effect after restarting the backend; it does not reset usage.
The migration includes today's existing per-user usage and removes the old reservation entry point.
Deploy the migration and updated backend together. An outdated backend fails before paid calls.
Exhaustion returns the usual `429 quota_exceeded` response with an app-wide message and reset time.
Storage retries remain available after generation limits are exhausted and do not consume another attempt.

The per-user defaults allow 20 chat messages, 10 analyses, and 5 completed songs per UTC day, subject to the global limits.
Each user has 512 MiB of generated-song storage. Generation reserves 25 MiB before the paid Lyria call.
The backend converts this reservation to the exact MP3 size when it inserts pending song metadata.
An analysis also consumes its surrounding chat request. Bounded agent turns and lyric generation belong to that chat allowance.
Uploads and local recovery copies do not count toward this storage quota.
Existing pending and ready song metadata counts immediately. No byte-counter backfill is necessary.

The first usage request creates a row in `public.user_quotas` from these defaults.
To change an existing user's allowances, open **Table Editor → user_quotas** and edit that user's row.
Environment changes affect new rows only. Set a daily allowance to `0` to disable that operation for a user.
The beta migration lowers existing chat allowances above 20. Disabled accounts and stricter allowances stay unchanged.
Per-user allowance changes take effect on the next reservation.
Credit balances, paid tiers, and payments remain separate work. Their debit logic can use the existing reservation transaction.

Authenticated `GET /api/usage` returns limits, used counts, remaining allowances, reserved bytes, and the next UTC reset time.
The chat page displays remaining allowances and the reset time in the user's local time.
It refreshes after chat actions, page navigation, and the daily reset.
Failed refreshes preserve the previous values and show a retry control.
The database owns the date and counters. Backend restarts and conversation resets do not clear them.
Quota exhaustion returns HTTP `429` with `code: "quota_exceeded"` and the exhausted `resource`.
Daily exhaustion also returns `resetAt` and a `Retry-After` header.
Database failures return HTTP `503` and prevent paid calls.
An analysis quota failure after streaming starts returns a terminal NDJSON error with the same code and resource.

Local validation occurs before reservation. Chat and analysis reservations count as attempts. Lyrics use their surrounding chat allowance.
Generation reserves one personal song and its storage before the paid call.
Confirmed provider rejections and terminal responses without valid audio restore that personal song and release unused storage exactly once.
Global generation attempts stay charged after a personal refund.
Timeouts, connection failures, interrupted responses, and unfinished provider statuses retain both reservations until the outcome is known.
Completion and refunds use the original reservation date, including operations that cross UTC midnight.
If refund settlement fails, the reservation stays charged and the error reports that the refund needs attention.
Pending saves keep their capacity until storage succeeds or cleanup completes. Storage retries do not consume another generation attempt.
Storage failures and song deletion do not restore generation allowance.
Deletion releases bytes when the backend deletes metadata after object and local-file cleanup.
If a track exceeds `MAX_GENERATED_SONG_BYTES`, its local recovery copy remains available.
Increase that limit before storage retry. The exact track must still fit the user's storage allowance.

Interrupted generations can leave storage reservations after a restart. These reservations do not expire automatically.
To find them, inspect `usage_reservations` rows with `storage_bytes > 0` in the SQL Editor.
Before release, make sure that the operation stopped and that no song metadata, R2 object, or local recovery copy needs this capacity.
Then run this server-administrator query with the actual owner and reservation IDs:

```sql
select public.release_song_reservation('USER_UUID', 'RESERVATION_UUID');
```

This query releases only unused storage. It preserves the daily attempt count and does not release capacity held by song metadata.
Automatic reconciliation remains deferred. Keep one backend instance for the existing local conversation locks and recovery files.

The database concurrency and permission check uses separate PostgreSQL connections:

```bash
QUOTA_TEST_DATABASE_URL=postgresql://localhost/quota_test_musical npm --prefix backend run test:quotas:db
```

Use a disposable local database named `quota_test...` with Supabase auth roles and both repository migrations.
The command requires `psql` and an administrator connection. It creates and deletes fixture users and songs only.
Set `QUOTA_TEST_PSQL` if the executable is outside `PATH`.
The mocked music, analysis, authentication, and song checks also cover quota failures without paid provider calls.

### Authentication checks

```bash
npm --prefix backend run test:auth
npm --prefix frontend run test:all
```

Frontend checks build an isolated app with a mock Supabase project.
They cover auth, chat, and audio without real accounts, outgoing email, or paid AI calls.
Backend auth checks use signed fixture tokens and mocked Supabase signing keys.

### 1. Configure Cloudflare AI Gateway

Create `backend/.env` from `backend/.env.example` if it does not exist.
Add the Cloudflare gateway values to the existing file:

```env
CF_AI_GATEWAY_ACCOUNT_ID=your_cloudflare_account_id
CF_AI_GATEWAY_ID=your_gateway_id
CF_AI_GATEWAY_TOKEN=your_gateway_api_token
CF_AI_GATEWAY_NEBIUS_SLUG=nebius
CF_AI_GATEWAY_QWENCLOUD_SLUG=qwencloud
NEBIUS_MODEL=nvidia/nemotron-3-super-120b-a12b
LYRICS_MODEL=zai-org/GLM-5.3-Flash
PORT=3001
```

Store the provider keys in Cloudflare as described below. All hosted AI calls require this gateway.

### 2. Start the Backend

In one terminal:
```bash
npm run dev:backend
```
The backend server runs on `http://localhost:3001`.

### 3. Start the Frontend

In a second terminal:
```bash
npm run dev:frontend
```
The frontend dev server runs on `http://localhost:5173`. Open your browser at `http://localhost:5173` to chat with the agent!

---

## Cloudflare AI Gateway BYOK

Cloudflare routing covers Nebius chat and lyrics, Google Lyria token counting and generation, and QwenCloud audio analysis.
Local audio processing continues to run on this machine.

1. Enable authentication on your Cloudflare gateway.
2. Create these custom providers in Cloudflare. If they already exist, check their slugs and base URLs.

   | Provider | Slug | Base URL |
   | --- | --- | --- |
   | Nebius | `nebius` | `https://api.tokenfactory.nebius.com` |
   | QwenCloud | `qwencloud` | `https://maas.qwencloudapi.com` |

   Use the root domains above. The backend adds `/v1` for Nebius and `/compatible-mode/v1` for QwenCloud.
   Google uses the built-in `google-ai-studio` provider.
3. In your gateway's **Provider Keys**, store each provider key with the `default` alias.
4. Set these values in `backend/.env`:

   ```env
   CF_AI_GATEWAY_ACCOUNT_ID=your_cloudflare_account_id
   CF_AI_GATEWAY_ID=your_gateway_id
   CF_AI_GATEWAY_TOKEN=your_gateway_api_token
   CF_AI_GATEWAY_NEBIUS_SLUG=nebius
   CF_AI_GATEWAY_QWENCLOUD_SLUG=qwencloud
   ```

   The token needs the **AI Gateway - Run** permission. Use custom provider slugs without the `custom-` prefix.
   If your custom providers have different slugs, change the two slug values.
5. Restart the backend.

All three gateway values are required. Store provider keys only in Cloudflare.
The backend removes provider authorization headers before each request so Cloudflare can use its stored keys.
It bypasses caching, permits one gateway attempt, and requires provider credentials instead of Cloudflare Unified Billing.
Missing or incomplete gateway configuration causes an error before any hosted AI call.

The backend sends `cf-aig-custom-cost` for these custom-provider models. Rates are USD per million tokens:

| Model | Input | Output |
| --- | ---: | ---: |
| Nebius `nvidia/nemotron-3-super-120b-a12b` | $0.30 | $0.90 |
| Nebius `zai-org/GLM-5.3-Flash` | $0.15 | $0.50 |
| QwenCloud `qwen3.8-omni-flash` | $0.15 | $0.47 |

Update `customPrices` in `backend/src/gateway.ts` when your rates change.
The code stores these rates as USD per token. Divide rates per million tokens by 1,000,000 before updating the code.
Other models receive no custom-cost header.
Cloudflare calculates costs only for responses that include token usage.
See [Cloudflare custom costs](https://developers.cloudflare.com/ai-gateway/configuration/custom-costs/).

Restart the backend after configuration changes.

Offline routing check: run `node --import tsx tests/gateway.test.ts` from `backend/`.

Cloudflare's documentation covers [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/),
[custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/), and
[gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/).

## Features
- **User sends message:** Interactive chat bar with Enter key submission.
- **Agent answers:** Strands Agents SDK loop powered by Nebius Token Factory + Nemotron Super.
- **Live Health & Status Indicator:** Visual badge displaying backend connection and model state.
- **new session:** Button beside music generation to reset conversation history.

## Music generation

Edit agent behavior in [backend/prompts/system.md](backend/prompts/system.md)
and music form instructions in [backend/prompts/music-form.md](backend/prompts/music-form.md).
[backend/prompts/lyrics.md](backend/prompts/lyrics.md) guides the dedicated lyric agent.
Restart the backend after editing these files. The backend loads them directly;
include `backend/prompts/` alongside `backend/dist/` when deploying a build.

Store a Gemini API key in your gateway's **Provider Keys** under `google-ai-studio`, with access to
[`lyria-3.5` or `lyria-3-clip-preview`](https://ai.google.dev/gemini-api/docs/music-generation).

The music form stays beside the chat, or below it on small screens.
Ask the agent to create music. It fills editable fields for genre/style, mood,
key, BPM, duration, vocals/language, instruments, production, and lyrics.
Edit these fields directly before you approve the song.
Use **music model** to select **Lyria 3.5** (the default) or **Lyria 3 Clip Preview**.
Clip Preview always generates a 30-second clip.
Chat revisions and failed generation keep the selection. Clearing the conversation resets it.
Click **generate music** to send the edited fields as one prompt and start the paid API call.
The backend uses the official `@google/genai` SDK for token counting and generation.
Before generation, it calls Google's [token counting API](https://ai.google.dev/gemini-api/docs/tokens)
with the final prompt and selected model. Prompts above 131,072 input tokens return
HTTP 400 without starting generation. If counting fails, generation does not start.
The separate 10,000-character prompt limit still applies.
Service failures show Google's error message so request errors can be diagnosed.
You can also tell the agent what to change. Each chat request includes the current
form, including manual edits, so revisions can preserve the other fields.
Fields changed by the agent glow briefly. Manual edits do not trigger the glow.
With reduced motion enabled, changed fields show a steady highlight for the same time.
Music advice and prompt preparation do not call Lyria.
The chat spinner shows the current action: thinking, editing fields or lyrics,
generating a track, uploading audio, or analyzing audio.
Chat requests stream tool activity before the final reply.

Prompt preparation follows Google's [Lyria prompt guide](https://ai.google.dev/gemini-api/docs/lyria-prompt-guide)
for Lyria 3.5 batch generation. The agent leads with genre, describes the sound
and song progression, and specifies vocal delivery and lyric language or an
instrumental arrangement. It adds tempo, key, and duration when appropriate.
Supplied lyrics keep their original text under `Lyrics:` with section tags.
The main agent handles chat and form changes. For lyric writing or revision, it
sets `lyricRequest` in `update_music_form`. The tool passes the complete brief,
current lyrics, and requested changes to a fresh lyric agent that uses
`zai-org/GLM-5.3-Flash` through the same Nebius API key and base URL.
Set `LYRICS_MODEL` to override the lyric model. `NEBIUS_MODEL` still controls chat.
The lyric agent reads `lyrics.md` and returns the complete lyric text.
The tool adds nonempty lyric text to the form, keeping its first 3,000 characters.
If the model hits its token limit after producing lyric text, that text is also
accepted and capped. Reasoning-only responses are rejected.
Lyric calls have a two-minute timeout and an 8,192-token completion
limit, including reasoning and lyric text. Reasoning effort is set to `low`.
The lyrics field has a 3,000-character limit, including section tags and line breaks.
Supplied lyrics and edits to other song fields do not trigger a lyric call.
Empty or whitespace-only lyric requests do not trigger a lyric call.
Lyric generation uses paid Nebius inference during chat, before the separate
Generate music action. Failed lyric calls preserve the current form.
Each chat request allows at most six main-agent model turns and one lyric-agent
call, including failed attempts. Each main-model response is capped at 4,096 output
tokens. Main-agent requests also stop at 12,288 cumulative output tokens or 30,000
total tokens. These token budgets are checked between turns, can overshoot by one
response, and exclude the separate lyric call. SDK and HTTP model retries are
disabled. A limit returns a clear stop message; a new user message gets a fresh
budget. Successful form updates remain available when a turn limit is reached.
When the lyrics field is empty, Lyria writes lyrics from the requested story, emotion, and hook.
Each revised prompt includes the full song brief for review.

The result includes an audio player, an MP3 download, and a lyrics dropdown when
lyrics are returned. Structure markers are removed from the displayed lyrics.
All audio players show a waveform and playhead with play/pause, stop, volume,
and elapsed/total time. Click or drag the waveform to seek, or focus it and use
the arrow keys, Home, or End. Stop returns to the beginning.
The browser decodes the waveform with the Web Audio API; no player library or
model call is used. If decoding fails, playback keeps a plain seek timeline.
The agent acknowledges form changes briefly and conversationally, without follow-up
questions or repeated button reminders. It does not repeat the music prompt in chat.
Generated tracks are saved in private R2 storage with owner-linked Supabase metadata.
The backend uses `backend/generated-music/` for unfinished saves and temporary processing files. Git ignores this directory.
Songs survive backend restarts and are available through `GET /api/songs` after another login.
Chat messages remain in the current browser session. A saved-song interface is not included yet.
The **new session** button resets the conversation and music form and leaves saved tracks in place.
The conversation context bar below the music form shows the backend's retained
chat and tool message count against its 40-message sliding window. The count
loads when the page opens and updates after each chat request, including failures.
The **new session** button discards the backend agent and resets the bar only after reset succeeds.
Tool pairs stay together, so the retained count can briefly exceed the window.

The backend uses the Interactions REST API with `store: false`, reads audio from
`model_output` steps, and allows five minutes for generation. Failed requests
show an error and keep your edits available for retry. After success, the form
stays editable for the next track, and previous tracks remain in chat. Chat, reset, and music
generation cannot overlap within the same conversation.

Offline backend check: `npm --prefix backend run test:music`.
Offline lyric routing and failure recovery check: `npm --prefix backend run test:lyrics`.

## Audio analysis

Store a QwenCloud API key in your gateway's **Provider Keys** for the QwenCloud custom provider.
Analysis uses `qwen3.8-omni-flash` through Cloudflare AI Gateway with the installed OpenAI SDK.
Nebius still runs the producer agent and lyric agent. Google still generates music.

Upload or generate a track, then ask the copilot to analyze it or give production
feedback. The agent calls `analyze_audio`, shows **analyzing audio...**, and uses the returned
observations in its chat reply. Uploading or generating audio does not start analysis.
Analysis sends audio to QwenCloud and makes a paid inference call.

Small MP3 and WAV files are sent directly. Larger files and FLAC/OGG inputs need
the existing Python audio environment (`uv sync --frozen --project backend/audio-processing`).
They are converted to a temporary compressed stereo or mono MP3 without changing
the saved source. Conversion supports up to 10 minutes and checks the provider's
10 MB base64 limit. Temporary files are removed after preparation.
No checkpoints are needed for this conversion.

Edit the listening analysis instructions in `backend/prompts/analysis.md`, then
restart the backend. General analysis covers mood, instrument roles and timbres,
rhythm, melody and harmony, vocals, arrangement, and production. It aims for
400–700 words when the recording supports that detail, with approximate timestamps
and prioritized suggestions when relevant. Focused questions get focused answers.
The producer agent preserves the detailed breakdown in chat.
It is an interpretation, not a calibrated assessment of mix quality or a measurement
of BPM, key, loudness, peaks, or clipping. Failed analysis leaves the music form
and source files intact. Each message allows one analysis attempt, with no HTTP
retries, a two-minute inference timeout, and a 2,048-token output limit.

Offline analysis and failure recovery check: `npm --prefix backend run test:analysis`.
It mocks inference and makes no paid calls. Its format-conversion checks require
the Python audio environment.

## Audio uploads and local storage

Install the Python 3.13 environment from the repository root:

```bash
uv sync --frozen --project backend/audio-processing
```

The environment uses NumPy, SoundFile, and librosa for upload validation and analysis conversion.
It needs no GPU or model checkpoints.

Use **upload audio** to add an MP3, WAV, FLAC, or OGG file.
Uploads must be mono or stereo, at most 50 MB, and no longer than 10 minutes.
The attachment area shows the filename and an audio player.
You can replace or remove the attachment before sending.
A failed upload or send preserves the previous attachment.
Chat requests use the latest sent attachment or generated track.

Uploads stay in `backend/uploaded-audio/` for session analysis and playback. Git ignores this directory.
The backend reserves disk space before each upload, with a **1 GiB limit across all users**.
If capacity is insufficient, the upload endpoint returns HTTP 507 and preserves existing files.

A new session, logout, or 30 minutes of inactivity deletes session uploads.
Active uploads and agent requests pause expiration.
A backend restart ends all in-memory sessions. Startup cleanup deletes uploads from those sessions.
Cleanup runs at startup, hourly, and before new writes.
Active sessions and analysis operations protect their input files until they finish.

The disk policy covers `uploaded-audio/` only.
Generated-song recovery files and temporary analysis files remain outside this limit.
One backend process must own the upload directory. Concurrent processes require a shared disk lock.
The limits are defined in `backend/src/local-audio.ts`.

Upload validation and session cleanup check: `npm --prefix backend run test:audio`.
This check requires the Python environment and makes no paid calls.
Disk policy check: `cd backend` then `node --import tsx --test tests/local-audio.test.ts`.
This check uses isolated temporary directories and makes no model calls.

## LangSmith tracing

Set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` in `backend/.env`, then
restart the backend. `LANGSMITH_PROJECT=musical-copilot` groups the traces.
`LANGSMITH_ENDPOINT` defaults to `https://api.smith.langchain.com`; use
`https://eu.api.smith.langchain.com` for an EU workspace.

Each agent invocation records its input, reply, errors, and duration. Model calls,
`update_music_form` and `analyze_audio` appear as child runs, including model token
usage and tool inputs and results. Conversation session IDs group runs into LangSmith threads.
Confirmed audio generation records a separate `generate_audio` run in the same
thread, with the prompt, download URL, and lyrics. Audio bytes and API keys are
excluded. Prompt preparation still requires user approval before generation.
Delegated lyric calls appear as `generate_lyrics` child chains with their GLM model runs.
Qwen analysis records a `QwenOmni` model run under `analyze_audio`, including
token usage. Analysis traces contain the source URL, question, instructions,
and response. Audio bytes and API keys are excluded.

Tracing sends conversation and music prompt text to LangSmith. Set
`LANGSMITH_TRACING=false` to disable it.

Offline tracing check: `npm --prefix backend run test:tracing`.

Frontend chat E2E check: start `npm run dev:frontend`, then run
`npm --prefix frontend run test:e2e`. It requires the `agent-browser` CLI and
mocks all API calls. Set `E2E_URL` to test another local frontend URL.

Audio player E2E check: run `npm run build:frontend`, then
`npm --prefix frontend run test:audio`. It uses the same browser CLI and a local
test server with real WAV audio. It checks waveform rendering, playback controls,
seeking, volume, attachment sending, mobile layout, and load failure recovery.
