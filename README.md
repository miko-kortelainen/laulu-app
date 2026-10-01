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
│   ├── src/
│   │   ├── agent.ts       # Strands Agent setup with OpenAIModel pointing to Nebius Token Factory
│   │   ├── music.ts       # Music prompt tool and confirmed Lyria 3.5 generation
│   │   ├── audio.ts       # Audio storage, validation, and shared processing jobs
│   │   ├── stems.ts       # Local vocal/instrumental separation tool
│   │   ├── dereverb.ts    # Local echo/reverb removal tool
│   │   └── index.ts       # Express server with /api/chat and /api/health endpoints
│   ├── audio-processing/ # Shared Python runtime, model runners, and local weights
│   ├── .env.example       # Sample environment variables
│   ├── .env               # Active environment file (put your NEBIUS_API_KEY here)
│   ├── package.json
│   └── tsconfig.json
│
└── frontend/
    ├── src/
    │   ├── App.tsx        # Application composition
    │   ├── features/chat/ # Chat page, message UI, state hook, and API functions
    │   ├── components/ui/ # Shared component library
    │   ├── lib/           # Shared utilities
    │   ├── index.css      # Tailwind CSS styles
    │   └── main.tsx
    ├── vite.config.ts     # Vite config with Tailwind & proxy to backend (:3001)
    └── package.json
```

---

## Quick Start

### 1. Configure Nebius API Key

Open `backend/.env` and insert your Nebius Token Factory API key:

```env
NEBIUS_API_KEY=your_actual_nebius_api_key
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1
NEBIUS_MODEL=nvidia/nemotron-3-super-120b-a12b
PORT=3001
```

*(Note: If you run without setting an API key, the chatbot automatically runs in demo mode so you can test the UI and API communication immediately).*

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

## Features
- **User sends message:** Interactive chat bar with Enter key submission.
- **Agent answers:** Strands Agents SDK loop powered by Nebius Token Factory + Nemotron Super.
- **Live Health & Status Indicator:** Visual badge displaying backend connection and model state.
- **Clear & Reset:** Button to reset conversation history.

## Music generation

Set `GEMINI_API_KEY` in `backend/.env` to a Gemini API key with access to
[`lyria-3.5`](https://ai.google.dev/gemini-api/docs/music-generation).
Restart the backend after changing this key.

Ask the agent to create music. It prepares a prompt for you to review in chat.
Click **generate music** to approve that exact prompt and start the paid API call.
To change the prompt, tell the agent what to change before you approve it.
Music advice and prompt preparation do not call Lyria.

Prompt preparation follows Google's [Lyria prompt guide](https://ai.google.dev/gemini-api/docs/lyria-prompt-guide)
for Lyria 3.5 batch generation. The agent leads with genre, describes the sound
and song progression, and specifies vocal delivery and lyric language or an
instrumental arrangement. It adds tempo, key, and duration when appropriate.
Supplied lyrics keep their original text under `Lyrics:` with section tags.
Otherwise Lyria writes lyrics from the requested story, emotion, and hook.
Each revised prompt includes the full song brief for review.

The result includes an audio player, an MP3 download, and a lyrics dropdown when
lyrics are returned. Structure markers are removed from the displayed lyrics.
The agent uses plain text and does not repeat the music prompt in its reply.
Tracks are saved in `backend/generated-music/`, which Git ignores.
Downloads survive backend restarts. Chat messages remain in the current browser
session; keep the download URL or download the file before reloading.
Clear resets the conversation and leaves saved tracks in place.

The backend uses the Interactions REST API with `store: false`, reads audio from
`model_output` steps, and allows five minutes for generation. Failed requests
show an error and leave the prompt available for retry. Chat, reset, and music
generation cannot overlap within the same conversation.

Offline backend check: `npm --prefix backend run test:music`.

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
or stereo, at most 50 MB, and no longer than 10 minutes. Click **separate stems**
on an uploaded or generated track, or ask the agent to isolate its vocals or
create an instrumental version. Chat requests use the latest uploaded or generated
track, or the track or stem most recently selected with an audio action button.
A successful cleanup selects its cleaned output for follow-up requests.

Each result has two audio players and WAV download links. Sources stay intact
when separation fails. One audio processing job runs at a time, with a 20-minute
timeout. CPU processing can be slow. Uploads are saved in `backend/uploaded-audio/`
and completed stems in `backend/separated-audio/`; Git ignores both directories.
Clear resets chat and leaves audio files in place.

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
`generate_music`, `separate_stems`, and `remove_echo_reverb` appear as child runs, including model token
usage and tool inputs and results. Conversation session IDs group runs into LangSmith threads.
Confirmed audio generation records a separate `generate_audio` run in the same
thread, with the prompt, download URL, and lyrics. Audio bytes and API keys are
excluded. Prompt preparation still requires user approval before generation.

Tracing sends conversation and music prompt text to LangSmith. Set
`LANGSMITH_TRACING=false` to disable it.

Offline tracing check: `npm --prefix backend run test:tracing`.

Frontend chat E2E check: start `npm run dev:frontend`, then run
`npm --prefix frontend run test:e2e`. It requires the `agent-browser` CLI and
mocks all API calls. Set `E2E_URL` to test another local frontend URL.
