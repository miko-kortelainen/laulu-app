# lau.lu MVP beta plan

Date: 2026-10-08

Status: Item 2 is implemented in the repository. Its database migration is not applied to hosted Supabase. The remaining items are planned.
Hetzner is the selected host. This document does not authorize deployment.

## Goal

Launch a small public beta to check the complete product on a real domain.
Users can register, chat, generate songs, analyze audio, and manage their own songs.
Billing and paid tiers come later.

## Decisions from this chat

| Item | Decision |
| --- | --- |
| Hosting | Hetzner |
| Domain | The user owns `lau.lu` |
| Landing page | `lau.lu`, preferably hosted separately |
| Studio address | Recommend `studio.lau.lu` |
| Registration | Email/password accounts with email confirmation |
| Free generation | Five completed songs per account per day |
| Generation failures | Restore personal allowance after a confirmed generation failure |
| Chat | 20 user messages per account per day |
| Lyrics | Lyrics through chat count within the chat allowance |
| Uploads | Keep audio uploads |
| Analysis | Keep Qwen audio analysis |
| Stem separation | Delete completely from the MVP and codebase |
| Dereverb | Delete completely from the MVP and codebase |
| Billing | Defer billing, subscriptions, and paid tiers |

The daily reset uses UTC midnight. The interface displays the reset time in the user’s local time.
Allowances stay configurable through the existing backend quota path.

## Product scope

The beta includes these flows:

- Email registration, email confirmation, confirmation resend, login, password recovery, and logout.
- Chat with the music assistant.
- Edit the music form and approve the prepared prompt before generation.
- Generate up to five completed songs daily.
- Upload audio and request Qwen analysis.
- View private songs at `/songs`.
- Listen to, download, and delete generated songs.
- Retry a failed save without another generation call.
- View the remaining allowances and the daily reset time.
- Keep the existing basic `/profile` page.

The beta does not need persistent chat history, public song sharing, collaboration, or extra profile features.
Chat sessions can reset after expiration or a backend restart.
Account data, quotas, and saved songs must survive a restart.

## Hosting plan

Use one Hetzner server and one backend instance initially.
Existing conversation state, operation locks, and temporary files assume one backend instance.

Recommended starting configuration:

- An x86 Linux server with two CPU cores and 4 GB RAM.
- Ubuntu LTS.
- Free, self-hosted Coolify for deployment, HTTPS, and container management.
- One application container with the built frontend, Node.js backend, and remaining Python audio environment.
- Persistent mounted directories for generated-song recovery and necessary temporary audio.

Coolify is a recommendation, not a separate confirmed user choice.
Its documented minimum is two CPU cores, 2 GB RAM, and 10 GB disk space.
The 4 GB recommendation provides space for the application and audio conversion.
Measure memory use before public launch.

The CX23 was discussed as a starting candidate.
Hetzner lists its monthly price as €5.49 before VAT and IPv4.
Availability and the final checkout price remain unconfirmed.
Backups and external services can add costs.

Keep the existing external services:

| Responsibility | Service |
| --- | --- |
| Accounts and login | Supabase Auth |
| Song metadata and durable quotas | Supabase Postgres |
| Saved generated songs | Private Cloudflare R2 bucket |
| Hosted AI requests | Cloudflare AI Gateway BYOK |
| Chat and lyrics | Existing Nebius integration |
| Music generation | Existing Google/Lyria integration |
| Audio analysis | Existing Qwen integration |

A GPU is unnecessary after deletion of stem separation and dereverb.
Python remains necessary for audio validation and conversion.
Keep the required `numpy`, `soundfile`, and `librosa` dependencies.

Railway, Heroku, and Azure were alternatives. Hetzner replaces those options in this plan.
The user has $312 Heroku student credits and $100 Azure student credits.
Heroku applies at most $13 monthly, with no monthly rollover.
Azure credits do not fund Hetzner or the existing external AI providers.

## Domain and routing

Recommended routing:

| Address | Destination |
| --- | --- |
| `https://lau.lu` | Separate landing page |
| `https://studio.lau.lu/` | Studio and chat |
| `https://studio.lau.lu/songs` | Private song library |
| `https://studio.lau.lu/profile` | Existing basic profile |
| `https://studio.lau.lu/api/*` | Backend API |

The studio frontend and API share one origin.
This arrangement matches the existing `/api/` requests and avoids a `/studio` base-path change.
Frontend routes need an `index.html` fallback.
The fallback must exclude API routes.

Configure DNS and HTTPS for the studio hostname.
Configure Supabase production redirects for the studio hostname.
Configure the Turnstile widget for the studio hostname.
The landing page host remains undecided.

