# laulu / lau.lu

An AI music studio. Describe a song, refine its lyrics and sound, then generate it.

- Chat with a music copilot and edit the song brief.
- Generate full songs with Lyria 3.5 or 30-second clips with Lyria 3 Clip Preview.
- Set a song title in the music generation form. Blank titles are saved as `untitled`.
- Upload audio for analysis and production feedback.
- Save, play, download, favourite, and delete your own songs. Use the all songs and favourites tabs to filter your library.

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
The auth forms keep unused CAPTCHA verification when you switch between login and registration. Verification refreshes after each auth attempt or token expiry.
Registration requires matching password and confirm-password fields.
After successful registration, the form shows a centered message to check email for account confirmation.
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

Apply [the song favourites migration](supabase/migrations/20261015233700_song_favourites.sql) before deploying favourites.
It stores each song's favourite state on the account and keeps older recovery metadata compatible.
The library loads 50 songs at a time, newest first. Use **show more** to browse older songs.
The favourites tab searches all saved songs and loads them in the same way.

### Configure usage quotas

Set shared daily attempt limits in Supabase Table Editor → `public.global_usage` → `daily_limit`.
The initial limits are `200` for `chat`, `30` for `analysis`, and `20` for `generation`. Set `daily_limit` to `0` to disable an operation.
Edits apply to the next request without a backend restart. Keep `used` and `usage_date` unchanged; usage resets at midnight UTC.
Apply [the database global limits migration](supabase/migrations/20261016003139_database_global_limits.sql) before deploying this backend. The old `GLOBAL_*` environment variables are no longer used.

Apply [the plan limits migration](supabase/migrations/20261013212037_plan_limits.sql) before deploying the updated backend and frontend.
It preserves usage counts and gives existing subscribers their plan allowances.
Then apply [the lyrics allowances migration](supabase/migrations/20261013223633_lyrics_allowances.sql) before deploying this version.
It adds separate lyrics usage and sets the paid daily chat limits to 40, 80, and 150.

Edit **Supabase → Table Editor → plan_limits** to change allowances. Paddle controls prices and subscription status.
The pricing page, usage display, generation reservations, and storage checks all use this table.

| Plan | Chat/day | Analyses/day | Songs | Lyric requests | Storage |
| --- | ---: | ---: | --- | --- | ---: |
| free | 20 | 10 | 10/calendar month | 20/calendar month | 512 MiB |
| starter | 40 | 20 | 30/billing month | 10/billing month | 2 GiB |
| pro | 80 | 50 | 80/billing month | 30/billing month | 5 GiB |
| ultra | 150 | 100 | 180/billing month | 60/billing month | 10 GiB |

Use `chat_daily`, `analysis_daily`, `songs_monthly`, `lyrics_monthly`, and `storage_bytes` to set these limits.
All plans use monthly song and lyric limits. Keep `songs_daily` and `lyrics_daily` null.
One GiB is `1073741824` bytes. Limits must be nonnegative integers. Zero blocks the corresponding operation.

Edits affect the next quota check and appear when users reload pricing or refresh their allowances. No redeploy is required.
Edits do not reset usage. Reductions can block further use until usage resets or space becomes available.
Daily allowances reset at midnight UTC. Free songs and lyrics reset at the start of each calendar month in UTC.
Apply [the free monthly allowances migration](supabase/migrations/20261015225822_free_monthly_allowances.sql) before deploying this version.
It keeps this month's existing free usage and preserves the other plan settings. Monthly allowances do not roll over.
Paid songs reset with the Paddle billing period.
Paid lyrics requests use the same billing period. A request reserves one attempt before the Qwen call.
Failed and uncertain lyrics calls remain charged. Ordinary chat and field edits remain available after lyrics are exhausted.
The shared chat cap bounds lyrics calls too, because each admitted chat can make at most one lyrics attempt.

Individual overrides remain in `public.user_quotas`. A null field follows the plan.
The migration replaces old standard defaults with null and preserves other values, including zero blocks.
`generation_daily` overrides free songs only. Zero also blocks paid generation, as before.
The old `QUOTA_*` environment variables are no longer used. Remove them from deployment settings.

To reset one user's usage without changing their allowance, apply
[`20261014145113_reset_user_usage.sql`](supabase/migrations/20261014145113_reset_user_usage.sql) through the linked Supabase CLI workflow.
From the repository root, review and apply pending migrations:

```bash
supabase migration list
supabase db push --dry-run
supabase db push
```

Then run this function in the Supabase SQL Editor as an admin:

```sql
select public.reset_user_usage('USER_UUID', 'lyrics');
```

