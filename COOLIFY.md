# Deploy studio.lau.lu on Coolify

This package uses one Node.js 24 container on Debian 13 (Trixie) for the frontend, API, and FFmpeg.
Supabase, R2, and Cloudflare AI Gateway remain external services.
The container runs as the `node` user and listens on port `3001`.

## Configure the application

1. Commit the deployment files and push them to the branch you want to deploy.
2. In Coolify, open the target project and environment. Select **+ New** and connect this Git repository.
3. Under **General > Build pipeline**, select **Compose** as the build strategy. Older versions call this the **Docker Compose** build pack.
4. Set **Base Directory** to `/` and **Docker Compose Location** to `/docker-compose.yml`. Save and load the definition.
   Under **Advanced > Build**, set **Build arguments** to **Managed manually in Dockerfile**. Keep the Compose deployment managed by Coolify so it adds proxy routing.
5. Open **Environment Variables** and import the values from Doppler as described below, or enter them directly.
6. Open **Domains**, select **Add domain**, choose service `studio`, and enter `https://studio.lau.lu:3001`. The public address is `https://studio.lau.lu`; the suffix selects the internal port.
7. Point the `studio.lau.lu` DNS record at the Hetzner server. Publish through Coolify's HTTPS proxy; keep port `3001` private.
8. Select **Deploy** and inspect **Deployment Logs** and **Runtime Logs**.

