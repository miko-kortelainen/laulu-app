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
│   │   └── index.ts       # Express server with /api/chat and /api/health endpoints
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

Frontend chat E2E check: start `npm run dev:frontend`, then run
`npm --prefix frontend run test:e2e`. It requires the `agent-browser` CLI and
mocks all API calls. Set `E2E_URL` to test another local frontend URL.