Replace `USER_UUID` with the user's UUID from Supabase Authentication.
Choose `lyrics`, `chat`, `analysis`, or `generation` to reset that operation only.
For example, 10/10 lyric requests becomes 0/10. The function returns the new `used`, `limit`, and `remaining` values.
It resets the current UTC day or current paid billing period, matching the operation's allowance.
It preserves plan limits, account overrides, saved songs, pending reservations, other users, and global usage.
The function is restricted to admins and the server's service role; signed-in users cannot reset their own usage.
Refresh the user's allowances in the app to see the result.

Shared `public.global_usage.daily_limit` limits still apply to every plan. Increase these separately when paid demand requires more capacity.
Saved storage counts generated songs and their pending reservations. Uploads do not consume this allowance.

The chat agent keeps 16 recent messages and allows three model calls per request.
Its budgets are 20,000 total tokens and 4,096 output tokens, with at most 4,096 output tokens per model call.
Before each call, it checks the estimated input size and the reported usage, then reduces the remaining output allowance.
It trims older history when needed to leave room for the reply, preserving the latest request and complete tool pairs.
Requests stop if they still cannot fit after history trimming, or if the output or model-call budget is exhausted.
Nebius input sizing uses the SDK estimate. This check reduces overshoot but does not guarantee an exact billed-token ceiling.
The separate Qwen lyrics agent keeps its 8,192-token completion budget, including reasoning, to preserve complete lyrics.

### Configure sandbox pricing and checkout

The public `/pricing` page shows free, starter, pro, and ultra plans.
Paid prices come from Paddle's price preview in USD. Checkout requires login and uses the Paddle sandbox only.
Verified sandbox subscriptions select starter, pro, or ultra allowances from `public.plan_limits`.
Paid plans increase chat, audio analysis, monthly songs, and saved-song storage. Shared daily limits still apply.

The [Paddle subscription migration](supabase/migrations/20261013152856_paddle_subscriptions.sql) creates server-only customer,
subscription, and transaction mirrors and extends atomic song reservations to billing periods.
The migration replaces quota functions, so deploy the matching backend and frontend together.

Set these public values in `frontend/.env.local`:

```dotenv
VITE_PADDLE_CLIENT_TOKEN=test_your_public_client_token
VITE_PADDLE_STARTER_PRICE_ID=pri_01m4tvkjam9nptz0f1ngrbr9mj
VITE_PADDLE_PRO_PRICE_ID=pri_01m4tvmm85j15s4vjd9ykmsa0d
VITE_PADDLE_ULTRA_PRICE_ID=pri_01m4tvnr6xfnyk1nwtyt5vma9e
VITE_PADDLE_STARTER_ANNUAL_PRICE_ID=pri_01m50px1szmdvk7ytv5sejdzgr
VITE_PADDLE_PRO_ANNUAL_PRICE_ID=pri_01m50pzdw9pfn9c5ss1kehnv9n
VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID=pri_01m50q3rnc8na58rv1s4n9yay9
```