These steps follow the [Coolify Compose guide](https://coolify.io/docs/applications/builds/docker-compose).

## Required environment values

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Existing project's HTTPS URL |
| `SUPABASE_PUBLISHABLE_KEY` | Existing project's public key |
| `SUPABASE_SECRET_KEY` | Server-only database key |
| `CF_AI_GATEWAY_ACCOUNT_ID` | Existing Cloudflare account ID |
| `CF_AI_GATEWAY_ID` | Existing BYOK gateway ID |
| `CF_AI_GATEWAY_TOKEN` | Gateway authentication token |
| `R2_ACCOUNT_ID` | R2 account ID |
| `R2_BUCKET_NAME` | Existing private song bucket |
| `R2_ACCESS_KEY_ID` | R2 access key ID |
| `R2_SECRET_ACCESS_KEY` | R2 secret access key |
| `GLOBAL_CHAT_DAILY` | Your configured shared chat cap |
| `GLOBAL_ANALYSIS_DAILY` | Your configured shared analysis cap |
| `GLOBAL_GENERATION_DAILY` | Your configured shared generation attempt cap |

Keep your existing production caps. The repository examples use `200`, `30`, and `20`.
Zero or a missing shared cap disables the corresponding paid operation. Missing credentials cause the corresponding operation to fail.
The backend supplies the existing defaults for optional model IDs, provider slugs, personal allowances, and audio limits.
Set `CF_AI_GATEWAY_NEBIUS_SLUG=nebius-token-factory` to use the provider from the working local setup.

Store the public Turnstile site key in Doppler as `VITE_TURNSTILE_SITE_KEY`.
In Coolify, add these frontend variables:

```dotenv
VITE_SUPABASE_URL={{vault.SUPABASE_URL}}
VITE_SUPABASE_PUBLISHABLE_KEY={{vault.SUPABASE_PUBLISHABLE_KEY}}
VITE_TURNSTILE_SITE_KEY={{vault.VITE_TURNSTILE_SITE_KEY}}
```

Make these three variables available during build only. Coolify passes them to the Dockerfile's declared build arguments.
The Supabase aliases use the same Doppler values as the backend; duplicate Doppler keys are not needed.
These public values become part of the frontend bundle. A change requires a new build.
Make all backend variables, including `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, available at runtime only.
Do not put server keys or tokens in build arguments or `VITE_` variables.
See [Coolify environment scopes](https://coolify.io/docs/applications/configuration/environment-variables).

To enable the sandbox pricing page and checkout, also add these public values as build-only variables:

```dotenv
VITE_PADDLE_CLIENT_TOKEN={{vault.VITE_PADDLE_CLIENT_TOKEN}}
VITE_PADDLE_STARTER_PRICE_ID={{vault.VITE_PADDLE_STARTER_PRICE_ID}}
VITE_PADDLE_PRO_PRICE_ID={{vault.VITE_PADDLE_PRO_PRICE_ID}}
VITE_PADDLE_ULTRA_PRICE_ID={{vault.VITE_PADDLE_ULTRA_PRICE_ID}}
VITE_PADDLE_STARTER_ANNUAL_PRICE_ID={{vault.VITE_PADDLE_STARTER_ANNUAL_PRICE_ID}}
VITE_PADDLE_PRO_ANNUAL_PRICE_ID={{vault.VITE_PADDLE_PRO_ANNUAL_PRICE_ID}}
VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID={{vault.VITE_PADDLE_ULTRA_ANNUAL_PRICE_ID}}
```

Store the sandbox `test_` client token and the monthly and annual sandbox price IDs in Doppler under these names.
The Dockerfile declares the matching build arguments. See [sandbox pricing setup](README.md#configure-sandbox-pricing-and-checkout)
for the existing price IDs. Checkout remains in sandbox. Confirmed sandbox subscriptions activate the selected tier allowances.
Add the matching `PADDLE_*_ANNUAL_PRICE_ID` variables at runtime and apply `20261015212549_annual_billing.sql` before deploying.

Keep these values in Coolify as runtime variables:

```dotenv
NODE_ENV=production
PORT=3001
LANGSMITH_TRACING={{vault.LANGSMITH_TRACING}}
ALLOWED_ORIGINS=https://studio.lau.lu
```

The Dockerfile supplies the first three defaults. Runtime variables override image defaults.
Set `LANGSMITH_TRACING` to `true` or `false` in Doppler, then redeploy to refresh the runtime variables.
Tracing also requires `LANGSMITH_API_KEY`. Set `LANGSMITH_PROJECT` to select the project.
Provider API keys remain in Cloudflare AI Gateway's BYOK provider settings.
The image contains no development `.env` files, uploads, recovery audio, or model weights.

Use the existing Supabase production redirect, email, and CAPTCHA configuration.
The site URL must be `https://studio.lau.lu`. Confirmation and recovery redirects must allow this origin.

## Import values from Doppler

1. Create a production config in Doppler with all required environment values and any optional overrides.
2. Create a Doppler service token for that config.
3. In Coolify, open **Keys & Tokens > Integration Tokens** and add the Doppler token.
4. Open this application's **Environment Variables > Secret manager** and select the integration token.
5. Select **Browse keys > Import all keys**. Do not remove existing variables until their replacements are imported.
6. Add the frontend aliases above and set them to build only. Set all other imported values to runtime only.
7. Deploy the application.

Coolify resolves the Doppler references and generates the deployment's `.env` file.
Coolify adds `env_file: .env` to the deployed Compose definition. Keep the Compose deployment managed by Coolify; raw mode skips this step.
The repository Compose file needs no `env_file`, `environment`, or `build.args` blocks.
Coolify 4.4.6 can insert raw Doppler references from Compose build arguments into the runtime environment.
These entries override resolved `.env` values. Supply build arguments through Coolify to avoid this parser behavior.
See [Coolify 4.4.6's Compose parser](https://github.com/coollabsio/coolify/blob/v4.4.6/bootstrap/helpers/parsers.php#L1716).
See [Coolify's Compose deployment implementation](https://github.com/coollabsio/coolify/blob/main/app/Jobs/ApplicationDeploymentJob.php).
Import new Doppler keys into Coolify before deploying a feature that needs them.
After changing runtime values in Doppler, restart or redeploy the application. Changes to public build values require a new deployment.
See [Coolify secret manager setup](https://coolify.io/docs/integrations/security/using-secret-managers).

For standalone Compose, use an override that attaches the runtime `.env` file through `env_file`.
The CLI's `--env-file` option supplies interpolation values only; it does not inject container variables.
Do not commit `.env`. Docker excludes it from the build context.

## Storage and restarts

The `song-recovery` named volume mounts at `/app/backend/generated-music`.
It preserves failed-save audio and recovery journals across container replacement.
Coolify may add its resource identifier to the volume name. Keep the same application resource.
Inspect its actual volume under **Persistent Storage** after loading the definition.
Do not remove the volume or run `docker compose down --volumes`.

Uploads stay in the replaceable container filesystem. A restart ends upload sessions and chat context.
Saved songs remain in R2; metadata, quotas, and operation records remain in Supabase.

Keep one `studio` instance and disable preview deployments against production services or recovery storage.
Use the Compose build strategy for subsequent deployments.
Coolify's [Compose deployments do not use rolling container overlap](https://coolify.io/docs/applications/deployments/rolling-updates).
Schedule brief maintenance interruptions. Deploy when paid operations have finished; an interrupted provider outcome can remain charged as unknown.

## Health, logs, and backups

The image probes `/api/health` every 30 seconds. This checks the HTTP server; it does not prove that external services work.
Docker's [`local` log driver](https://docs.docker.com/engine/logging/drivers/local/) rotates runtime logs at three files of 10 MB each, with compression.
This limit covers this app's stdout and stderr. Coolify build logs and proxy logs have separate retention.
Docker restarts an exited process; an unhealthy status alone does not restart it.

Before opening the beta, configure host disk alerts and off-server backups for the recovery volume, Supabase database, and R2 songs.
Check the Docker data disk with `df -h /var/lib/docker` and `docker system df` on the server.
Stop the app before a recovery-volume backup or restore. Preserve UID/GID `1000:1000` for restored files.
Test a restore and a previous-commit redeploy while keeping the same volume.
This package does not configure backup schedules or host monitoring.

## Verification

Repository checks, from the root:

```bash
npm run build
npm --prefix backend run test:deployment
npm --prefix backend run test:auth
```

Check Compose configuration on a Docker host:

```bash
docker compose config --quiet
```

Deploy through Coolify to supply the runtime variables and public proxy routing.
In Coolify, verify `https://studio.lau.lu/api/health` and reload `/songs`, `/profile`, and `/privacy` directly.
Verify that private API requests still require login and that a missing asset returns HTTP 404.
Confirm that the recovery volume survives a redeploy. Do not trigger paid operations for packaging checks.
