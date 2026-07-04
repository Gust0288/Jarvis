# JARVIS on your Mac — Setup & Development Guide

Three pieces: the **UI** (jarvis-interface.jsx), the **brain** (Ollama/Llama), and the **hands** (jarvis-server.mjs). The server is the only thing that touches macOS, and it never executes a write action without you tapping AUTHORIZE in the HUD.

```
You ⇄ JARVIS UI (browser) ⇄ jarvis-server.mjs (localhost:7077) ⇄ Ollama (qwen3.5)
                                      ↓ osascript (after confirmation)
                              Calendar.app / Notes.app
```

## Part 1 — First run (15 minutes)

**1. Brain.** Install Ollama from ollama.com, then:
```bash
ollama pull qwen3.5:9b   # or qwen3.5:4b on 8GB Macs
ollama serve        # skip if the Ollama menu bar app is already running
```

**2. Hands.** Put `jarvis-server.mjs` somewhere sensible and run:
```bash
node jarvis-server.mjs
# → JARVIS tool server — http://127.0.0.1:7077
```
Requires Node 18+. No npm install needed — zero dependencies.

**3. Face.** Create a Vite app and drop the UI in:
```bash
npm create vite@latest jarvis-ui -- --template react
cd jarvis-ui && npm install
# replace src/App.jsx with jarvis-interface.jsx (rename it App.jsx)
npm run dev         # → http://localhost:5173
```
`BACKEND` in the file is already set to `"server"`.

**4. macOS permissions.** The first time JARVIS creates an event or note, macOS will pop a dialog: *"Terminal" wants to control "Calendar"*. Click OK. If you miss it: System Settings → Privacy & Security → Automation → enable Calendar and Notes for your terminal app (Ghostty, in your case).

**5. Test.** Say or type: *"Add a note titled Groceries with milk and bread"* → amber confirmation card appears → AUTHORIZE → check Notes.app. Then: *"Add dentist appointment Thursday at 14"* → check Calendar.app.

## Part 2 — How the safety model works (worth understanding before extending)

- **Allowlist by architecture.** The model can only request tools that exist in `EXECUTORS`. There is no shell access, no eval, no generic "run command" tool. Adding power means consciously writing a new executor.
- **Two-phase writes.** `/chat` never executes anything — it parks the action in a `pending` map and returns a description. Only `/confirm` (your tap) executes. Keep this pattern for every future write tool.
- **Localhost only.** The server binds 127.0.0.1, so nothing on your network can reach it.
- **Input sanitizing.** Arguments are stripped of quotes/backslashes before entering AppleScript. Keep `sanitize()` around every string you interpolate.
- **Prompt injection awareness.** Today the model only sees what you type, which is low-risk. The day you add a tool that *reads* external content (web pages, emails), that content could try to trick the model into calling write tools — the confirmation gate is your defense, so never remove it for convenience.

## Part 3 — Development roadmap

**Stage 1 — More read/write tools (easy wins).** Each is ~20 lines in the server: define it in `TOOLS`, write an executor, add a `describeAction` line. Good candidates:
- `add_reminder` — Reminders.app via AppleScript, same pattern as Notes
- `get_today_events` — read-only, so no confirmation needed; lets JARVIS answer "what's my day look like?"
- `open_app` / `open_url` — `execFile("open", ["-a", name])`, very satisfying with voice
- `run_shortcut` — `shortcuts run "Name"` unlocks everything you build in the Shortcuts app (HomeKit, Do Not Disturb, music) without writing more AppleScript

**Stage 2 — Quality of life.**
- Wake word: continuous SpeechRecognition listening for "Jarvis" before activating push-to-talk
- Streaming: switch Ollama to `stream: true` and SSE so JARVIS starts speaking as tokens arrive (the current wait will feel slow once you're used to it)
- Morning briefing: a cron job or LaunchAgent that hits `/chat` at 8:00 with "summarize my calendar today" and notifies you
- Run the server permanently with a LaunchAgent plist or `pm2` so it survives reboots

**Stage 3 — Bigger architecture (when you outgrow this).**
- **MCP** — the Model Context Protocol is the standardized version of your tool server. Rewriting your tools as an MCP server means Claude Code, Claude Desktop, and other clients can use them too. You already know MCP from your Claude Code setup; this is the natural convergence point.
- **OpenClaw** — if you want messaging integration (control your Mac from WhatsApp/Telegram), it's the established project for that. Read its security guide first; you'll now understand exactly what its allowlists and sandboxing are protecting against, because you built the small version.
- **Memory** — give JARVIS persistence by having the server log conversations to markdown and injecting a summary into the system prompt. Pairs naturally with your Obsidian vault.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Boot shows CLOUD FALLBACK gate | Server or Ollama not running — start both, hit RETRY LOCAL CORE |
| "MODEL NOT PULLED" | `ollama pull qwen3.5:9b` — must match `MODEL` in the server |
| Action authorized but nothing in Calendar | Automation permission denied — System Settings → Privacy & Security → Automation. Also: by default events go to your first *writable* calendar; to target a specific one, start the server with `CALENDAR_NAME="Hjem" node jarvis-server.mjs` |
| Llama calls tools when you just said hi | Small-model issue — try `llama3.1:8b`, or sharpen the PERSONA instruction |
| Port conflict on 7077 | Change `PORT` in the server and `SERVER_URL` in the UI |