The sandbox monthly prices are $10, $20, and $40 USD. Annual prices are $99, $199, and $380 USD, with no trial.
The page switches between monthly and yearly billing. Song and lyric allowances stay monthly for both billing frequencies.
Apply `20261015212549_annual_billing.sql` before deploying annual billing. It preserves billing dates and counts usage in monthly UTC windows anchored to the subscription start date.
The ultra price belongs to the Paddle product named `Advanced`.
The page shows USD prices with applicable tax for the detected location. Checkout selects the local currency and confirms the total for the billing address.
Use a `test_` client token from Paddle's sandbox authentication settings. Never put a Paddle API key in a `VITE_` variable.
Set the default payment link in the sandbox checkout settings to a URL that serves this app, such as `http://localhost:5173/pricing`.
Sandbox checkout uses [Paddle test cards](https://developer.paddle.com/concepts/payment-methods/credit-debit-card#test-cards).
Restart the frontend after changing its environment values.
In Coolify, enable build-time availability for all `VITE_PADDLE_*` values. They are not needed at runtime.

Set these server-only values in `backend/.env` (runtime variables in Coolify):

```dotenv
PADDLE_SANDBOX_API_KEY=your_sandbox_api_key
PADDLE_NOTIFICATION_WEBHOOK_SECRET=your_notification_destination_signing_secret
PADDLE_STARTER_PRICE_ID=pri_01m4tvkjam9nptz0f1ngrbr9mj
PADDLE_PRO_PRICE_ID=pri_01m4tvmm85j15s4vjd9ykmsa0d
PADDLE_ULTRA_PRICE_ID=pri_01m4tvnr6xfnyk1nwtyt5vma9e
PADDLE_STARTER_ANNUAL_PRICE_ID=pri_01m50px1szmdvk7ytv5sejdzgr
PADDLE_PRO_ANNUAL_PRICE_ID=pri_01m50pzdw9pfn9c5ss1kehnv9n
PADDLE_ULTRA_ANNUAL_PRICE_ID=pri_01m50q3rnc8na58rv1s4n9yay9
```

The API key needs price read, transaction read/write, and subscription read/write permissions. The signing secret belongs to the webhook destination;
it is not the API key. The public frontend price IDs must match the server price IDs.
Keep all server-side Paddle values runtime-only in Coolify; disable their build-time availability.
The permanent sandbox destination is `https://studio.lau.lu/api/paddle/webhook`.
Subscribe it to `customer.created`, `customer.updated`, `transaction.completed`, and
`subscription.created`, `subscription.updated`, `subscription.canceled`, `subscription.activated`,
`subscription.trialing`, `subscription.paused`, `subscription.past_due`, and `subscription.resumed`.
Use platform traffic. Simulation events must not grant allowances to app accounts.

Checkout creates a transaction on the authenticated backend and records its owner before returning its ID.
Completed payments block another checkout until their subscription is mirrored and confirmed canceled.
Browser-provided emails and custom data never establish ownership. Purchases made before this fulfillment integration
have no trusted account binding and need an explicit account-to-transaction mapping before replaying their notifications.
The raw webhook route runs before JSON parsing and authentication. Invalid signatures and failed database writes return non-2xx.
Mirrors upsert by Paddle ID and ignore older state; late created events can still establish ownership.
Only `active` and `trialing` subscriptions with a recognized monthly or yearly plan grant paid access.
Scheduled cancellation or pause retains access while the status remains active; `paused`, `past_due`, and `canceled` use free allowances.
The last verified billing period remains in use until Paddle reports renewal. Yearly subscriptions receive a new song and lyric allowance each month, without another payment webhook.
Confirmed failures refund the original period, once; unknown outcomes stay charged.
Operation cleanup retains paid reservations and never touches billing mirrors.

Signed-in subscribers can change or cancel their subscription from `/pricing`.
Plan changes keep the current billing frequency and show Paddle's price preview before confirmation. Upgrades charge the prorated difference immediately.
Downgrades bill the full lower price at the next renewal and keep the current allowances until that period starts.
Further plan changes are blocked while a downgrade or cancellation is scheduled. Cancellation remains available during a pending downgrade.
Cancellation takes effect at the end of the paid period. Paused subscriptions end immediately, as required by Paddle.
Allowances change only after a verified subscription webhook updates the mirror.

Before deploying these controls, apply `20261014104231_subscription_plan_changes.sql` with the linked Supabase CLI:

```bash
supabase migration list
supabase db push --dry-run
supabase db push
```

This migration keeps the previous tier in the subscription mirror for all mid-period downgrades, including dashboard changes.
The renewal webhook applies the lower tier. Do not deploy the downgrade controls before this migration.

Keep the notification destination and its signing secret, all catalog products/prices, and all billing customers,
subscriptions, and transactions permanently. Do not delete them as testing cleanup.
After deployment, use the sandbox notification logs to check deliveries. Replay failed real notifications after fixing
an unavailable endpoint; sandbox retries are limited. Keep Paddle's default payment link on an app URL.

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
Dates use short month names. Displayed times use your browser's local time, without seconds or timezone offsets.
Music errors show short recovery instructions instead of raw provider responses.
Safety rejections ask you to edit the prompt or lyrics before trying again.

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
npm --prefix frontend run test:e2e
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

Frontend end-to-end checks use Playwright (`@playwright/test`, Chromium) in `frontend/e2e/` with a shared fixture in `frontend/e2e/fixtures.ts`. Install the browser once with `npx --prefix frontend playwright install chromium`, then run `npm --prefix frontend run test:e2e` (or `test:e2e:ui` for UI mode). These checks use mocked services and make no paid AI calls.
Playwright builds and starts its own preview on port 5174 and refuses to reuse an existing server. Auth checks use mocked CAPTCHA and Supabase responses. To run one suite, use `npm --prefix frontend run test:e2e -- auth.spec.ts`.
Audio checks require FFmpeg. Additional backend checks are listed in [backend/package.json](backend/package.json).
Plan database checks use `npm --prefix backend run test:quotas:db` with `QUOTA_TEST_DATABASE_URL` set to a disposable, migrated localhost database.

## Deployment

See [COOLIFY.md](COOLIFY.md) for deployment at `studio.lau.lu`, environment configuration, persistent storage, and backups.
The Docker image includes FFmpeg and serves both the frontend and API.
Tracing is controlled by `LANGSMITH_TRACING` in every environment and defaults to `false` in the Docker image.
Set it to `true` to enable tracing, with `LANGSMITH_API_KEY` configured. Set `LANGSMITH_PROJECT` to select the project.
