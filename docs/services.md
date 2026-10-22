# Service Configuration & Runtime

This guide covers configuring Supabase authentication, Cloudflare R2 storage, Cloudflare AI Gateway, and runtime security/recovery settings.

## Authentication & Terms

1. In Supabase, enable email/password authentication, open registration, and email confirmation.
2. Set the development **Site URL** to `http://localhost:5173` and allow `http://localhost:5173/` as a redirect URL (use your production origin for public deployments).
3. Keep the standard email templates that use `{{ .ConfirmationURL }}` and configure custom SMTP before public use.
4. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SECRET_KEY` in `backend/.env` (keep `SUPABASE_SECRET_KEY` on the backend only).
5. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in `frontend/.env.local`.
6. Apply all migrations in [`supabase/migrations/`](../supabase/migrations) via `supabase db push`.

### Turnstile CAPTCHA

For public deployments, enable Supabase Turnstile enforcement and set `VITE_TURNSTILE_SITE_KEY` in `frontend/.env.local`. Leave it empty for local development.

### Terms & Age Gate

Users must confirm they are 18 or older (self-declared) and accept the current terms before using chat, audio analysis, or music generation:
- The frontend checks acceptance with `GET /api/terms` and records it with `POST /api/terms`.
- Keep `TERMS_VERSION` synchronized between [`backend/src/terms.ts`](../backend/src/terms.ts) and [`frontend/src/lib/terms.ts`](../frontend/src/lib/terms.ts).

## Song Storage & Playback

1. Create a private Cloudflare R2 bucket with public access disabled.
2. Create credentials with object read/write access for that bucket.
3. Set `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in `backend/.env`.

### How Playback & Recovery Work

- Saved songs are stored as private R2 objects with metadata in Supabase.
- Authenticated clients request signed, file-specific playback links (valid for up to 1 hour, until session expiry, or until backend restart) using an in-memory signing key.
- Audio streams on demand with HTTP byte ranges and 1-hour private browser caching.
- If saving to R2 fails after generation, **retry saving** persists the existing local audio from `backend/generated-music/` without re-running generation.

## Cloudflare AI Gateway

All hosted AI calls route through Cloudflare AI Gateway (BYOK). Provider keys stay in Cloudflare.

1. Enable authentication on your Cloudflare AI Gateway.
2. Configure the providers and store each provider's API key under the `default` alias:

   | Provider | Default slug | Base URL | Purpose |
   | --- | --- | --- | --- |
   | Nebius | `nebius` | `https://api.tokenfactory.nebius.com` | Chat copilot & lyrics |
   | QwenCloud | `qwencloud` | `https://maas.qwencloudapi.com` | Audio analysis |
   | Google AI Studio | `google-ai-studio` (built-in) | Built-in | Lyria music generation |

3. Set these variables in `backend/.env` (`CF_AI_GATEWAY_TOKEN` requires the **AI Gateway - Run** permission):

   ```dotenv
   CF_AI_GATEWAY_ACCOUNT_ID=your_account_id
   CF_AI_GATEWAY_ID=your_gateway_id
   CF_AI_GATEWAY_TOKEN=your_gateway_token
   ```

4. If your custom provider slugs differ, set `CF_AI_GATEWAY_NEBIUS_SLUG` and `CF_AI_GATEWAY_QWENCLOUD_SLUG` (without the `custom-` prefix).

## Uploads, Recovery & Security

- **Audio uploads**: Accepts mono or stereo MP3, WAV, FLAC, and OGG files up to 50 MB and 10 minutes. Uploads stay on local disk and expire on new session, logout, inactivity, or backend restart.
- **Single-instance recovery**: Run one backend instance and keep `backend/generated-music/` on persistent storage for unfinished songs and operation recovery. Unknown provider outcomes retain their allowance charge and never trigger automatic paid retries.
- **Rate limiting**: Bounded at 300 requests per IP and 3,000 requests server-wide per 60-second window (excluding `/api/health` and CORS preflight). Set `TRUSTED_PROXY_CIDRS` when running behind a reverse proxy so clients do not share the proxy IP allowance.
- **Security headers**: All responses include CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and (in production) 1-year `Strict-Transport-Security`.
- **Tracing**: Controlled by `LANGSMITH_TRACING` (`false` by default in Docker). Set `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`, and optionally `LANGSMITH_PROJECT` to enable LangSmith tracing.
