# JARVIS

JARVIS is a local-first desktop AI assistant for macOS. The main app is a React/Vite holographic-style interface backed by a local Node server that talks to Ollama and can use macOS tools such as Calendar, Notes, app launching, weather, web search, and news.

JARVIS can also use `freellmapi`, an optional OpenAI-compatible proxy that routes requests across configured free-tier LLM providers. Keep `freellmapi` as a separate local checkout; this repository ignores it so provider keys, databases, and its own project history do not get mixed into the public Jarvis repo.

## Project Structure

```text
.
├── Makefile                 # Starts the local server, FreeLLMAPI, and UI together
├── SETUP.md                 # Personal setup notes and feature checklist
├── jarvis-server.mjs        # Local JARVIS tool server on 127.0.0.1:7077
└── jarvis-ui/               # React + Vite + Electron desktop UI
│   ├── electron/            # Electron main/preload source
│   ├── public/              # Static icons
│   ├── src/                 # Assistant UI, quick ask overlay, styling, assets
│   └── package.json         # UI scripts and dependencies
```

## Purpose

- `jarvis-server.mjs` keeps privileged actions local. It binds to localhost, uses Ollama for model calls, and requires confirmation before write actions such as creating Calendar events or Notes.
- `jarvis-ui/` provides the desktop assistant experience, including chat, voice input/output hooks, model switching, memory, task parsing, and a quick-ask Electron overlay.
- `freellmapi/` is optional and intentionally ignored by Git. Clone it locally only when you want cloud/free-tier model routing.

## Running Locally

Install the UI dependencies first:

```bash
cd jarvis-ui
npm install
```

If you want the optional FreeLLMAPI boost, clone and configure it separately in the repository root:

```bash
git clone https://github.com/tashfeenahmed/freellmapi.git freellmapi
cd freellmapi
npm install
cp .env.example .env
```

Start everything from the repository root after `freellmapi/` exists:

```bash
make start
```

You can also run the parts separately:

```bash
node jarvis-server.mjs
cd jarvis-ui && npm run dev
cd freellmapi && npm run dev
```

## Environment and Secrets

Do not commit real API keys, provider keys, local databases, generated builds, or machine-specific settings. The root `.gitignore` excludes `.env` files, `node_modules`, build outputs, SQLite data, logs, `.DS_Store`, local tool settings, and the local `freellmapi/` checkout.

For the UI, use Vite-prefixed environment variables when keys are needed:

```bash
VITE_TTS_API_KEY=...
VITE_FREELLM_KEY=...
```

Before pushing to a public GitHub repository, rotate any keys that were ever committed or shared, and check the staged files with:

```bash
git status --short
git diff --cached --stat
```