## Required work before public launch

### 1. Delete unused audio features

- [ ] Delete stem and dereverb tools from the agent configuration and prompts.
- [ ] Delete their backend modules, HTTP routes, result types, and progress labels.
- [ ] Delete their Python runners, model references, and heavy dependencies.
- [ ] Delete obsolete frontend contracts and references.
- [ ] Update package manifests and lockfiles together.
- [ ] Delete obsolete tests, fixtures, and documentation.
- [ ] Preserve upload validation, analysis conversion, playback, and failure recovery.

Hiding controls is insufficient. The current backend still exposes these features through agent tools.
Delete only obsolete model files and outputs during the agreed cleanup.
Preserve uploaded audio and generated songs that the retained flows need.

### 2. Apply the agreed allowances

- [x] Change the chat default from 50 to 20 user messages daily.
- [x] Prepare a migration to lower existing chat allowances above 20. Preserve disabled and stricter accounts.
- [x] Keep lyrics inside the chat allowance.
- [x] Change generation accounting from attempts to completed songs.
- [x] Reserve allowance before a paid request to prevent concurrent overspending.
- [x] Restore personal song allowance exactly once after a confirmed generation failure.
- [x] Preserve the reservation while the provider outcome remains unknown.
- [x] Keep the original quota date for operations that cross UTC midnight.
- [x] Display remaining allowances and the reset time.

Apply `supabase/migrations/20261008141601_beta_allowances.sql` with the updated backend.
Update an existing `QUOTA_CHAT_DAILY=50` environment setting to `20` before restart.
Historical unknown outcomes stay reserved. Item 3 will add automatic reconciliation after interrupted operations.

If storage fails after a completed generation, the generation still counts once.
A save retry uses the same song and reservation.
Deleting a completed song does not restore generation allowance.
A browser disconnect does not prove that generation failed.

Recommended unchanged limits, subject to review:

- Audio analysis: the existing limit of 10 requests per account daily.
- Saved songs: the existing 512 MiB limit per account.

Temporary uploads and recovery files need separate server disk limits.
They do not count as saved-song storage.

### 3. Recover long operations and interrupted requests

- [ ] Give each generation a durable operation ID and database state.
- [ ] Return the operation ID promptly instead of holding one request for the whole generation.
- [ ] Let the frontend read progress and recover the result after a reload.
- [ ] Apply the same approach to long analysis requests where necessary.
- [ ] Preserve completed audio on the server volume before reliance on a save retry.
- [ ] Reconcile unfinished operations after a backend restart.
- [ ] Add bounded cleanup for abandoned reservations, recovery files, and temporary analysis files.
- [ ] Fix operation locks after aborted requests, including saved-song deletion.
- [ ] Keep locks until server work ends. A browser disconnect does not end server work.
- [ ] Preserve the music form and attachment after failures.

Current Lyria requests can run for five minutes before the storage step.
Provider timeouts, browser disconnects, and server restarts need explicit handling.
Unknown provider outcomes must not trigger automatic paid generation retries.
The plan needs no new Redis service or general queue framework for the initial single-server beta.

### 4. Control total spending and resource use

- [ ] Select an affordable app-wide daily limit for chat, analysis, and generation.
- [ ] Keep global generation attempts charged after personal failure refunds.
- [ ] If the global limit is exhausted, stop paid operations.
- [ ] If quota storage is unavailable, keep paid operations disabled.
- [ ] Configure provider spending controls where available.
- [ ] Enable email confirmation and the existing Turnstile integration for public registration.
- [ ] Bound concurrent uploads and audio conversion.
- [ ] Reject oversized uploads before they exhaust server memory or disk.
- [ ] Restrict API origins to the intended production and development origins.

The example configuration currently lists global daily caps of 200 chats, 30 analyses, and 20 generation attempts.
These values are a starting reference, not an agreed cash budget for this beta.
The backend defaults missing global limits to zero, which disables paid operations.
Personal allowances never override global safety limits.
The interface must explain this limit to users.

Five songs per user daily does not limit total spending across an unlimited number of accounts.
Failed or uncertain calls can still cost money.
Keep a bounded attempt policy without changing the promised five-completed-song allowance.

### 5. Prepare public authentication and private data

- [ ] Configure custom SMTP for confirmation and password recovery emails.
- [ ] Configure the mail provider’s domain records.
- [ ] Exercise confirmation and recovery links on `studio.lau.lu`.
- [ ] Keep Supabase secret keys, R2 credentials, and gateway credentials on the backend.
- [ ] Preserve ownership checks for every song and local audio request.
- [ ] Keep R2 public access disabled.
- [ ] Preserve RLS and server-only quota writes.
- [ ] Add short privacy and beta-limit information that matches actual data handling.
- [ ] Decide whether production tracing can send chat and prompt text to LangSmith.

