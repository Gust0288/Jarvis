# JARVIS — Setup Reminders

## ✅ Already done (in the code)

### AI & Backend
- 4-model in-app switcher (9B Smart / 7B Balanced / 3B Fast / Nemotron Mini NVIDIA)
- Model choice persisted in localStorage
- Streaming responses with blinking cursor
- Memory injection + context scoring (recency, frequency, category)
- Session consolidation — previous session facts ingested on startup
- Thinking mode enabled on qwen3 models (silent chain-of-thought before answering)
- Temperature 0.35, context window 8192 tokens, repeat penalty — applied to all Ollama calls

### Brain Memory
- Auto-extraction after every exchange with category detection (preference, habit, correction, fact, routine)
- Correction detection — flags when user corrects the AI
- Dedup by Jaccard similarity (boosts importance instead of duplicating)
- Memory panel (🧠 button), add/delete/clear
- Persisted in localStorage

### Voice Input (Whisper via server)
- MediaRecorder captures audio → sends to `SERVER_URL/transcribe` (local Whisper)
- Works in Electron, Chrome, any browser (not dependent on Web Speech API)
- **Insert key** = push-to-talk (tap to start, tap to stop & send)
- **Escape** = interrupt Jarvis mid-speech (or toggle voice on/off if silent)

### Voice Output (TTS)
- Daniel voice ID already configured in App.jsx
- Add `VITE_TTS_API_KEY` in `jarvis-ui/.env.local` if using OpenAI or ElevenLabs TTS
- ⚠️ `TTS_BACKEND` is still set to `"browser"` — change to `"elevenlabs"` or `"openai"` to activate a cloud voice
- ElevenLabs uses streaming MediaSource playback (low latency)
- Real audio amplitude drives the reactor core animation via Web Audio API analyser
- Browser TTS fallback uses simulated amplitude

### Reactor Core Animation
- Amplitude-reactive during speaking (rings speed up, core expands, glow scales)
- Ripple rings expand outward during speech
- 7-bar equalizer below core while speaking
- Distinct states: idle / thinking (amber) / speaking (reactive) / listening (green)

### Electron Desktop App
- Menu bar tray icon ("J") — click to show/hide, close hides to tray
- **⌥Space (Alt+Space)** global shortcut → Spotlight-style quick-ask overlay (any app, any screen)
- Quick overlay relays exchanges to the main window so both share one conversation log
- `open -a "AppName"` IPC — say "open Safari" / "launch Spotify" to open apps
- Mic permissions auto-granted
- Hides to tray on close, proper SIGINT/SIGTERM handling

---

## ⚠️ One thing to do NOW

**ElevenLabs TTS is configured but not activated.** To turn it on:
- Open `jarvis-ui/src/App.jsx`, line 64
- Change: `const TTS_BACKEND = "browser";`
- To: `const TTS_BACKEND = "elevenlabs";`

Also — do not hardcode TTS provider keys in `App.jsx`. Keep them in `jarvis-ui/.env.local`, which is ignored by Git.

---

## 🖥 Mac setup tasks (one-time, when back at computer)

### 1. Install Electron + run
```bash
cd jarvis-ui
npm install --save-dev electron vite-plugin-electron vite-plugin-electron-renderer
npm run dev
```

### 2. Download Daniel Enhanced voice (free, optional if using ElevenLabs)
**System Settings → Accessibility → Spoken Content → System Voice → Manage Voices…**
- Download **Daniel** (Enhanced) under English (UK)

### 3. Start Ollama + server
```bash
ollama serve
# in another terminal:
node jarvis-server.mjs
```
First time:
```bash
ollama pull qwen3.5:9b   # Smart
ollama pull qwen2.5:7b   # Balanced
ollama pull qwen2.5:3b   # Fast
```

---

---

## ⚡ Optional: Free LLM boost (freellmapi)

Pools the free tiers of 16 providers (Groq Llama 3.3 70B, Gemini 2.5 Pro, Mistral, etc.) behind one local proxy. Jarvis auto-detects it — if it's not running, nothing changes.

### Setup
```bash
# 1. Clone and install
git clone https://github.com/tashfeenahmed/freellmapi
cd freellmapi
npm install

# 2. Create .env and add your provider keys (Groq, Google, etc.)
cp .env.example .env
# Edit .env with your keys — each one unlocks that provider's free tier

# 3. Start the proxy (default port 4000)
npm start
```

Once running, a **⚡ FREE LLM** button appears in Jarvis's toolbar. Click it to toggle on/off. When on, all chat responses go through freellmapi instead of local Ollama. If it loses connection mid-response, Jarvis falls back automatically and turns the button off.

To target a specific model, set `FREELLM_MODEL` in App.jsx (e.g. `"meta-llama/llama-3.3-70b-instruct"`). Leave it `""` for smart auto-routing.

**Note:** queries leave your machine when this is active. Tool calls (calendar, notes, app opening) still go through the local server.

---

## 💡 Still to add
- Wake word "Hey Jarvis" — passive listening, no button press needed
- Clipboard tool — "summarize what I copied", "rewrite this", "translate this"
- Music/media control — play, pause, skip, "what's playing?" via Spotify/Apple Music AppleScript
- Live telemetry — real CPU, battery, and network data in the UI panels (currently decorative)
- Export conversation to text file
- Tavily web search — set `TAVILY_API_KEY` env var when starting the server for real web results (free tier at tavily.com)
