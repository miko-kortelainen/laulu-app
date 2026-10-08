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
5. Open **Environment Variables** and enter the required values below.
6. Open **Domains**, select **Add domain**, choose service `studio`, and enter `https://studio.lau.lu:3001`. The public address is `https://studio.lau.lu`; the suffix selects the internal port.
7. Point the `studio.lau.lu` DNS record at the Hetzner server. Publish through Coolify's HTTPS proxy; keep port `3001` private.
8. Select **Deploy** and inspect **Deployment Logs** and **Runtime Logs**.

These steps follow the [Coolify Compose guide](https://coolify.io/docs/applications/builds/docker-compose).

## Required environment values

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Existing project's HTTPS URL |
| `SUPABASE_PUBLISHABLE_KEY` | Existing project's public key |
| `VITE_TURNSTILE_SITE_KEY` | Public site key configured for `studio.lau.lu` |
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
Zero disables the corresponding paid operation. Missing required values prevent deployment.
Optional model IDs, provider slugs, personal allowances, and audio limits have the existing defaults in `docker-compose.yml`.

Make `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `VITE_TURNSTILE_SITE_KEY` available during the build.
Compose maps the first two to the frontend's `VITE_` variables, so the frontend and backend use one Supabase project.
These public values become part of the frontend bundle. A change requires a new build.
Make server keys and tokens available at runtime only. Do not put them in build arguments or `VITE_` variables.
See [Coolify environment scopes](https://coolify.io/docs/applications/configuration/environment-variables).

`NODE_ENV=production`, port `3001`, and disabled LangSmith tracing are fixed in Compose.
Provider API keys remain in Cloudflare AI Gateway's BYOK provider settings.
The image contains no development `.env` files, uploads, recovery audio, or model weights.

Use the existing Supabase production redirect, email, and CAPTCHA configuration.
The site URL must be `https://studio.lau.lu`. Confirmation and recovery redirects must allow this origin.

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

With the required values in an ignored root `.env`, check the container on a Docker host:

```bash
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
docker compose exec studio ffmpeg -version
docker compose exec studio ffprobe -version
docker compose exec studio node -e "fetch('http://127.0.0.1:3001/api/health').then(async r => { if (!r.ok) process.exit(1); console.log(await r.json()); }).catch(() => process.exit(1))"
```

The standalone commands do not install Coolify's public proxy routing.
In Coolify, verify `https://studio.lau.lu/api/health` and reload `/songs`, `/profile`, and `/privacy` directly.
Verify that private API requests still require login and that a missing asset returns HTTP 404.
Confirm that the recovery volume survives a redeploy. Do not trigger paid operations for packaging checks.