Supabase’s default mail service does not support public registration emails to arbitrary addresses.
Custom SMTP is a launch requirement for this registration flow.

### 6. Package and deploy on Hetzner

- [ ] Select an available server and review its complete monthly price.
- [ ] Configure SSH access, the firewall, and operating-system updates.
- [ ] If the Coolify recommendation is accepted, install Coolify.
- [ ] Build a production image without local model weights or development secrets.
- [ ] Install the remaining Python runtime at the location the backend expects.
- [ ] Configure the frontend’s public values at build time.
- [ ] Configure backend secrets at runtime.
- [ ] Mount persistent recovery directories outside the replaceable container filesystem.
- [ ] Apply the required database migrations with the matching backend version.
- [ ] Configure the studio domain, HTTPS, and frontend route fallback.
- [ ] Configure health checks, bounded logs, and disk monitoring.
- [ ] Configure backups for recovery data and a database backup procedure.
- [ ] Exercise restore and rollback procedures.

Coolify does not remove responsibility for server updates, backups, and disk capacity.
The initial single-server deployment can have short maintenance interruptions.

## Launch checks

Use offline backend tests and frontend end-to-end tests first.
Use isolated temporary directories for tests that modify audio files.
Do not make paid provider calls without explicit authorization.

- [ ] Production frontend and backend builds pass.
- [ ] The frontend linter passes.
- [ ] Registration, confirmation, resend, login, recovery, and logout work on the production domain.
- [ ] A user can send 20 messages, and the next message stops before paid work.
- [ ] A user can complete five songs, and the next generation stops before paid work.
- [ ] Concurrent generation requests cannot exceed the allowance.
- [ ] A confirmed generation failure restores personal allowance once.
- [ ] An uncertain outcome remains reserved until reconciliation.
- [ ] A save retry makes no new generation call.
- [ ] Reloads, disconnects, and backend restarts do not duplicate paid work or permanently lock an account.
- [ ] Songs, quotas, and recovery audio survive a container replacement.
- [ ] Users cannot read, download, retry, or delete another account’s audio.
- [ ] Playback, seeking, downloads, and deletion work for private songs.
- [ ] Uploads and Qwen analysis work after deletion of the heavy audio dependencies.
- [ ] Oversized uploads fail clearly and preserve valid state.
- [ ] A UTC reset and operations across midnight use the correct quota day.
- [ ] Global caps stop paid work across multiple accounts.
- [ ] Database, provider, and storage failures preserve state and report usable errors.
- [ ] The largest allowed upload and modest concurrent usage fit the server’s memory and disk limits.
- [ ] All stem and dereverb references are deleted from the active codebase.

Launch with a small group of testers before broad promotion.
Observe actual provider costs, memory, failed operations, and save recovery.
Adjust the global limits before accepting more traffic.

## Items still to finalize

- Exact Hetzner server, location, availability, and final price.
- Coolify or a smaller Docker deployment managed directly.
- Separate landing page host.
- Daily provider budget and global caps.
- Maximum generation attempts before a temporary account limit.
- Whether to retain the proposed 10-analysis daily limit.
- SMTP provider and sender address.
- Backup retention and production tracing policy.

These choices do not authorize billing work or extra product features.

## Later work

Billing, paid tiers, and credits follow a successful beta.
Reuse the durable reservation path for that later work.
Additional servers and persistent chat history need a separate requirement.

## Sources

Hosting prices and offers reflect the discussion on 2026-10-08. Review them before purchase.

- [Hetzner pricing adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/)
- [Coolify on Hetzner](https://docs.hetzner.com/cloud/apps/list/coolify/)
- [Coolify requirements](https://coolify.io/docs/start-with-self-hosted)
- [Coolify pricing](https://coolify.io/pricing)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Supabase CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha)
- [Heroku student credits](https://help.heroku.com/Z3RHNRHD/how-does-the-heroku-for-github-students-program-work)
- [Azure student offer](https://azure.microsoft.com/en-us/free/students/)

## Verification status

This document records the plan and item 2 implementation. It does not certify production readiness.
Item 2 passes backend quota, music, authentication, and song tests against offline services and a disposable local database.
The local database checks cover concurrent reservations, repeated refunds, ownership, global limits, and UTC date changes.
Both builds and the frontend linter pass. Browser checks cover allowance refresh and failure recovery.
No hosted migrations, deployments, or paid provider calls ran.
