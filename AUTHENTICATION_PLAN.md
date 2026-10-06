# Authentication and audio storage plan

Status: authentication, generated-song R2 storage, saved-song UI, song deletion, and durable usage quotas implemented. Other audio storage remains planned.

## Implemented generated-song storage

The current scope stores generated songs only. Setup and endpoint details are in [the README](README.md#configure-generated-song-storage).
The `songs` table links each song to `auth.users.id` through `owner_id`.
R2 keys use `users/<verified-user-id>/<song-id>.mp3`.
The backend checks ownership before playback, downloads, storage retry, and local processing.
Playback uses the existing authenticated Express endpoint. Signed URLs and browser R2 access remain future options.
Failed saves retain an owned local recovery file. Storage retries do not repeat generation.
If the local write fails, storage retry uses an owned memory copy until the backend restarts.
Completed saves delete their recovery files. Local processing uses separate temporary files with atomic writes and cleanup.
The saved-song page supports playback, downloads, and confirmed deletion through `DELETE /api/songs/<song-id>`.
Deletion verifies ownership and removes the R2 object and local recovery copies before it deletes metadata.
If cleanup fails, metadata remains available for another deletion attempt. A deleted R2 object can make playback unavailable during this retry.
Automatic retention and abandoned-save cleanup remain planned.
Uploads, stems, and cleaned audio remain local. The broader sections below describe the remaining target architecture.

## Authentication phase

The current implementation includes login, open registration, email confirmation, resend confirmation, logout, and password recovery.
It protects application APIs and local audio with Supabase access tokens.
Conversations and local audio directories use the verified user ID.
The browser uses authenticated requests for local audio playback and downloads.

This phase needs only the project URL, publishable key, and Supabase Auth configuration.
It needs no custom database schema, migration, or backend secret key.
See [authentication setup in the README](README.md#configure-authentication).

Generated-song R2 storage, metadata, and durable quotas are implemented.
Quota setup and failure rules are in [the README](README.md#configure-usage-quotas).
The broader saved-audio sections describe future work.

## Goal and scope

Use Supabase Auth for email/password login and open registration with email confirmation.
Use a private Cloudflare R2 bucket for uploaded audio, generated music, separated stems, and cleaned audio.
Keep the React/Vite frontend, Express backend, existing AI providers, and local Python processors.

The first release includes:

- Registration, email confirmation, resend confirmation, login, logout, and password recovery.
- Session restoration and token refresh.
- Authentication on application APIs.
- Separate conversations, request locks, and audio assets for each user.
- Durable audio storage, private playback, and private downloads.
- A small saved-audio list so users can access their files after another login.
- Usage limits and recovery from authentication or storage failures.

Saved chat history, social login, MFA, billing, and public sharing are separate features.
Chat history remains in memory for this release. Audio metadata and files survive backend restarts.

## Current application

- `frontend/src/App.tsx` renders `ChatPage` through `AuthGate`.
- `frontend/src/features/auth/` handles login, registration, confirmation, logout, and recovery.
- `frontend/src/features/chat/api.ts` sends authenticated requests.
- `backend/src/auth.ts` verifies Supabase access tokens before application routes.
- `backend/src/index.ts` serves local audio from the verified user's directories.
- Chat, generation, reset, and context requests use the verified user's conversation.
- `backend/src/agent.ts` keeps agents in an in-memory map.
- `backend/src/audio.ts` resolves local audio URLs and runs Python processors.
- Music generation saves MP3 files in `backend/generated-music/<user-id>/`.
- The audio player fetches private audio with a bearer token and plays a temporary blob URL.
- Download buttons fetch private audio with a bearer token.

Authentication now protects conversation ownership and local audio ownership.
Generated songs now have durable R2 storage and database metadata. Other audio remains local.

## Architecture

| Component | Responsibility |
| --- | --- |
| Supabase Auth | Accounts, passwords, confirmation emails, access tokens, and refresh tokens |
| Supabase Postgres | Audio metadata, ownership, and durable usage counters |
| Express backend | Token verification, ownership checks, AI calls, processing, and R2 operations |
| Private R2 bucket | Durable audio bytes |
| React frontend | Authentication forms, session state, chat, saved audio, and playback |
| Backend filesystem | Temporary processing files and bounded recovery files |

The browser sends its Supabase access token to Express.
Express derives the user ID from verified token claims.
Express uses that ID for conversations, ownership checks, and storage keys.

For playback, Express returns a short-lived R2 GET URL after an ownership check.
The browser reads audio directly from R2.
The signed URL needs no bearer header. Anyone with that URL can use it until expiry.
[R2 presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

Supabase database policies do not protect R2 objects.
The backend must enforce ownership before every storage operation or URL signature.

## 1. Supabase configuration

1. Enable email/password authentication.
2. Enable open registration and require email confirmation.
3. Configure the production site URL.
4. Allow the exact development and production redirect URLs.
5. Configure a custom SMTP provider and sender domain.
6. Configure the confirmation and password recovery templates.
7. Configure password requirements and authentication rate limits.

Custom SMTP is required for public email delivery.
The default Supabase mail service restricts recipients to project team members.
[Supabase SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp)

Use the publishable key in the browser.
Use a separate backend client with a server-only secret key for metadata and usage writes.
Use the publishable client for token verification, with browser session persistence disabled on the server.

The backend secret key bypasses row-level security.
Every backend asset query must include the verified owner ID.
Never send the backend secret key to the browser.
[Supabase API key documentation](https://supabase.com/docs/guides/getting-started/api-keys)

## 2. Frontend authentication

Keep authentication UI, actions, and state in `frontend/src/features/auth/`.
Keep the shared Supabase client in `frontend/src/lib/supabase.ts`.
Keep `App.tsx` limited to application composition.

### User flows

| Flow | Expected behavior |
| --- | --- |
| Register | Collect email and password, then show a message that asks the user to read the confirmation email |
| Confirm email | Process the Supabase callback, clear token material from the URL, and open the authenticated app |
| Resend confirmation | Request another email and show delivery errors or cooldowns |
| Login | Open the app after a successful login and show a focused error after failure |
| Forgot password | Request a recovery email without revealing whether an account exists |
| Recover password | Process the recovery callback and show the new-password form before chat |
| Reload | Restore the session before rendering the protected app |
| Logout | End the session, stop playback, and clear user-specific browser state |

Use `signUp`, `signInWithPassword`, `resend`, `resetPasswordForEmail`, `updateUser`, and `signOut`.
Use the SDK session persistence, token refresh, and `onAuthStateChange` support.
For this client-only app, use the SDK's supported browser callback flow.
Handle invalid, expired, and already-used email links explicitly.
[Supabase password authentication documentation](https://supabase.com/docs/guides/auth/passwords)

Disable repeated submissions while an authentication action runs.
Preserve form inputs after expected failures.
Use labeled inputs, keyboard access, visible focus, and accessible error messages.

Use a shared authenticated request helper in `frontend/src/lib/api.ts`.
Get the current access token for each request.
Keep token refresh behavior in the Supabase SDK.
Do not automatically repeat paid or state-changing requests after a network failure.

On logout or account change, abort browser requests and invalidate pending state updates.
Key the protected application by user ID to separate chat and audio state.
A browser abort does not necessarily cancel backend processing.
Keep backend locks until the operation finishes or fails.

## 3. Backend authentication and conversations

Add authentication middleware in `backend/src/auth.ts`.
Keep HTTP routes in `backend/src/index.ts`.

1. Read `Authorization: Bearer <access_token>`.
2. Verify the token with `supabase.auth.getClaims(token)`.
3. Require valid expiry, the expected project issuer, and a valid user subject.
4. Store the verified user ID in request context.
5. Return `401` for missing or invalid credentials.

Do not authorize requests from decoded, unverified JWT payloads.
[Supabase token verification documentation](https://supabase.com/docs/reference/javascript/auth-getclaims)

Protect chat, context, reset, generation, upload, asset listing, deletion, and signed-URL endpoints.
Place authentication before the upload body parser and expensive operations.
Keep only a minimal health response public. Do not expose provider configuration through that response.

Use one active conversation per user for the MVP.
Use the verified user ID as the agent-map key and request-lock key.
Remove the shared `default` fallback from authenticated HTTP flows.
Ignore client-supplied user IDs or conversation IDs as ownership evidence.
Make context and reset requests operate on the same user conversation.

Pass the trusted user ID into agent invocation state.
Read that ID inside audio tool callbacks.
Never accept tool-generated user IDs, arbitrary storage keys, filesystem paths, or remote URLs as authority.

Keep NDJSON progress, existing request limits, explicit music confirmation, and the global GPU lock.
Expire idle agents to bound memory use.
Use one backend instance initially because conversation state and processing locks remain in memory.

## 4. Audio metadata and ownership

Create an `audio_assets` table through a versioned SQL migration.
The existing Supabase Auth user record supplies the owner ID. A separate profiles table is unnecessary.

| Column | Purpose |
| --- | --- |
| `id` | Server-generated UUID and stable asset reference |
| `owner_id` | Reference to the Supabase user |
| `kind` | `upload`, `music`, `vocals`, `instrumental`, or `cleaned` |
| `object_key` | Unique backend-generated R2 key |
| `name` | Display filename |
| `content_type` | Verified audio content type |
| `size_bytes` | Actual object size |
| `parent_asset_id` | Optional source asset for processed outputs |
| `lyrics` | Optional generated lyrics |
| `status` | `pending`, `ready`, or `deleting` |
| `created_at` | Creation timestamp |

Add an index on `(owner_id, created_at)`.
Enable row-level security.
Allow authenticated users to read their own ready rows.
Revoke direct client insert, update, and delete permissions.
Let the backend write authoritative metadata after ownership checks.
[Supabase row-level security documentation](https://supabase.com/docs/guides/database/postgres/row-level-security)

Use this object-key format:

```text
users/<verified-user-id>/<asset-id>.<extension>
```

Use `assetId` in browser state, API payloads, and tool arguments.
Do not persist signed URLs or use them as asset identity.
The backend resolves each asset ID through an owner-scoped metadata query.
Return `404` for missing assets and assets that belong to another user.
Require the same owner for each source asset and derived output.

## 5. R2 configuration and browser access

1. Create a private R2 bucket.
2. Disable public access through `r2.dev` and public custom domains.
3. Create bucket-scoped credentials with the required object permissions.
4. Store R2 credentials only in the backend environment.
5. Configure the S3 client with the account endpoint and region `auto`.

Add `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` to the backend.
Keep R2 operations in a small `backend/src/r2.ts` module.
[R2 credential documentation](https://developers.cloudflare.com/r2/api/tokens/)
[R2 S3 compatibility documentation](https://developers.cloudflare.com/r2/api/s3/api/)

Configure bucket CORS for the exact frontend origins.
Allow `GET` and `HEAD` for browser reads.
Allow the `Range` request header.
Expose `Content-Length`, `Content-Range`, `Accept-Ranges`, and `ETag` response headers.
CORS permits browser access. It does not enforce ownership.
[R2 CORS documentation](https://developers.cloudflare.com/r2/buckets/cors/)

Issue signed GET URLs with an initial lifetime of 15 minutes.
Return both `url` and `expiresAt`.
Use the R2 S3 endpoint for signed URLs. R2 presigned URLs do not work through custom domains.
[R2 presigned URL documentation](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

Resolve a fresh URL before playback or download after expiry.
On an expired read, resolve one fresh URL and retry the read once.
Preserve playback position during URL replacement.
Do not send the Supabase bearer token to R2.
Exclude signed URLs, credentials, and audio bytes from logs and traces.

Use an attachment response disposition for download URLs.
Do not rely on the browser's `download` attribute for cross-origin downloads.
Keep playback URLs suitable for inline audio and range requests.

## 6. Upload, generation, and local processing

### Upload

1. Authenticate the existing `POST /api/audio` request.
2. Enforce the current 50 MB limit and supported audio formats.
3. Write the request into a private temporary directory.
4. Inspect the actual audio with the existing Python runtime.
5. Create server-owned metadata with `pending` status.
6. Upload the inspected file to R2 with its correct content type.
7. Set the metadata status to `ready`.
8. Return the asset reference only after both operations succeed.
9. Delete temporary files after successful persistence.

Keep uploads through Express initially.
Direct browser uploads need a separate upload-completion flow and server-side inspection.
They do not reduce the work required for this MVP.

### Music generation

1. Authenticate the explicit generation request.
2. Reserve the user's usage allowance before the paid call.
3. Generate music through the existing Cloudflare AI Gateway integration.
4. Persist the returned MP3 and lyrics as an owned asset.
5. Return success only after R2 storage and ready metadata succeed.

If persistence fails after generation, retain the output in a bounded local recovery directory.
Store its owner and recovery reference beside the file.
Report the persistence failure clearly.
Retry storage from the retained output. Do not repeat the paid generation call.
Delete recovery files after successful persistence or the agreed retention period.

### Analysis, stems, and cleanup

1. Resolve the source asset with the trusted user ID.
2. Download the source from R2 through the backend SDK.
3. Enforce file-size and temporary-disk limits during the download.
4. Run the existing analysis conversion, stem separation, or reverb processor.
5. Persist each durable output as a new asset with the same owner.
6. Set `parent_asset_id` to the source asset.
7. Delete temporary input and output files in focused cleanup paths.

Analysis conversion files remain temporary.
For stem separation, expose neither output until both objects and metadata are ready.
On partial failure, delete incomplete objects or retain a recovery reference.
Never return a successful asset that points to a missing object.

R2 and Postgres do not share a transaction.
Use explicit pending state, compensating cleanup, and a small reconciliation task for abandoned operations.
Do not add a general storage framework or a distributed job queue for this release.

The Python runtime, model checkpoints, and GPU remain on the backend host.
R2 stores audio but does not run these processors.

## 7. API and UI changes

| Endpoint | Behavior |
| --- | --- |
| `POST /api/chat` | Accept an optional `audioAssetId` and operate on the authenticated conversation |
| `GET /api/context` | Return context for the authenticated conversation |
| `POST /api/reset` | Reset only the authenticated conversation |
| `POST /api/audio` | Inspect and persist an owned upload |
| `POST /api/music` | Persist owned music after explicit generation confirmation |
| `GET /api/assets` | Return a bounded, paginated list of the user's ready assets |
| `GET /api/assets/:id/url` | Return a signed playback URL after an ownership check |
| `GET /api/assets/:id/download` | Return a signed attachment URL after an ownership check |
| `DELETE /api/assets/:id` | Mark the owned asset as deleting, delete its object, then delete its metadata |

Return stable asset references in upload, music, stems, and cleanup responses.
Update frontend response checks for the new asset shape.
Update audio tools to accept asset IDs instead of local URLs.
Remove the four public audio static routes.

Keep saved-audio UI, state, and API functions in `frontend/src/features/audio/`.
Provide a small list with play, download, and delete actions.
Keep authentication and signed-URL API calls outside presentational audio components.
Keep reusable player controls in `frontend/src/components/ui/`.

Deletion must be retryable after partial failure.
Exclude deleting assets from lists and new signed URLs.
Keep deletion records until object cleanup succeeds.
An already-issued signed URL remains usable until expiry unless the object is deleted.

## 8. Other requirements before public launch

| Requirement | Reason or decision |
| --- | --- |
| Custom SMTP and sender DNS | Public confirmation and recovery emails need reliable delivery |
| Production origin and HTTPS | Auth redirects, API access, and bucket CORS need the actual deployment origin |
| Durable usage limits | Implemented for chat, analysis, generation attempts, and generated-song bytes. Apply the quota migration before launch |
| Request limits | Keep per-user action locks, upload limits, model limits, and the global GPU limit |
| Retention and deletion | Decide how long ready assets, failed outputs, and recovery files remain |
| Temporary disk capacity | Python processing needs local space despite R2 storage |
| Ownership migration | Existing local files have no user ownership |
| Error visibility | Separate auth, provider, storage, and processing failures without exposing secrets |

Supabase stores per-user allowances, daily counters, and atomic reservations for concurrent requests.
Configure allowances for chat, analysis, music generation, and generated-song bytes before public launch.
The quota records survive backend restarts. Uploads, stems, and cleaned audio remain outside the storage quota.
Keep existing turn and token limits. A per-request limit does not enforce a daily allowance.

Preserve existing local files during migration.
Require an explicit owner assignment before importing a file into R2 and metadata.
Keep unassigned files outside authenticated access.
Do not delete originals until the imported object and metadata pass the migration checks.

Use the current backend host for the first release.
Verify that the host supports long processing requests, Python, checkpoints, and sufficient disk space.
If the hosting platform permits it, use same-origin `/api` routing in production.
Otherwise, restrict backend CORS to the configured frontend origin.

## 9. Environment and dependencies

Frontend environment:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

Backend environment:

```env
SUPABASE_URL=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
R2_ACCOUNT_ID=
R2_BUCKET_NAME=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
APP_ORIGIN=
```

Keep SMTP credentials in Supabase configuration.
Keep the existing AI Gateway environment variables.
Add environment examples without real credentials.
Keep manifests and npm lockfiles consistent.

Required new dependencies:

- Frontend: `@supabase/supabase-js`.
- Backend: `@supabase/supabase-js`, `@aws-sdk/client-s3`, and `@aws-sdk/s3-request-presigner`.

## 10. Implementation order

1. Agree on launch origins, SMTP, usage allowances, and retention periods.
2. Configure Supabase Auth, private R2, CORS, and backend secrets.
3. Add the metadata and usage migrations with database access policies.
4. Add frontend auth flows and backend token verification.
5. Separate agent sessions, context requests, and action locks by user ID.
6. Add R2 persistence and trusted asset resolution to uploads and audio tools.
7. Add signed playback, downloads, and the saved-audio list.
8. Add failure recovery, deletion, and cleanup.
9. Import existing files only after explicit owner assignment.
10. Run the required checks and document deployment configuration.

Deploy authentication and private audio access together.
Do not publish an intermediate version that protects chat but exposes audio publicly.

## 11. Acceptance checks

Frontend checks use end-to-end tests only.
Mock paid AI operations in automated checks.

- Register, read the confirmation state, confirm email, and enter the app.
- Resend confirmation and recover from delivery failures or expired links.
- Reject an incorrect password and recover after a correct login.
- Restore a session after reload and refresh an expired access token.
- Recover a password and reject an expired recovery link.
- Logout during a pending request without updating another user's screen.
- Upload audio, play it, display its waveform, and download it.
- Generate mocked music, persist it, and recover after a storage failure without another generation call.
- Separate stems and clean audio without exposing partial outputs.
- Renew an expired signed URL and preserve playback position.
- Access saved audio after logout, another login, and a backend restart.
- Delete an asset and recover from partial deletion failure.

Backend and storage checks:

- Reject missing, expired, malformed, and wrong-project tokens.
- Separate two users' chats, context counters, resets, and action locks.
- Reject another user's asset in listing, signing, deletion, analysis, stems, and cleanup.
- Reject oversized uploads and disguised non-audio files.
- Enforce usage reservations under overlapping requests.
- Preserve pending output after storage failure and clean abandoned objects.
- Keep R2 private and reject unsigned object reads.
- Support browser CORS, seeking, waveform reads, and attachment downloads.

Run these commands after implementation:

```bash
npm run build:frontend
npm run build:backend
npm --prefix frontend run lint
npm --prefix frontend run test:e2e
npm --prefix frontend run test:audio
git diff --check
```

Run focused backend authentication and storage tests as part of implementation.
Adapt the existing frontend E2E fixtures to authenticated sessions and asset references.
Run live email and R2 smoke checks against designated development resources.
Do not make paid AI calls without explicit authorization.

## Decisions still needed

- Production frontend and backend origins.
- Supabase project and R2 bucket.
- SMTP provider, sender address, and sender domain.
- Per-user paid usage allowances and storage allowance.
- Retention periods and the account-deletion policy.
- Owner assignment for existing local audio.

R2 service configuration, database migrations, and live Supabase email checks remain unrun.
