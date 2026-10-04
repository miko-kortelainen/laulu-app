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
│   │   ├── user-files.ts  # Per-user local audio directories
│   │   ├── model.ts       # Shared Nebius configuration and model setup
│   │   ├── gateway.ts     # Required Cloudflare AI Gateway BYOK routing
│   │   ├── lyrics.ts      # Dedicated GLM lyric agent
│   │   ├── music.ts       # Music prompt tool and confirmed Lyria 3.5 generation
│   │   ├── audio.ts       # Audio storage, validation, and shared processing jobs
│   │   ├── analysis.ts    # QwenCloud listening analysis tool
│   │   ├── stems.ts       # Local vocal/instrumental separation tool
│   │   ├── dereverb.ts    # Local echo/reverb removal tool
│   │   └── index.ts       # Express server with /api/chat and /api/health endpoints
│   ├── audio-processing/ # Shared Python runtime, model runners, and local weights
│   │   └── models/        # Local model weights and checkpoints (.ckpt, .cpt, .pth; ignored by Git)
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
Login persists across reloads. Logout clears the current browser session and stops its pending requests and audio playback.
Local audio playback and downloads use authenticated requests.
Existing audio without an owner remains on disk but has no public route.
R2 storage, audio metadata, and usage quotas remain in [the next implementation phase](AUTHENTICATION_PLAN.md).

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

### 4. Audio Processing Checkpoints (Optional)

Stem separation and reverb removal require local model checkpoints placed under `backend/audio-processing/models/`. Checkpoint files (`*.ckpt`, `*.cpt`, `*.pth`) are excluded from Git via `.gitignore`:

- **Stem separation:** `backend/audio-processing/models/stems/vocals_mel_band_roformer.ckpt`
- **Reverb removal:** `backend/audio-processing/models/dereverb/UVR-DeEcho-DeReverb.pth`

See [Stem separation](#stem-separation) and [Echo and reverb removal](#echo-and-reverb-removal) below for setup instructions and download details.

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
generating a track, uploading audio, separating stems, or removing echo and reverb.
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
Tracks are saved in `backend/generated-music/`, which Git ignores.
Downloads survive backend restarts. Chat messages remain in the current browser
session; keep the download URL or download the file before reloading.
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
feedback. You can also ask about an available stem or cleaned result. The agent
calls `analyze_audio`, shows **analyzing audio...**, and uses the returned
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

## Stem separation

The agent's `separate_stems` tool uses **MelBand Roformer | Vocals by Kimberley
Jensen** to produce vocals and instrumental WAV files. It runs locally with
CUDA when available and falls back to CPU. It does not separate drums, bass,
or other individual instruments.

Separation uses segment size **256** (112,455 samples at a 441-sample STFT hop),
overlap **8**, and batch size **1**. The model YAML sets the segment and overlap;
the runner processes one chunk per model call. Input audio and each output stem
use a normalization peak ceiling of **0.9** and an amplification peak floor of
**0.7**. Silent audio stays silent. These peak thresholds are set in `normalize_audio`
in `backend/audio-processing/audio.py`. Run separation again to use these settings;
existing stems keep their original audio.

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then run
this command from the repository root:

```bash
uv sync --frozen --project backend/audio-processing
```

The environment uses Python 3.13 and
[`melband-roformer-infer`](https://github.com/openmirlab/melband-roformer-infer).
Keep the supplied checkpoint and config at:

```text
backend/audio-processing/models/stems/vocals_mel_band_roformer.ckpt
backend/audio-processing/models/stems/vocals_mel_band_roformer.yaml
```

The checkpoint is excluded from Git. For a fresh checkout, download the
[Kimberley Jensen checkpoint](https://huggingface.co/KimberleyJSN/melbandroformer)
and save `MelBandRoformer.ckpt` under the checkpoint filename above.
Its SHA-256 is `87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e`.
The runner loads these local files and does not download models during separation.

Use **upload audio** to add an MP3, WAV, FLAC, or OGG file. Uploads must be mono
or stereo, at most 50 MB, and no longer than 10 minutes. The attachment area shows
the filename and an audio player. You can replace or remove it before sending.
Send a message to attach the audio to that message. A failed upload or send keeps
the previous attachment available. Click **separate stems**
on an uploaded or generated track, or ask the agent to isolate its vocals or
create an instrumental version. Chat requests use the latest sent attachment or generated
track, or the track or stem most recently selected with an audio action button.
A successful cleanup selects its cleaned output for follow-up requests.

Each result has two audio players and WAV download links. Sources stay intact
when separation fails. One audio processing job runs at a time, with a 20-minute
timeout. CPU processing can be slow. Uploads are saved in `backend/uploaded-audio/`
and completed stems in `backend/separated-audio/`; Git ignores both directories.
The **new session** button resets chat and leaves audio files in place.

Local integration check: `npm --prefix backend run test:stems`. This requires
the installed Python environment and model files. It separates synthetic audio
and checks upload validation, saved stems, echo removal on tracks and stems,
and failure recovery. It makes no
paid model calls. To check CPU fallback on Linux:

```bash
OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 CUDA_VISIBLE_DEVICES='' npm --prefix backend run test:stems
```

Peak adjustment check: `backend/audio-processing/.venv/bin/python backend/audio-processing/test_audio.py`.

## Echo and reverb removal

The agent's `remove_echo_reverb` tool uses the supplied **UVR-DeEcho-DeReverb**
VR model. It accepts generated tracks, uploads, separated stems, and previous
cleaned results. Ask to remove echo or reverb, or click **remove echo/reverb**
beside an audio player. For clean isolated vocals, ask the agent to separate
vocals first and then clean them.

The result is one cleaned 44.1 kHz floating-point WAV with a player and download.
The model reduces echo and reverb together; it does not guarantee complete removal.
Sources remain intact. Completed results are saved in `backend/cleaned-audio/`
and survive a restart. CPU processing can be slow.

Both audio tools use the environment installed with the command above. The lock
includes audioread for the VR loader and samplerate 0.2.4, whose wheels include
libsamplerate. Model
files are grouped by task:

```text
backend/audio-processing/models/stems/vocals_mel_band_roformer.ckpt
backend/audio-processing/models/stems/vocals_mel_band_roformer.yaml
backend/audio-processing/models/dereverb/UVR-DeEcho-DeReverb.pth
```

Weights are excluded from Git. Copy the supplied `.pth` file to its location
above on a fresh checkout. The runner loads local weights through
[`audio-separator`](https://github.com/nomadkaraoke/python-audio-separator)'s VR loader
and uses the [UVR model metadata](https://github.com/Anjok07/ultimatevocalremovergui/blob/master/models/VR_Models/model_data/model_data.json)
(`4band_v3`, primary stem `No Reverb`). It downloads no model registry at runtime
and uses soundfile without requiring ffmpeg. CUDA or Apple MPS is selected when
available, with CPU fallback. VR uses window size 512 and batch size 1; Roformer
keeps its existing segment size 256 and overlap 8. Both use the 0.9 normalization
ceiling and 0.7 amplification floor.

## LangSmith tracing

Set `LANGSMITH_TRACING=true` and `LANGSMITH_API_KEY` in `backend/.env`, then
restart the backend. `LANGSMITH_PROJECT=musical-copilot` groups the traces.
`LANGSMITH_ENDPOINT` defaults to `https://api.smith.langchain.com`; use
`https://eu.api.smith.langchain.com` for an EU workspace.

Each agent invocation records its input, reply, errors, and duration. Model calls,
`update_music_form`, `separate_stems`, `remove_echo_reverb`, and `analyze_audio` appear as child runs, including model token
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
