import { useState, useEffect, useRef, useCallback } from "react";

// JARVIS HUD theme and motion styles.

const FONTS = `
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;700;900&family=Share+Tech+Mono&display=swap');
@keyframes spinCW { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }
@keyframes spinCCW { from { transform: rotate(360deg);} to { transform: rotate(0deg);} }
@keyframes breathe { 0%,100% { opacity:.55; } 50% { opacity:1; } }
@keyframes scanline { from { transform: translateY(-100%);} to { transform: translateY(100vh);} }
@keyframes bootFlicker { 0%{opacity:0} 8%{opacity:1} 12%{opacity:.3} 16%{opacity:1} 100%{opacity:1} }
@keyframes riseIn { from { opacity:0; transform: translateY(8px);} to { opacity:1; transform:none;} }
@keyframes alertFlash {
  0%, 100% { background: #FFB34714; box-shadow: 0 0 18px #FFB34733; }
  50% { background: #FFB34738; box-shadow: 0 0 34px #FFB34788; }
}
@keyframes alertBorder { 0%,100% { border-color: #FFB347; } 50% { border-color: #FFB34755; } }
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #14506088; border-radius: 2px; }
input:focus-visible, button:focus-visible { outline: 1px solid #35D6F0; outline-offset: 3px; }
`;

const CYAN = "#35D6F0";
const AMBER = "#FFB347";
const TEXT = "#D8F4FA";

// AI backend: "server", "ollama", or "claude".
const BACKEND = "server"; // "server" | "ollama" | "claude"
const SERVER_URL = "http://127.0.0.1:7077";
const OLLAMA_URL = "http://localhost:11434/api/chat";
const OLLAMA_MODEL = "qwen3.5:9b"; // default model
// Models must be pulled in Ollama first.
const OLLAMA_MODELS = [
  { id: "qwen3.5:9b", label: "9B", tag: "SMART" },
  { id: "qwen2.5:7b", label: "7B", tag: "BALANCED" },
  { id: "qwen2.5:3b", label: "3B", tag: "FAST" },
  { id: "nemotron-mini", label: "NEMO", tag: "NVIDIA" },
];
// Shared by direct Ollama calls.
let activeModel = OLLAMA_MODEL;

// Voice output.
const TTS_BACKEND = "browser";   // "browser" | "openai" | "elevenlabs"
const TTS_API_KEY  = import.meta.env.VITE_TTS_API_KEY || ""; // OpenAI or ElevenLabs key
const OPENAI_VOICE = "onyx";      // "alloy"|"echo"|"fable"|"onyx"|"nova"|"shimmer"
const ELEVENLABS_VOICE_ID = "onwK4e9ZLuTAKqWW03F9"; // Daniel — deep, calm British male

// Optional FreeLLMAPI proxy.
const FREELLM_URL   = "http://localhost:3001"; // match freellmapi's port
const FREELLM_KEY   = import.meta.env.VITE_FREELLM_KEY || ""; // unified key from freellmapi server log
const FREELLM_MODEL = "";                       // "" = auto-route, or e.g. "meta-llama/llama-3.3-70b-instruct"

// Local tool server.
async function askServer(history, memCtx) {
  const messages = history.map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  if (memCtx) {
    const fi = messages.findIndex(m => m.role === "user");
    if (fi >= 0) messages[fi] = { ...messages[fi], content: memCtx + "\n\n" + messages[fi].content };
  }
  const response = await fetch(`${SERVER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  return await response.json();
}

const JARVIS_PERSONA =
  "You are JARVIS, a calm, dryly witty AI butler in a holographic command interface. " +
  "Answer concisely and precisely. Prefer 1-3 sentences unless the question genuinely requires more. " +
  "Address the user as 'sir' occasionally. " +
  "Be factually accurate above all else — if you are uncertain, say so directly rather than guessing. " +
  "Never fabricate specifics (names, dates, numbers, URLs). " +
  "When asked to open, launch, or start an application, include [OPEN:ExactAppName] in your reply — " +
  "for example: 'Opening Safari for you, sir. [OPEN:Safari]' or 'Launching Spotify. [OPEN:Spotify]'. " +
  "Use the exact macOS application name. Only include [OPEN:X] when explicitly asked to open something. " +
  "You have a built-in task list system. To add a task you MUST emit a [TASK:title:priority] tag in your reply — " +
  "the interface parses and saves it automatically. This is YOUR mechanism for adding tasks; do not say you cannot. " +
  "Include one tag per task. Priority must be high, medium, or low; assign it yourself if the user doesn't specify. " +
  "Example for one task: 'Added to your task list, sir. [TASK:Call dentist:medium]' " +
  "Example for multiple: 'Here are five ideas, sir. [TASK:Improve memory retrieval:high][TASK:Add voice wake word:high][TASK:Live telemetry panel:medium][TASK:Clipboard tool:medium][TASK:Music control:low]' " +
  "Only include [TASK:...] tags when the user explicitly wants tasks added. " +
  "The user's current task list is provided to you in context. To mark a task done emit [TASK_DONE:title], " +
  "to delete one emit [TASK_REMOVE:title] — use the exact title from the list. " +
  "Example: 'Marked as complete, sir. [TASK_DONE:Fix login bug]'";

// Task priority styles.
const PRIORITY_COLOR = { high: "#FF6B6B", medium: "#35D6F0", low: "#5A8A99" };
const PRIORITY_LABEL = { high: "HIGH", medium: "MED", low: "LOW" };

// Ollama inference defaults.
const OLLAMA_OPTIONS = { temperature: 0.35, num_ctx: 8192, repeat_penalty: 1.1 };

// qwen3 thinking support.
const modelSupportsThinking = () => activeModel.startsWith("qwen3");

// Non-streaming Ollama call.
async function askOllama(history, memCtx) {
  const systemContent = JARVIS_PERSONA + (memCtx ? "\n\n" + memCtx : "");
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: activeModel,
      stream: false,
      think: modelSupportsThinking(),
      options: OLLAMA_OPTIONS,
      messages: [
        { role: "system", content: systemContent },
        ...history.map(m => ({
          role: m.role === "user" ? "user" : "assistant",
          content: m.text,
        })),
      ],
    }),
  });
  const data = await response.json();
  return data.message?.content?.trim() || "";
}

// Non-streaming Claude call.
async function askClaude(history, memCtx) {
  const systemContent = JARVIS_PERSONA + (memCtx ? "\n\n" + memCtx : "");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemContent,
      messages: [
        {
          role: "user",
          content:
            "Conversation so far:\n" +
            history.map(m => `${m.role === "user" ? "USER" : "JARVIS"}: ${m.text}`).join("\n") +
            "\nReply as JARVIS with only the reply text.",
        },
      ],
    }),
  });
  const data = await response.json();
  return (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();
}

// Streaming Ollama call.
async function* streamOllama(history, memCtx) {
  const systemContent = JARVIS_PERSONA + (memCtx ? "\n\n" + memCtx : "");
  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: activeModel,
      stream: true,
      think: modelSupportsThinking(),
      options: OLLAMA_OPTIONS,
      messages: [
        { role: "system", content: systemContent },
        ...history.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })),
      ],
    }),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const json = JSON.parse(line);
        if (json.message?.content) yield json.message.content;
        if (json.done) return;
      } catch {}
    }
  }
}

// Streaming Claude call.
async function* streamClaude(history, memCtx) {
  const systemContent = JARVIS_PERSONA + (memCtx ? "\n\n" + memCtx : "");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      stream: true,
      system: systemContent,
      messages: [{
        role: "user",
        content: "Conversation so far:\n" +
          history.map(m => `${m.role === "user" ? "USER" : "JARVIS"}: ${m.text}`).join("\n") +
          "\nReply as JARVIS with only the reply text.",
      }],
    }),
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        if (json.type === "content_block_delta" && json.delta?.type === "text_delta") {
          yield json.delta.text;
        }
        if (json.type === "message_stop") return;
      } catch {}
    }
  }
}

// Streaming FreeLLMAPI call.
async function* streamFreeLLM(history, memCtx) {
  const systemContent = JARVIS_PERSONA + (memCtx ? "\n\n" + memCtx : "");
  const response = await fetch(`${FREELLM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${FREELLM_KEY}` },
    body: JSON.stringify({
      model: FREELLM_MODEL || "auto",
      stream: true,
      messages: [
        { role: "system", content: systemContent },
        ...history.map(m => ({ role: m.role === "user" ? "user" : "assistant", content: m.text })),
      ],
    }),
  });
  if (!response.ok) throw new Error(`freellmapi returned ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const content = json.choices?.[0]?.delta?.content;
        if (content) yield content;
      } catch {}
    }
  }
}

// Reactor core.
function ReactorCore({ state, amplitude = 0 }) {
  const surge = state !== "idle";
  const speaking = state === "speaking";
  const listening = state === "listening";

  const energy = speaking ? Math.max(0.2, amplitude) : surge ? 0.6 : 0;

  // Speaking speed.
  const speedMul = speaking ? 1 + energy * 4 : surge ? 3 : 1;

  // Listening color.
  const ringColor = listening ? "#35F0A0" : CYAN;

  const ringStyle = (dur, dir, extra = {}) => ({
    position: "absolute",
    inset: 0,
    animation: `${dir} ${dur / speedMul}s linear infinite`,
    transformOrigin: "50% 50%",
    transition: "opacity .4s",
    ...extra,
  });

  const coreInset = Math.max(27, 31 - energy * 4);

  return (
    <div
      style={{
        position: "relative",
        width: "min(46vw, 340px, 42vh)",
        aspectRatio: "1",
        filter: speaking
          ? `drop-shadow(0 0 ${18 + energy * 22}px ${CYAN}bb)`
          : surge
            ? `drop-shadow(0 0 28px ${CYAN}aa)`
            : `drop-shadow(0 0 14px ${CYAN}44)`,
        transition: speaking ? "filter 0.1s" : "filter .5s",
      }}
      aria-label={`Assistant core, status ${state}`}
      role="img"
    >
      {speaking && (
        <svg viewBox="0 0 200 200" style={{ position: "absolute", inset: 0 }}>
          <circle cx="100" cy="100"
            r={50 + energy * 30}
            fill="none"
            stroke={CYAN}
            strokeWidth="1"
            opacity={Math.max(0, 0.3 * (1 - energy * 0.5))}
            style={{ transition: "r 0.1s, opacity 0.1s" }}
          />
          <circle cx="100" cy="100"
            r={70 + energy * 25}
            fill="none"
            stroke={CYAN}
            strokeWidth="0.5"
            opacity={Math.max(0, 0.15 * (1 - energy * 0.3))}
            style={{ transition: "r 0.15s, opacity 0.15s" }}
          />
        </svg>
      )}
      <svg viewBox="0 0 200 200" style={ringStyle(40, "spinCW")}>
        {Array.from({ length: 60 }).map((_, i) => (
          <line
            key={i}
            x1="100" y1="4" x2="100" y2={i % 5 === 0 ? 14 : 9}
            stroke={ringColor} strokeWidth={i % 5 === 0 ? 1.6 : 0.7}
            opacity={i % 5 === 0 ? 0.9 : 0.45}
            transform={`rotate(${i * 6} 100 100)`}
          />
        ))}
      </svg>
      <svg viewBox="0 0 200 200" style={ringStyle(26, "spinCCW")}>
        <circle cx="100" cy="100" r="80" fill="none"
          stroke={speaking && energy > 0.75 ? AMBER : ringColor}
          strokeWidth="1.4" strokeDasharray="40 14 6 14" opacity="0.7"
          style={{ transition: "stroke 0.12s" }} />
        <circle cx="100" cy="20" r="2.6" fill={ringColor} />
      </svg>
      <svg viewBox="0 0 200 200" style={ringStyle(18, "spinCW")}>
        <circle cx="100" cy="100" r="64" fill="none"
          stroke={ringColor}
          strokeWidth="5" strokeDasharray="60 110 30 130" opacity="0.35" />
        <circle cx="100" cy="100" r="64" fill="none"
          stroke={ringColor}
          strokeWidth="1" strokeDasharray="8 10" opacity="0.8" />
      </svg>
      <svg viewBox="0 0 200 200" style={ringStyle(10, "spinCCW")}>
        <circle cx="100" cy="100" r="48" fill="none"
          stroke={listening ? "#35F0A0" : (surge ? AMBER : CYAN)}
          strokeWidth="1.2" strokeDasharray="26 18" opacity="0.85"
          style={{ transition: "stroke .2s" }} />
      </svg>
      <div style={{
        position: "absolute",
        inset: `${coreInset}%`,
        borderRadius: "50%",
        background: listening
          ? `radial-gradient(circle, #EAFBFF 0%, #35F0A0 38%, #0B8460 72%, transparent 100%)`
          : `radial-gradient(circle, #EAFBFF 0%, ${CYAN} 38%, #0B6E84 72%, transparent 100%)`,
        animation: "breathe 3.2s ease-in-out infinite",
        animationDuration: speaking
          ? `${Math.max(0.3, 0.9 - energy * 0.6)}s`
          : surge ? "0.9s" : "3.2s",
        boxShadow: [
          `0 0 ${surge ? 30 + energy * 50 : 30}px ${CYAN}${surge ? "cc" : "66"}`,
          speaking ? `0 0 ${energy * 80}px ${CYAN}33` : null,
          `inset 0 0 18px #ffffffcc`,
        ].filter(Boolean).join(", "),
        transition: speaking ? "inset 0.1s, box-shadow 0.1s" : "inset .3s, box-shadow .5s",
      }} />
      {speaking && (
        <div style={{
          display: "flex", gap: 3, alignItems: "flex-end", justifyContent: "center",
          height: 20,
          position: "absolute", bottom: -28, left: "50%", transform: "translateX(-50%)",
        }}>
          {[0.6, 1.0, 0.8, 1.0, 0.6, 0.9, 0.7].map((h, i) => (
            <div key={i} style={{
              width: 3,
              height: `${Math.max(4, amplitude * h * 18 + Math.sin(Date.now() / 100 + i) * 3)}px`,
              background: CYAN,
              borderRadius: 1.5,
              transition: "height 0.08s",
              opacity: 0.7 + amplitude * 0.3,
            }} />
          ))}
        </div>
      )}
    </div>
  );
}

// Telemetry bar.
function Gauge({ label, value, unit }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        fontSize: 10, letterSpacing: "0.14em", marginBottom: 4, opacity: 0.85,
      }}>
        <span>{label}</span>
        <span style={{ color: CYAN }}>{value.toFixed(value < 10 ? 1 : 0)}{unit}</span>
      </div>
      <div style={{ height: 3, background: "#14506044", borderRadius: 2 }}>
        <div style={{
          height: "100%", width: `${Math.min(value, 100)}%`,
          background: `linear-gradient(90deg, #14829C, ${CYAN})`,
          borderRadius: 2, boxShadow: `0 0 8px ${CYAN}88`,
          transition: "width 1.1s ease",
        }} />
      </div>
    </div>
  );
}

// Frame corners.
function Brackets() {
  const c = { position: "absolute", width: 26, height: 26, borderColor: CYAN + "99", borderStyle: "solid", borderWidth: 0 };
  return (
    <>
      <div style={{ ...c, top: 10, left: 10, borderTopWidth: 1, borderLeftWidth: 1 }} />
      <div style={{ ...c, top: 10, right: 10, borderTopWidth: 1, borderRightWidth: 1 }} />
      <div style={{ ...c, bottom: 10, left: 10, borderBottomWidth: 1, borderLeftWidth: 1 }} />
      <div style={{ ...c, bottom: 10, right: 10, borderBottomWidth: 1, borderRightWidth: 1 }} />
    </>
  );
}

// Message renderer.
function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**"))
      return <strong key={i} style={{ color: TEXT, fontWeight: 700 }}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`"))
      return <code key={i} style={{
        background: CYAN + "1a", color: CYAN, padding: "1px 5px",
        borderRadius: 2, fontSize: "0.88em", fontFamily: "'Share Tech Mono', monospace",
      }}>{p.slice(1, -1)}</code>;
    return p;
  });
}

function MessageText({ text }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter(l => l.trim());
        if (!lines.length) return null;

        const isBullet = l => /^[•\-\*]\s/.test(l);
        const stripBullet = l => l.replace(/^[•\-\*]\s/, "");

        // Bullet list.
        if (lines.every(isBullet)) {
          return (
            <ul key={bi} style={{ margin: bi > 0 ? "6px 0 8px" : "4px 0 8px", paddingLeft: 0, listStyle: "none" }}>
              {lines.map((l, li) => (
                <li key={li} style={{ display: "flex", gap: 8, marginBottom: 4, lineHeight: 1.55 }}>
                  <span style={{ color: CYAN, flexShrink: 0, opacity: 0.6, marginTop: 1 }}>›</span>
                  <span>{renderInline(stripBullet(l))}</span>
                </li>
              ))}
            </ul>
          );
        }

        // Header.
        if (lines.length === 1 && /^##\s/.test(lines[0])) {
          return (
            <div key={bi} style={{
              fontSize: 9, letterSpacing: "0.2em", color: CYAN, opacity: 0.65,
              marginBottom: 6, marginTop: bi > 0 ? 10 : 2,
            }}>
              {lines[0].replace(/^##\s/, "").toUpperCase()}
            </div>
          );
        }

        // Mixed lines.
        return (
          <div key={bi} style={{ marginBottom: bi < blocks.length - 1 ? 8 : 0 }}>
            {lines.map((line, li) => {
              if (isBullet(line)) {
                return (
                  <div key={li} style={{ display: "flex", gap: 8, marginBottom: 4, lineHeight: 1.55 }}>
                    <span style={{ color: CYAN, flexShrink: 0, opacity: 0.6 }}>›</span>
                    <span>{renderInline(stripBullet(line))}</span>
                  </div>
                );
              }
              // Label: content.
              const sm = line.match(/^([A-Za-z][A-Za-z ]{1,18}):\s+(.+)/);
              if (sm) {
                return (
                  <div key={li} style={{ marginBottom: 5, lineHeight: 1.55 }}>
                    <span style={{
                      color: CYAN, opacity: 0.6, letterSpacing: "0.12em",
                      fontSize: 9, marginRight: 6, textTransform: "uppercase",
                    }}>{sm[1]}:</span>
                    {renderInline(sm[2])}
                  </div>
                );
              }
              return (
                <div key={li} style={{ lineHeight: 1.6, marginBottom: li < lines.length - 1 ? 2 : 0 }}>
                  {renderInline(line)}
                </div>
              );
            })}
          </div>
        );
      })}
    </>
  );
}

const nowTs = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

// Probe backend.
async function probeServer(signal) {
  const r = await fetch(`${SERVER_URL}/health`, { signal });
  if (!r.ok) throw new Error("bad status");
  const data = await r.json();
  if (!data.ok) throw new Error("model missing");
  return `${data.model.toUpperCase()} + TOOLS`;
}

async function probeOllama(signal) {
  const base = OLLAMA_URL.replace(/\/api\/.*$/, "");
  const r = await fetch(`${base}/api/tags`, { signal });
  if (!r.ok) throw new Error("bad status");
  const data = await r.json();
  const names = (data.models || []).map(m => m.name);
  if (!names.some(n => n.startsWith(activeModel))) {
    throw new Error(`MODEL ${activeModel.toUpperCase()} NOT PULLED`);
  }
  return activeModel.toUpperCase();
}

// Detect FreeLLMAPI.
async function probeFreeLLM() {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${FREELLM_URL}/v1/models`, { signal: ctrl.signal, headers: { "Authorization": `Bearer ${FREELLM_KEY}` } });
    if (!r.ok) return null;
    const data = await r.json();
    // Show first model.
    return (data.data?.[0]?.id) || "auto";
  } catch {
    return null; // offline
  }
}

async function probeClaude(signal) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  });
  if (!r.ok) throw new Error("bad status");
  return "CLAUDE UPLINK";
}

async function checkCognitionCore() {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 4000);
  try {
    if (BACKEND === "server" || BACKEND === "ollama") {
      try {
        const detail = BACKEND === "server"
          ? await probeServer(ctrl.signal)
          : await probeOllama(ctrl.signal);
        return { ok: true, detail, backend: BACKEND, fallback: false };
      } catch {
        // Ask before cloud fallback.
        try {
          const ctrl2 = new AbortController();
          const t2 = setTimeout(() => ctrl2.abort(), 4000);
          await probeClaude(ctrl2.signal);
          clearTimeout(t2);
          return { ok: true, detail: "CLAUDE · FALLBACK", backend: "claude", fallback: true };
        } catch {
          return { ok: false, detail: "ALL CORES UNREACHABLE", backend: null, fallback: false };
        }
      }
    } else {
      const detail = await probeClaude(ctrl.signal);
      return { ok: true, detail, backend: "claude", fallback: false };
    }
  } catch {
    return { ok: false, detail: "UPLINK FAILED", backend: null, fallback: false };
  } finally {
    clearTimeout(timeout);
  }
}

const BOOT_LINES = [
  "INITIALIZING CORE SYSTEMS .......... OK",
  "ARC REACTOR OUTPUT ................. STABLE",
  "NEURAL INTERFACE ................... LINKED",
  "HOLOGRAPHIC PROJECTION ............. ONLINE",
  "VOICE PROTOCOL ..................... ARMED",
];

// Fresh greeting.
const GREETINGS = [
  "Hello again, sir. All systems are online and I'm ready when you are.",
  "Welcome back, sir. Fully operational and standing by for your command.",
  "Good to see you, sir. Everything's green — ready to assist.",
  "Hello, sir. I'm online, primed, and ready whenever you are.",
  "Welcome back, sir. Cores warm, systems ready. How may I help?",
];
const randomGreeting = () => GREETINGS[Math.floor(Math.random() * GREETINGS.length)];

export default function JarvisInterface() {
  const [booted, setBooted] = useState(false);
  const [bootStep, setBootStep] = useState(0);
  const [aiStatus, setAiStatus] = useState({ state: "checking", detail: "", backend: null, fallback: false });
  const aiStatusRef = useRef(aiStatus);
  aiStatusRef.current = aiStatus;
  const [model, setModel] = useState(() => {
    try { return localStorage.getItem("jarvis-model") || OLLAMA_MODEL; } catch { return OLLAMA_MODEL; }
  });
  const [switchingModel, setSwitchingModel] = useState(false);
  const [clock, setClock] = useState(new Date());
  const [stats, setStats] = useState({ pwr: 98.4, cpu: 22, net: 61, tmp: 34 });
  // Previous session snapshot.
  const [priorSession] = useState(() => {
    try {
      const saved = localStorage.getItem("jarvis-history");
      const parsed = saved ? JSON.parse(saved) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  // Start clean; memory persists.
  const [messages, setMessages] = useState([
    { role: "assistant", text: "Good evening, sir. All systems are online. How may I assist you?" },
  ]);
  const [input, setInput] = useState("");
  const [coreState, setCoreState] = useState("idle");
  const [voiceOn, setVoiceOn] = useState(true);
  const [listening, setListening] = useState(false);
  const [micSupported, setMicSupported] = useState(true);
  const logRef = useRef(null);
  const voiceOnRef = useRef(true);
  voiceOnRef.current = voiceOn;
  const currentAudioRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const amplitudeRef = useRef(0);
  const animFrameRef = useRef(null);
  const [amplitude, setAmplitude] = useState(0);
  const mediaRecorderRef = useRef(null);

  // Wake word + PTT refs
  const listeningRef = useRef(false);
  listeningRef.current = listening;
  const startListeningRef = useRef(null);
  const stopListeningRef = useRef(null);
  const pttSourceRef = useRef("local"); // "local" = in-window ⌥/button, "global" = system-wide ⌥V

  // Brain memory
  const [memories, setMemories] = useState(() => {
    try {
      const saved = localStorage.getItem("jarvis-memories");
      if (saved) return JSON.parse(saved);
    } catch {}
    return [];
  });
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [newMemoryText, setNewMemoryText] = useState("");
  const memoriesRef = useRef([]);
  memoriesRef.current = memories;

  // Task list
  const [tasks, setTasks] = useState(() => {
    try { const s = localStorage.getItem("jarvis-tasks"); return s ? JSON.parse(s) : []; } catch { return []; }
  });
  const [taskPanelOpen, setTaskPanelOpen] = useState(false);
  const [newTaskText, setNewTaskText] = useState("");
  const [newTaskPriority, setNewTaskPriority] = useState("medium");
  const tasksRef = useRef([]);
  tasksRef.current = tasks;

  // FreeLLMAPI state.
  const [freeLLMAvailable, setFreeLLMAvailable] = useState(null);
  const [freeLLMActive, setFreeLLMActive] = useState(false);

  // Voice output.
  const [voices, setVoices] = useState([]);
  const [voiceURI, setVoiceURI] = useState(null);
  const voiceURIRef = useRef(null);
  voiceURIRef.current = voiceURI;

  // Rank voices.
  const rankVoice = (v) => {
    let score = 0;
    if (/en-GB/i.test(v.lang)) score += 100;
    else if (/^en/i.test(v.lang)) score += 40;
    if (/daniel/i.test(v.name)) score += 60;            // macOS
    if (/george|arthur|ryan|oliver|brian/i.test(v.name)) score += 40;
    if (/google uk english male/i.test(v.name)) score += 55; // Chrome
    if (/enhanced|premium|neural/i.test(v.name)) score += 30; // quality
    if (/male/i.test(v.name)) score += 20;
    if (/female|samantha|kate|serena|susan|zira/i.test(v.name)) score -= 30;
    return score;
  };

  useEffect(() => {
    const load = () => {
      const all = (window.speechSynthesis?.getVoices() || [])
        .filter(v => /^en/i.test(v.lang))
        .sort((a, b) => rankVoice(b) - rankVoice(a));
      setVoices(all);
      // Prefer saved voice.
      let saved = null;
      try { saved = localStorage.getItem("jarvis-voice"); } catch {}
      const savedOk = saved && all.some(v => v.voiceURI === saved);
      setVoiceURI(uri => uri || (savedOk ? saved : all[0]?.voiceURI) || null);
    };
    load();
    window.speechSynthesis?.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", load);
  }, []);

  // Persist voice.
  useEffect(() => {
    if (voiceURI) { try { localStorage.setItem("jarvis-voice", voiceURI); } catch {} }
  }, [voiceURI]);

  // Audio analyser.
  const connectAudioAnalyser = (audioEl) => {
    try {
      if (!audioCtxRef.current) audioCtxRef.current = new AudioContext();
      const ctx = audioCtxRef.current;
      const src = ctx.createMediaElementSource(audioEl);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      analyserRef.current = analyser;
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        amplitudeRef.current = avg / 128; // 0–2 range, clamp to 0–1
        animFrameRef.current = requestAnimationFrame(tick);
      };
      tick();
    } catch {}
  };

  const disconnectAudioAnalyser = () => {
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    amplitudeRef.current = 0;
  };

  // Update amplitude while speaking.
  useEffect(() => {
    if (coreState !== "speaking") { setAmplitude(0); return; }
    const id = setInterval(() => setAmplitude(amplitudeRef.current), 33);
    return () => clearInterval(id);
  }, [coreState]);

  const speak = useCallback(async (text) => {
    if (!voiceOnRef.current) return;

    // Stop current audio.
    window.speechSynthesis?.cancel();
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }

    // OpenAI TTS
    if (TTS_BACKEND === "openai" && TTS_API_KEY) {
      try {
        setCoreState("speaking");
        const res = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { "Authorization": `Bearer ${TTS_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "tts-1", input: text, voice: OPENAI_VOICE }),
        });
        if (!res.ok) throw new Error("OpenAI TTS error");
        const blob = await res.blob();
        const url  = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudioRef.current = audio;
        audio.onended = () => { setCoreState("idle"); disconnectAudioAnalyser(); URL.revokeObjectURL(url); };
        audio.onerror = () => { setCoreState("idle"); disconnectAudioAnalyser(); URL.revokeObjectURL(url); };
        audio.play();
        connectAudioAnalyser(audio);
      } catch { setCoreState("idle"); }
      return;
    }

    // ElevenLabs TTS.
    if (TTS_BACKEND === "elevenlabs" && TTS_API_KEY) {
      try {
        setCoreState("speaking");
        const res = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
          {
            method: "POST",
            headers: { "xi-api-key": TTS_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({
              text,
              model_id: "eleven_turbo_v2_5",
              voice_settings: { stability: 0.88, similarity_boost: 0.78, style: 0.0, use_speaker_boost: true },
            }),
          }
        );
        if (!res.ok) throw new Error("ElevenLabs TTS error");
        const mime = "audio/mpeg";
        if (res.body && window.MediaSource?.isTypeSupported?.(mime)) {
          const ms = new MediaSource();
          const msUrl = URL.createObjectURL(ms);
          const audio = new Audio(msUrl);
          currentAudioRef.current = audio;
          audio.onended = () => { setCoreState("idle"); disconnectAudioAnalyser(); URL.revokeObjectURL(msUrl); };
          audio.onerror = () => { setCoreState("idle"); disconnectAudioAnalyser(); URL.revokeObjectURL(msUrl); };
          connectAudioAnalyser(audio);
          ms.addEventListener("sourceopen", async () => {
            const sb = ms.addSourceBuffer(mime);
            const reader = res.body.getReader();
            const pump = async () => {
              const { done, value } = await reader.read();
              if (done) { if (ms.readyState === "open") ms.endOfStream(); return; }
              sb.addEventListener("updateend", pump, { once: true });
              sb.appendBuffer(value);
            };
            const { value: first } = await reader.read();
            if (first) { sb.addEventListener("updateend", pump, { once: true }); sb.appendBuffer(first); }
          }, { once: true });
          audio.play().catch(() => {});
        } else {
          // Blob fallback.
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          currentAudioRef.current = audio;
          audio.onended = () => { setCoreState("idle"); disconnectAudioAnalyser(); URL.revokeObjectURL(url); };
          audio.onerror = () => { setCoreState("idle"); disconnectAudioAnalyser(); URL.revokeObjectURL(url); };
          audio.play();
          connectAudioAnalyser(audio);
        }
      } catch { setCoreState("idle"); }
      return;
    }

    // Browser TTS fallback
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    const all = window.speechSynthesis.getVoices();
    const pick =
      all.find(v => v.voiceURI === voiceURIRef.current) ||
      all.filter(v => /^en/i.test(v.lang)).sort((a, b) => rankVoice(b) - rankVoice(a))[0];
    if (pick) u.voice = pick;
    u.rate  = 0.90;
    u.pitch = 0.85;
    u.onstart = () => {
      setCoreState("speaking");
      // Simulate amplitude.
      let t = 0;
      const simulate = () => {
        t += 0.05;
        amplitudeRef.current = 0.5 + 0.4 * Math.sin(t * 2.1) * Math.sin(t * 3.7);
        animFrameRef.current = requestAnimationFrame(simulate);
      };
      simulate();
    };
    u.onend   = () => { setCoreState("idle"); disconnectAudioAnalyser(); };
    u.onerror = () => { setCoreState("idle"); disconnectAudioAnalyser(); };
    window.speechSynthesis.speak(u);
  }, []);

  // Memory helpers

  const IMPORTANCE_BY_CATEGORY = { correction: 5, preference: 4, habit: 3, routine: 3, fact: 3, general: 2 };
  const CATEGORY_COLOR = { correction: "#F0A035", preference: "#35C5F0", habit: "#35F0A0", routine: "#A035F0", fact: "#F03575", general: "#607080" };
  const CORRECTION_RE = /\b(no[,.]?\s*(that'?s|that is|I|you)|actually[,\s]|I meant|I said|not that|you'?re wrong|that'?s (not|wrong|incorrect)|I didn'?t say|no sir)\b/i;

  // Memory similarity.
  const wordSim = (a, b) => {
    const wa = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 4));
    const wb = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 4));
    if (!wa.size || !wb.size) return 0;
    const inter = [...wa].filter(w => wb.has(w)).length;
    return inter / (wa.size + wb.size - inter);
  };

  // Rank memories.
  const getMemoryContext = useCallback((userMessage) => {
    if (!memoriesRef.current.length) return "";
    const words = userMessage.toLowerCase().split(/\W+/).filter(w => w.length > 3);
    const now = Date.now();
    const scored = memoriesRef.current.map(m => {
      const ml = m.content.toLowerCase();
      let score = (m.importance || 2) * 2;
      words.forEach(w => { if (ml.includes(w)) score += 4; });
      // Recency boost.
      const last = m.lastAccessed ? new Date(m.lastAccessed).getTime() : new Date(m.createdAt).getTime();
      score += Math.max(0, 5 - (now - last) / 86400000 * 0.5);
      // Frequency boost.
      score += Math.min(m.accessCount || 0, 10) * 0.3;
      // Category boost.
      if (m.category === "correction") score += 4;
      if (m.category === "preference") score += 2;
      return { ...m, _score: score };
    }).sort((a, b) => b._score - a._score).slice(0, 15);
    if (!scored.length) return "";
    // Track access.
    const ids = new Set(scored.map(m => m.id));
    setMemories(prev => prev.map(m => ids.has(m.id)
      ? { ...m, accessCount: (m.accessCount || 0) + 1, lastAccessed: new Date().toISOString() }
      : m
    ));
    return "JARVIS MEMORY:\n" + scored.map(m => `- [${m.category || "fact"}] ${m.content}`).join("\n");
  }, []);

  // Extract memories.
  const ingestFacts = useCallback(async (sourceText, forceCategory = null) => {
    try {
      const backend = aiStatusRef.current.backend;
      if (!backend) return;
      const prompt =
        `Extract facts worth remembering long-term from the following. Reply with a JSON array of objects or [] if nothing notable.\n` +
        `Format: [{"fact":"...","category":"preference|habit|correction|fact|routine|general"}]\n` +
        `Categories: preference=likes/dislikes, habit=regular behaviors, correction=user correcting AI, fact=personal info, routine=schedule, general=other.\n` +
        `Be very selective — only genuinely useful long-term facts. Max 5 items.\n` +
        `Source:\n${sourceText}`;
      let raw = "[]";
      if (backend === "ollama" || backend === "server") {
        const res = await fetch(OLLAMA_URL, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: activeModel, stream: false, think: false, messages: [{ role: "user", content: prompt }] }),
        });
        raw = (await res.json()).message?.content?.trim() || "[]";
      } else {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", headers: { "Content-Type": "application/json", "x-api-key": TTS_API_KEY },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", max_tokens: 400,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const d = await res.json();
        raw = (d.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
      }
      const match = raw.match(/\[[\s\S]*?\]/);
      if (!match) return;
      let items = JSON.parse(match[0]);
      if (!Array.isArray(items) || !items.length) return;
      // Accept strings too.
      items = items.map(i => typeof i === "string" ? { fact: i, category: forceCategory || "general" } : i);
      setMemories(prev => {
        let updated = [...prev];
        for (const item of items) {
          const content = (item.fact || "").trim();
          const category = forceCategory || item.category || "general";
          if (!content) continue;
          // Dedup similar facts.
          const similar = updated.find(m => wordSim(m.content, content) > 0.55);
          if (similar) {
            updated = updated.map(m => m.id === similar.id
              ? { ...m, importance: Math.min((m.importance || 2) + 1, 5), lastAccessed: new Date().toISOString() }
              : m
            );
          } else {
            const importance = IMPORTANCE_BY_CATEGORY[category] || 2;
            updated.push({
              id: `m${Date.now()}_${Math.random().toString(36).slice(2)}`,
              content, category, importance,
              tags: [], createdAt: new Date().toISOString(),
              accessCount: 0, lastAccessed: new Date().toISOString(),
            });
          }
        }
        return updated.sort((a, b) => (b.importance || 2) - (a.importance || 2)).slice(0, 200);
      });
    } catch {}
  }, []);

  // Extract exchange memories.
  const extractMemories = useCallback((userText, assistantText) => {
    if (CORRECTION_RE.test(userText)) {
      ingestFacts(
        `The user corrected the assistant.\nUser said: "${userText}"\nAssistant had said: "${assistantText}"`,
        "correction"
      );
    } else {
      ingestFacts(`Exchange:\nUser: "${userText}"\nAssistant: "${assistantText}"`);
    }
  }, [ingestFacts]);

  // Save previous-session facts.
  const consolidateSession = useCallback((history) => {
    const turns = (history || []).filter(m => (m.role === "user" || m.role === "assistant") && m.text?.trim());
    if (turns.length < 2) return;
    const transcript = turns
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
      .join("\n");
    ingestFacts(`This is the full transcript of the previous conversation:\n${transcript}`);
  }, [ingestFacts]);

  // Add manual memory.
  const addMemory = useCallback((content) => {
    if (!content.trim()) return;
    setMemories(prev => {
      if (prev.some(m => wordSim(m.content, content.trim()) > 0.55)) return prev;
      const mem = {
        id: `m${Date.now()}`, content: content.trim(), category: "fact",
        tags: [], createdAt: new Date().toISOString(), importance: 3,
        accessCount: 0, lastAccessed: new Date().toISOString(),
      };
      return [...prev, mem].sort((a, b) => (b.importance || 2) - (a.importance || 2)).slice(0, 200);
    });
  }, []);

  const deleteMemory = useCallback((id) => {
    setMemories(prev => prev.filter(m => m.id !== id));
  }, []);

  // Sync selected model.
  useEffect(() => {
    activeModel = model;
    try { localStorage.setItem("jarvis-model", model); } catch {}
  }, [model]);

  // Hot-swap model.
  const switchModel = useCallback(async (next) => {
    if (next === model) return;
    setSwitchingModel(true);
    setModel(next);
    activeModel = next;
    try { localStorage.setItem("jarvis-model", next); } catch {}
    setAiStatus(s => ({ ...s, state: "checking", detail: `SWITCHING TO ${next.toUpperCase()}…` }));
    try {
      await fetch(`${SERVER_URL}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: next }),
      });
    } catch { /* direct mode */ }
    const { ok, detail, backend, fallback } = await checkCognitionCore();
    setAiStatus({ state: ok ? "online" : "offline", detail, backend, fallback });
    setSwitchingModel(false);
  }, [model]);

  // Boot sequence.
  useEffect(() => {
    (async () => {
      try {
        await fetch(`${SERVER_URL}/model`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model }),
        });
      } catch { /* server optional */ }
      const { ok, detail, backend, fallback } = await checkCognitionCore();
      // Sync backend ref.
      aiStatusRef.current = { state: ok ? "online" : "offline", detail, backend, fallback };
      setAiStatus(aiStatusRef.current);
      // Save old session facts.
      if (ok) consolidateSession(priorSession);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (bootStep < BOOT_LINES.length) {
      const t = setTimeout(() => setBootStep(s => s + 1), 320);
      return () => clearTimeout(t);
    }
    // Wait for backend probe.
    if (aiStatus.state === "checking") return;
    // Wait for cloud confirmation.
    if (aiStatus.fallback) return;
    const ok = aiStatus.state === "online";
    const t = setTimeout(() => {
      setBooted(true);
      setMessages(prev => {
        // Resume existing log.
        const hasHistory = prev.length > 1 || (prev.length === 1 && prev[0].text !== "Good evening, sir. All systems are online. How may I assist you?");
        if (hasHistory) {
          if (!ok) {
            const warn = "Sir, the cognition core is currently unreachable. My responses will be unavailable until it recovers.";
            setTimeout(() => speak(warn), 600);
            return [...prev, { role: "assistant", text: warn }];
          }
          // Avoid duplicate greeting.
          return prev;
        }
        // Fresh greeting.
        let greeting = !ok
          ? "Sir, I must report that no cognition core is reachable — neither local nor cloud. My responses will be unavailable until one recovers."
          : randomGreeting();
        // Surface urgent tasks.
        if (ok) {
          const urgent = tasksRef.current.filter(t => !t.done && t.priority === "high");
          if (urgent.length === 1) greeting += ` Also, sir — you have one high-priority task outstanding: "${urgent[0].title}".`;
          else if (urgent.length > 1) greeting += ` Also, sir — you have ${urgent.length} high-priority tasks outstanding.`;
        }
        setTimeout(() => speak(greeting), 600);
        return [{ role: "assistant", text: greeting }];
      });
    }, 700);
    return () => clearTimeout(t);
  }, [bootStep, aiStatus, speak]);

  // Accept cloud fallback.
  const acknowledgeFallback = useCallback(() => {
    setBooted(true);
    const greeting =
      "Cloud fallback acknowledged, sir. I am operating on the Claude uplink — our conversations are leaving this machine until the local core returns.";
    setMessages(prev => [...prev, { role: "assistant", text: greeting }]);
    setTimeout(() => speak(greeting), 400);
  }, [speak]);

  // Fallback alert.
  const gateSpokenRef = useRef(false);
  useEffect(() => {
    if (aiStatus.fallback && bootStep >= BOOT_LINES.length && !booted && !gateSpokenRef.current) {
      gateSpokenRef.current = true;
      speak("Warning, sir. The local cognition core is offline. Awaiting your authorization to reroute through the Claude cloud uplink.");
    }
  }, [aiStatus, bootStep, booted, speak]);

  // Local push-to-talk.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key !== "Alt") return;
      e.preventDefault();
      if (e.repeat) return;
      pttSourceRef.current = "local";
      startListeningRef.current?.();
    };
    const handleKeyUp = (e) => {
      if (e.key !== "Alt") return;
      e.preventDefault();
      stopListeningRef.current?.();
    };
    const handleBlur = () => {
      // Keep global PTT alive.
      if (pttSourceRef.current === "local") stopListeningRef.current?.();
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []); // stable — uses refs internally

  // Global push-to-talk.
  useEffect(() => {
    if (!window.electronAPI?.onPttDown) return;
    const offDown = window.electronAPI.onPttDown(() => {
      pttSourceRef.current = "global";
      startListeningRef.current?.();
    });
    const offUp = window.electronAPI.onPttUp(() => {
      stopListeningRef.current?.();
    });
    return () => { offDown?.(); offUp?.(); };
  }, []); // stable — uses refs internally

  // Escape controls voice.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code !== "Escape") return;
      const isSpeaking = currentAudioRef.current || window.speechSynthesis?.speaking;
      if (isSpeaking) {
        window.speechSynthesis?.cancel();
        if (currentAudioRef.current) {
          currentAudioRef.current.pause();
          currentAudioRef.current = null;
        }
        disconnectAudioAnalyser();
        setCoreState("idle");
      } else {
        setVoiceOn(v => {
          if (v) window.speechSynthesis?.cancel();
          return !v;
        });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []); // stable — uses refs internally

  // Clock and telemetry.
  useEffect(() => {
    const t = setInterval(() => {
      setClock(new Date());
      setStats(s => ({
        pwr: Math.max(90, Math.min(100, s.pwr + (Math.random() - 0.5))),
        cpu: Math.max(8, Math.min(96, s.cpu + (Math.random() - 0.5) * 9)),
        net: Math.max(20, Math.min(100, s.net + (Math.random() - 0.5) * 12)),
        tmp: Math.max(28, Math.min(72, s.tmp + (Math.random() - 0.5) * 2)),
      }));
    }, 1500);
    return () => clearInterval(t);
  }, []);

  // Persist recent chat.
  useEffect(() => {
    try {
      localStorage.setItem("jarvis-history", JSON.stringify(messages.slice(-80)));
    } catch {}
  }, [messages]);

  // Persist memories.
  useEffect(() => {
    try { localStorage.setItem("jarvis-memories", JSON.stringify(memories)); } catch {}
  }, [memories]);

  // Persist tasks.
  useEffect(() => {
    try { localStorage.setItem("jarvis-tasks", JSON.stringify(tasks)); } catch {}
  }, [tasks]);

  // Probe FreeLLMAPI once.
  useEffect(() => {
    probeFreeLLM().then(model => {
      if (model) {
        setFreeLLMAvailable(model);
        console.log(`[freellmapi] detected — model: ${model}`);
      }
    });
  }, []);

  // Task helpers.
  const addTask = useCallback((title, priority = "medium") => {
    const t = title.trim();
    if (!t) return;
    setTasks(prev => [...prev, { id: `${Date.now()}_${Math.random().toString(36).slice(2,7)}`, title: t, priority, done: false, createdAt: Date.now() }]);
  }, []);

  // Fuzzy task lookup.
  const findTaskByTitle = useCallback((title) => {
    const q = title.trim().toLowerCase();
    if (!q) return null;
    const all = tasksRef.current;
    return all.find(t => t.title.toLowerCase() === q)
        || all.find(t => t.title.toLowerCase().includes(q))
        || all.find(t => q.includes(t.title.toLowerCase()))
        || null;
  }, []);

  const completeTaskByTitle = useCallback((title) => {
    const task = findTaskByTitle(title);
    if (task) setTasks(prev => prev.map(t => t.id === task.id ? { ...t, done: true } : t));
    return task;
  }, [findTaskByTitle]);

  const removeTaskByTitle = useCallback((title) => {
    const task = findTaskByTitle(title);
    if (task) setTasks(prev => prev.filter(t => t.id !== task.id));
    return task;
  }, [findTaskByTitle]);

  const toggleTask = useCallback((id) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, done: !t.done } : t));
  }, []);

  const deleteTask = useCallback((id) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  }, []);

  // Sync Quick Ask exchanges.
  const drainQuickLog = useCallback(() => {
    const LS_KEY = "jarvis-quick-log";
    const CURSOR_KEY = "jarvis-quick-log-cursor";
    try {
      const log = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
      const cursor = Number(localStorage.getItem(CURSOR_KEY) || "0");
      const unseen = log.filter(e => e.ts > cursor);
      if (!unseen.length) return;
      const newMsgs = unseen.flatMap(({ user, assistant }) => [
        ...(user ? [{ role: "user", text: user, ts: nowTs(), fromOverlay: true }] : []),
        { role: "assistant", text: assistant, ts: nowTs(), fromOverlay: true },
      ]);
      setMessages(m => {
        // Avoid duplicates.
        const lastTs = m.filter(x => x.fromOverlay).map(x => x._raw_ts || 0);
        return [...m, ...newMsgs];
      });
      localStorage.setItem(CURSOR_KEY, String(Math.max(...unseen.map(e => e.ts))));
    } catch {}
  }, []);

  useEffect(() => {
    // Drain on mount.
    drainQuickLog();

    // Drain on focus.
    const onFocus = () => drainQuickLog();
    window.addEventListener("focus", onFocus);

    // IPC fast path.
    const cleanupIpc = window.electronAPI?.onQuickExchange?.(({ user, assistant, ts }) => {
      const CURSOR_KEY = "jarvis-quick-log-cursor";
      // Mark processed.
      try {
        const cursor = Number(localStorage.getItem(CURSOR_KEY) || "0");
        if (ts) localStorage.setItem(CURSOR_KEY, String(Math.max(cursor, ts)));
      } catch {}
      setMessages(m => [
        ...m,
        ...(user ? [{ role: "user", text: user, ts: nowTs(), fromOverlay: true }] : []),
        { role: "assistant", text: assistant, ts: nowTs(), fromOverlay: true },
      ]);
    });

    return () => {
      window.removeEventListener("focus", onFocus);
      cleanupIpc?.();
    };
  }, [drainQuickLog]);


  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, coreState]);

  // Parse action tags.
  const parseAndExecuteActions = useCallback((text) => {
    // Open apps.
    const openMatches = [...text.matchAll(/\[OPEN:([^\]]+)\]/g)];
    for (const match of openMatches) {
      const appName = match[1].trim();
      if (window.electronAPI?.openApp) {
        window.electronAPI.openApp(appName).then(result => {
          if (!result.ok) {
            setMessages(m => [...m, {
              role: 'assistant',
              text: `I'm afraid I couldn't open ${appName}, sir. ${result.error || ''}`,
            }]);
          }
        }).catch(() => {});
      }
    }
    // Add tasks.
    const added = [];
    const taskMatches = [...text.matchAll(/\[TASK:([^:\]]+):?(high|medium|low)?\]/gi)];
    for (const match of taskMatches) {
      const title = match[1].trim();
      const priority = (match[2] || "medium").toLowerCase();
      addTask(title, priority);
      added.push(title);
    }
    // Update tasks.
    const completed = [], removed = [], notFound = [];
    for (const match of text.matchAll(/\[TASK_DONE:([^\]]+)\]/gi)) {
      const task = completeTaskByTitle(match[1]);
      task ? completed.push(task.title) : notFound.push(match[1].trim());
    }
    for (const match of text.matchAll(/\[TASK_REMOVE:([^\]]+)\]/gi)) {
      const task = removeTaskByTitle(match[1]);
      task ? removed.push(task.title) : notFound.push(match[1].trim());
    }
    const stripped = text
      .replace(/\[OPEN:[^\]]+\]/g, '')
      .replace(/\[TASK:[^\]]+\]/gi, '')
      .replace(/\[TASK_(?:DONE|REMOVE):[^\]]+\]/gi, '')
      .trim();
    if (stripped) return stripped;
    // Confirm tag-only tasks.
    const parts = [];
    if (added.length === 1) parts.push(`"${added[0]}" added to your task list, sir.`);
    else if (added.length > 1) parts.push(`${added.length} tasks added to your list, sir.`);
    if (completed.length === 1) parts.push(`"${completed[0]}" marked as complete, sir.`);
    else if (completed.length > 1) parts.push(`${completed.length} tasks marked as complete, sir.`);
    if (removed.length === 1) parts.push(`"${removed[0]}" removed from your list, sir.`);
    else if (removed.length > 1) parts.push(`${removed.length} tasks removed, sir.`);
    if (notFound.length) parts.push(`I couldn't find "${notFound.join('", "')}" on your task list, sir.`);
    return parts.join(" ");
  }, [addTask, completeTaskByTitle, removeTaskByTitle]);

  // Send chat.
  const send = useCallback(async (spoken) => {
    const text = (typeof spoken === "string" ? spoken : input).trim();
    if (!text || coreState === "thinking") return;
    if (aiStatusRef.current.state === "offline") {
      const warn = BACKEND === "ollama"
        ? "The local cognition core is still offline, sir. Start Ollama and reload the interface."
        : "The cognition uplink is still down, sir. Reload the interface to retry.";
      setMessages(m => [...m, { role: "user", text, ts: nowTs() }, { role: "assistant", text: warn, ts: nowTs() }]);
      setInput("");
      speak(warn);
      return;
    }
    setInput("");
    const ts = nowTs();
    const history = [...messages, { role: "user", text, ts }];
    setMessages(history);
    setCoreState("thinking");
    try {
      const backend = aiStatusRef.current.backend;
      // Include live tasks.
      const taskCtx = tasksRef.current.length
        ? "USER'S CURRENT TASK LIST:\n" + tasksRef.current.map(t =>
            `- "${t.title}" [${t.priority}]${t.done ? " (done)" : ""}`).join("\n")
        : "USER'S CURRENT TASK LIST: (empty)";
      const memCtx = [getMemoryContext(text), taskCtx].filter(Boolean).join("\n\n");
      if (backend === "server") {
        const result = await askServer(history, memCtx);
        if (result.pendingAction) {
          // Confirm writes first.
          setCoreState("idle");
          setMessages(m => [...m, {
            role: "action",
            id: result.pendingAction.id,
            summary: result.pendingAction.summary,
            status: "pending",
          }]);
          speak("Awaiting your confirmation, sir.");
          return;
        }
        const rawReply = result.reply || "";
        const reply = parseAndExecuteActions(rawReply);
        // Silent action.
        if (!reply) {
          setCoreState("idle");
          return;
        }
        setMessages(m => [...m, { role: "assistant", text: reply, ts: nowTs() }]);
        extractMemories(text, reply);
        // Nudge urgent tasks.
        const pendingHigh = tasksRef.current.filter(t => !t.done && t.priority === "high");
        const userMsgCount = [...messages, { role: "user" }].filter(m => m.role === "user").length;
        const nudge = pendingHigh.length > 0 && userMsgCount > 0 && userMsgCount % 6 === 0
          ? ` One reminder, sir — "${pendingHigh[0].title}" is still on your task list.` : "";
        const finalWithNudge = reply + nudge;
        setMessages(m => m.map(msg => msg.role === "assistant" && msg === m[m.length - 1]
          ? { ...msg, text: finalWithNudge } : msg));
        if (voiceOnRef.current && window.speechSynthesis) speak(finalWithNudge);
        else { setCoreState("speaking"); setTimeout(() => setCoreState("idle"), 1800); }
        return;
      }
      // Streaming path.
      const msgId = Date.now();
      const streamTs = nowTs();
      setMessages(m => [...m, { role: "assistant", text: "", _streaming: true, _id: msgId, ts: streamTs }]);
      let fullText = "";
      // Prefer FreeLLMAPI.
      const useFreeLLM = freeLLMActive && freeLLMAvailable;
        const stream = useFreeLLM
          ? streamFreeLLM(history, memCtx)
          : backend === "ollama" ? streamOllama(history, memCtx) : streamClaude(history, memCtx);
        try {
          for await (const chunk of stream) {
            fullText += chunk;
            setMessages(m => m.map(msg => msg._id === msgId ? { ...msg, text: fullText } : msg));
          }
        } catch (streamErr) {
          if (useFreeLLM) {
            // Fall back on failure.
            console.warn("[freellmapi] stream error, disabling:", streamErr.message);
            setFreeLLMActive(false);
            fullText = "⚠ Free LLM uplink lost, sir — falling back to local core.";
          }
        }
      const rawFinal = fullText || "";
      const finalReply = parseAndExecuteActions(rawFinal);
      // Silent action.
      if (!finalReply) {
        setMessages(m => m.filter(msg => msg._id !== msgId));
        setCoreState("idle");
        return;
      }
      // Nudge urgent tasks.
      const pendingHighS = tasksRef.current.filter(t => !t.done && t.priority === "high");
      const userMsgCountS = [...messages, { role: "user" }].filter(m => m.role === "user").length;
      const nudgeS = pendingHighS.length > 0 && userMsgCountS > 0 && userMsgCountS % 6 === 0
        ? ` One reminder, sir — "${pendingHighS[0].title}" is still on your task list.` : "";
      const finalWithNudge = finalReply + nudgeS;
      setMessages(m => m.map(msg => msg._id === msgId ? { role: "assistant", text: finalWithNudge, ts: streamTs } : msg));
      extractMemories(text, finalReply);
      if (voiceOnRef.current && window.speechSynthesis) {
        speak(finalWithNudge);
      } else {
        setCoreState("speaking");
        setTimeout(() => setCoreState("idle"), 1800);
      }
      return;
    } catch (e) {
      setCoreState("idle");
      setMessages(m => [...m, {
        role: "assistant",
        text: BACKEND === "ollama"
          ? "Local cognition core unreachable, sir. Verify Ollama is running with OLLAMA_ORIGINS set, and that the model is pulled."
          : "Uplink interference detected. Unable to reach the cognition core — try again, sir.",
      }]);
    }
  }, [input, messages, coreState, speak, getMemoryContext, extractMemories]);

  // Write confirmation.
  const resolveAction = useCallback(async (id, approve) => {
    setMessages(m => m.map(msg =>
      msg.role === "action" && msg.id === id
        ? { ...msg, status: approve ? "executing" : "canceled" }
        : msg
    ));
    setCoreState("thinking");
    try {
      const r = await fetch(`${SERVER_URL}/${approve ? "confirm" : "cancel"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await r.json();
      if (approve) {
        setMessages(m => m.map(msg =>
          msg.role === "action" && msg.id === id ? { ...msg, status: "done" } : msg
        ));
      }
      const reply = data.reply || (approve ? "Done, sir." : "Understood, sir.");
      setMessages(m => [...m, { role: "assistant", text: reply }]);
      speak(reply);
      if (!voiceOnRef.current) setCoreState("idle");
    } catch {
      setCoreState("idle");
      setMessages(m => [...m, { role: "assistant", text: "The tool server did not respond, sir." }]);
    }
  }, [speak]);

  // Voice input.
  const pttHeldRef = useRef(false);

  const stopListening = useCallback(() => {
    pttHeldRef.current = false;
    if (listeningRef.current) mediaRecorderRef.current?.stop();
  }, []);

  const startListening = useCallback(() => {
    if (listeningRef.current || pttHeldRef.current) return;
    pttHeldRef.current = true;

    // Stop speech first.
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
      disconnectAudioAnalyser();
      setCoreState("idle");
    }
    window.speechSynthesis?.cancel();

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      // Quick tap.
      if (!pttHeldRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]
        .find(m => MediaRecorder.isTypeSupported(m)) || "audio/mp4";

      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstart = () => { setListening(true); setCoreState("listening"); };

      recorder.onstop = async () => {
        setListening(false);
        setCoreState("idle");
        stream.getTracks().forEach(t => t.stop());

        const blob = new Blob(chunks, { type: mimeType });
        if (blob.size < 500) return;

        setInput("Transcribing…");
        try {
          const ext = mimeType.includes("mp4") ? "mp4" : "webm";
          const res = await fetch(`${SERVER_URL}/transcribe`, {
            method: "POST",
            headers: { "Content-Type": mimeType, "x-audio-format": ext },
            body: blob,
          });
          if (!res.ok) throw new Error(await res.text());
          const { text } = await res.json();
          if (text) { setInput(""); send(text); } else setInput("");
        } catch (err) {
          console.error("STT failed:", err);
          setInput("");
          setMessages(m => [...m, {
            role: "assistant",
            text: "Voice transcription failed, sir. Please type your command instead.",
          }]);
        }
      };

      recorder.onerror = () => {
        setListening(false);
        setCoreState("idle");
        stream.getTracks().forEach(t => t.stop());
        setInput("");
      };

      recorder.start();
    }).catch(() => {
      pttHeldRef.current = false;
      setListening(false);
      setMicSupported(false);
      setMessages(m => [...m, {
        role: "assistant",
        text: "Microphone access was denied, sir. Grant permission in System Preferences → Privacy → Microphone.",
      }]);
    });
  }, [send]);

  // Stable callback refs.
  startListeningRef.current = startListening;
  stopListeningRef.current = stopListening;

  const mono = "'Share Tech Mono', monospace";
  const display = "'Orbitron', sans-serif";

  // Boot screen
  if (!booted) {
    return (
      <div style={{
        minHeight: "100vh", background: "#030A12", color: CYAN,
        fontFamily: mono, display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <style>{FONTS}</style>
        <div style={{ width: "min(90vw, 520px)" }}>
          <div style={{
            fontFamily: display, fontWeight: 900, fontSize: 28, letterSpacing: "0.4em",
            marginBottom: 28, animation: "bootFlicker 1.2s steps(1) both", color: TEXT,
            textShadow: `0 0 18px ${CYAN}`,
          }}>
            J.A.R.V.I.S
          </div>
          {BOOT_LINES.slice(0, bootStep).map((l, i) => (
            <div key={i} style={{ fontSize: 12, marginBottom: 8, opacity: 0.9, animation: "riseIn .25s both" }}>
              <span style={{ color: AMBER, marginRight: 10 }}>▸</span>{l}
            </div>
          ))}
          {bootStep >= BOOT_LINES.length && (
            <div style={{ fontSize: 12, marginBottom: 8, animation: "riseIn .25s both" }}>
              <span style={{ color: AMBER, marginRight: 10 }}>▸</span>
              COGNITION CORE [{BACKEND.toUpperCase()}] ......{" "}
              {aiStatus.state === "checking" ? (
                <span style={{ animation: "breathe 1s infinite" }}>PROBING…</span>
              ) : aiStatus.fallback ? (
                <span style={{ color: AMBER }}>OFFLINE</span>
              ) : aiStatus.state === "online" ? (
                <span style={{ color: CYAN }}>ONLINE · {aiStatus.detail}</span>
              ) : (
                <span style={{ color: AMBER }}>OFFLINE · {aiStatus.detail}</span>
              )}
            </div>
          )}
          {aiStatus.fallback && bootStep >= BOOT_LINES.length && (
            <div style={{ fontSize: 12, marginBottom: 8, color: AMBER, animation: "riseIn .25s both" }}>
              <span style={{ marginRight: 10 }}>⚠</span>
              REROUTING → CLAUDE CLOUD UPLINK · DATA LEAVES THIS MACHINE
            </div>
          )}
          {bootStep >= BOOT_LINES.length && aiStatus.state !== "checking" && (
            <div style={{
              fontSize: 12, marginBottom: 8, animation: "riseIn .25s both",
              color: aiStatus.state === "online" && !aiStatus.fallback ? CYAN : AMBER,
            }}>
              <span style={{ color: AMBER, marginRight: 10 }}>▸</span>
              {aiStatus.state !== "online" ? "ENTERING DEGRADED MODE"
                : aiStatus.fallback ? "SYSTEMS NOMINAL · CLOUD FALLBACK ACTIVE"
                : "ALL SYSTEMS NOMINAL"}
            </div>
          )}
          {aiStatus.fallback && bootStep >= BOOT_LINES.length && (
            <div role="alertdialog" aria-label="Cloud fallback warning" style={{
              marginTop: 26, padding: "22px 20px",
              border: `2px solid ${AMBER}`,
              animation: "alertFlash 1.4s ease-in-out infinite, riseIn .4s both",
            }}>
              <div style={{
                fontFamily: display, fontSize: 15, letterSpacing: "0.25em",
                color: AMBER, marginBottom: 14, display: "flex", alignItems: "center", gap: 12,
              }}>
                <span style={{ fontSize: 22 }}>⚠</span> CLOUD FALLBACK ENGAGED
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.7, color: TEXT, marginBottom: 8 }}>
                The local cognition core (Ollama) is <span style={{ color: AMBER }}>offline</span>.
                JARVIS can continue using the <span style={{ color: AMBER }}>Claude cloud uplink</span> instead.
              </div>
              <div style={{ fontSize: 12, lineHeight: 1.7, color: AMBER, marginBottom: 18 }}>
                ▸ Your messages will leave this machine.<br />
                ▸ To stay local: start Ollama, then reload this page.
              </div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button
                  onClick={acknowledgeFallback}
                  style={{
                    fontFamily: display, fontSize: 11, letterSpacing: "0.25em",
                    background: AMBER, color: "#030A12", border: `1px solid ${AMBER}`,
                    padding: "11px 20px", cursor: "pointer",
                    boxShadow: `0 0 16px ${AMBER}99`,
                  }}
                >
                  PROCEED ON CLOUD
                </button>
                <button
                  onClick={() => window.location.reload()}
                  style={{
                    fontFamily: display, fontSize: 11, letterSpacing: "0.25em",
                    background: "transparent", color: CYAN, border: `1px solid ${CYAN}66`,
                    padding: "11px 20px", cursor: "pointer",
                  }}
                >
                  RETRY LOCAL CORE
                </button>
              </div>
            </div>
          )}
          <div style={{ height: 2, background: "#14506044", marginTop: 22 }}>
            <div style={{
              height: "100%",
              width: `${aiStatus.state !== "checking" && bootStep >= BOOT_LINES.length ? 100 : (bootStep / (BOOT_LINES.length + 1)) * 100}%`,
              background: aiStatus.state === "offline" ? AMBER : CYAN,
              boxShadow: `0 0 10px ${aiStatus.state === "offline" ? AMBER : CYAN}`,
              transition: "width .3s, background .3s",
            }} />
          </div>
        </div>
      </div>
    );
  }

  // Main HUD
  return (
    <div data-root="true" style={{
      height: "100vh",
      background: `radial-gradient(ellipse 80% 60% at 50% 42%, #07202E 0%, #030A12 65%)`,
      color: TEXT, fontFamily: mono, position: "relative", overflow: "hidden",
      display: "flex", flexDirection: "column",
    }}>
      <style>{FONTS}</style>
      <div aria-hidden style={{
        position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.5,
        backgroundImage: `linear-gradient(${CYAN}0d 1px, transparent 1px), linear-gradient(90deg, ${CYAN}0d 1px, transparent 1px)`,
        backgroundSize: "44px 44px",
      }} />
      <div aria-hidden style={{
        position: "absolute", left: 0, right: 0, height: 90, pointerEvents: "none",
        background: `linear-gradient(180deg, transparent, ${CYAN}10, transparent)`,
        animation: "scanline 9s linear infinite",
      }} />
      <Brackets />
      <header style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "26px 40px 10px",
        maxWidth: 1680, width: "100%", margin: "0 auto",
      }}>
        <div>
          <div style={{
            fontFamily: display, fontWeight: 700, fontSize: 20, letterSpacing: "0.45em",
            textShadow: `0 0 16px ${CYAN}aa`,
          }}>
            J.A.R.V.I.S
          </div>
          <div style={{ fontSize: 10, letterSpacing: "0.3em", color: CYAN, opacity: 0.8, marginTop: 4 }}>
            JUST A RATHER VERY INTELLIGENT SYSTEM
          </div>
        </div>
        <div style={{ textAlign: "right", display: "flex", alignItems: "center", gap: 14 }}>
          {TTS_BACKEND === "browser" ? (
            <select
              value={voiceURI || ""}
              onChange={e => {
                setVoiceURI(e.target.value);
                setTimeout(() => {
                  voiceURIRef.current = e.target.value;
                  speak("Voice protocol updated, sir.");
                }, 0);
              }}
              aria-label="Select assistant voice"
              style={{
                fontFamily: mono, fontSize: 10, letterSpacing: "0.08em",
                background: "#06141F", color: CYAN, cursor: "pointer",
                border: `1px solid ${CYAN}55`, padding: "7px 8px",
                maxWidth: 170, outline: "none",
              }}
            >
              {voices.length === 0 && <option value="">NO VOICES FOUND</option>}
              {voices.map(v => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name.replace(/\(.*?\)/g, "").trim().toUpperCase()} · {v.lang}
                </option>
              ))}
            </select>
          ) : (
            <div style={{
              fontFamily: mono, fontSize: 10, letterSpacing: "0.08em",
              color: CYAN, border: `1px solid ${CYAN}55`, padding: "7px 8px",
            }}>
              {TTS_BACKEND === "openai"
                ? `OPENAI · ${OPENAI_VOICE.toUpperCase()}`
                : `ELEVENLABS · AI VOICE`}
              {!TTS_API_KEY && <span style={{ color: AMBER }}> · NO KEY</span>}
            </div>
          )}
          <button
            onClick={() => {
              const idx = OLLAMA_MODELS.findIndex(m => m.id === model);
              const next = OLLAMA_MODELS[(idx + 1) % OLLAMA_MODELS.length];
              switchModel(next.id);
            }}
            disabled={switchingModel}
            aria-label="Switch AI model"
            title={`Active model: ${model} — click to switch`}
            style={{
              fontFamily: display, fontSize: 9, letterSpacing: "0.2em",
              background: "transparent",
              cursor: switchingModel ? "wait" : "pointer", padding: "7px 12px",
              border: `1px solid ${CYAN}55`, color: CYAN + "cc",
              opacity: switchingModel ? 0.5 : 1, transition: "all .3s",
            }}
            onMouseEnter={e => { if (!switchingModel) { e.currentTarget.style.borderColor = CYAN; e.currentTarget.style.color = CYAN; } }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = CYAN + "55"; e.currentTarget.style.color = CYAN + "cc"; }}
          >
            ◈ {(OLLAMA_MODELS.find(m => m.id === model) || OLLAMA_MODELS[0]).label}
            <span style={{ fontSize: 8, opacity: 0.7 }}> · {switchingModel ? "…" : (OLLAMA_MODELS.find(m => m.id === model) || OLLAMA_MODELS[0]).tag}</span>
          </button>
          <button
            onClick={() => setMemoryPanelOpen(o => !o)}
            aria-label="Toggle brain memory panel"
            aria-pressed={memoryPanelOpen}
            style={{
              fontFamily: display, fontSize: 9, letterSpacing: "0.2em",
              background: memoryPanelOpen ? CYAN + "22" : "transparent",
              cursor: "pointer", padding: "7px 10px",
              border: `1px solid ${memoryPanelOpen ? CYAN : CYAN + "55"}`,
              color: memoryPanelOpen ? CYAN : CYAN + "88",
              boxShadow: memoryPanelOpen ? `0 0 10px ${CYAN}44` : "none",
              transition: "all .3s",
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = CYAN; e.currentTarget.style.color = CYAN; }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = memoryPanelOpen ? CYAN : CYAN + "55";
              e.currentTarget.style.color = memoryPanelOpen ? CYAN : CYAN + "88";
            }}
          >
            🧠 MEMORY {memories.length > 0 && <span style={{ fontSize: 8, opacity: 0.7 }}>({memories.length})</span>}
          </button>
          <button
            onClick={() => setTaskPanelOpen(o => !o)}
            aria-label="Toggle task list"
            aria-pressed={taskPanelOpen}
            style={{
              fontFamily: display, fontSize: 9, letterSpacing: "0.2em",
              background: taskPanelOpen ? PRIORITY_COLOR.high + "22" : "transparent",
              cursor: "pointer", padding: "7px 10px",
              border: `1px solid ${taskPanelOpen ? PRIORITY_COLOR.high : PRIORITY_COLOR.high + "55"}`,
              color: taskPanelOpen ? PRIORITY_COLOR.high : PRIORITY_COLOR.high + "88",
              boxShadow: taskPanelOpen ? `0 0 10px ${PRIORITY_COLOR.high}44` : "none",
              transition: "all .3s",
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = PRIORITY_COLOR.high; e.currentTarget.style.color = PRIORITY_COLOR.high; }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = taskPanelOpen ? PRIORITY_COLOR.high : PRIORITY_COLOR.high + "55";
              e.currentTarget.style.color = taskPanelOpen ? PRIORITY_COLOR.high : PRIORITY_COLOR.high + "88";
            }}
          >
            ☑ TASKS {tasks.filter(t => !t.done).length > 0 && <span style={{ fontSize: 8, opacity: 0.7 }}>({tasks.filter(t => !t.done).length})</span>}
          </button>
          {freeLLMAvailable && (
            <button
              onClick={() => setFreeLLMActive(a => !a)}
              title={`freellmapi detected${FREELLM_MODEL ? ` — model: ${FREELLM_MODEL}` : " — auto-routing"}`}
              style={{
                fontFamily: display, fontSize: 9, letterSpacing: "0.2em",
                background: freeLLMActive ? "#A855F722" : "transparent",
                cursor: "pointer", padding: "7px 10px",
                border: `1px solid ${freeLLMActive ? "#A855F7" : "#A855F755"}`,
                color: freeLLMActive ? "#A855F7" : "#A855F788",
                boxShadow: freeLLMActive ? "0 0 10px #A855F744" : "none",
                transition: "all .3s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "#A855F7"; e.currentTarget.style.color = "#A855F7"; }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = freeLLMActive ? "#A855F7" : "#A855F755";
                e.currentTarget.style.color = freeLLMActive ? "#A855F7" : "#A855F788";
              }}
            >
              ⚡ FREE LLM {freeLLMActive && <span style={{ fontSize: 8, opacity: 0.7 }}>· ON</span>}
            </button>
          )}
          <button
            onClick={() => {
              if (!window.confirm("Clear JARVIS memory? This will erase all conversation history.")) return;
              localStorage.removeItem("jarvis-history");
              setMessages([{ role: "assistant", text: "Memory wiped, sir. Starting fresh." }]);
              speak("Memory wiped, sir. Starting fresh.");
            }}
            aria-label="Clear conversation memory"
            style={{
              fontFamily: display, fontSize: 9, letterSpacing: "0.2em",
              background: "transparent", cursor: "pointer", padding: "7px 10px",
              border: `1px solid ${AMBER}55`, color: AMBER + "99",
              transition: "all .3s",
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = AMBER; e.currentTarget.style.color = AMBER; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = AMBER + "55"; e.currentTarget.style.color = AMBER + "99"; }}
          >
            🧹 CLEAR MEM
          </button>
          <button
            onClick={() => {
              setVoiceOn(v => {
                if (v) window.speechSynthesis?.cancel();
                return !v;
              });
            }}
            aria-pressed={voiceOn}
            aria-label={voiceOn ? "Mute voice output" : "Enable voice output"}
            style={{
              fontFamily: display, fontSize: 9, letterSpacing: "0.25em",
              background: "transparent", cursor: "pointer", padding: "7px 12px",
              border: `1px solid ${voiceOn ? CYAN : "#145060"}`,
              color: voiceOn ? CYAN : "#5A7E8A",
              boxShadow: voiceOn ? `0 0 10px ${CYAN}44` : "none",
              transition: "all .3s",
            }}
          >
            {voiceOn ? "🔊 VOICE ON" : "🔇 VOICE OFF"}
          </button>
          <div>
            <div style={{ fontFamily: display, fontSize: 18, letterSpacing: "0.18em", color: CYAN }}>
              {clock.toLocaleTimeString([], { hour12: false })}
            </div>
            <div style={{ fontSize: 10, letterSpacing: "0.25em", opacity: 0.65, marginTop: 2 }}>
              {clock.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase()}
            </div>
          </div>
        </div>
      </header>
      {aiStatus.fallback && (
        <div role="alert" style={{
          maxWidth: 1680, width: "100%", margin: "6px auto 0",
          padding: "0 40px", boxSizing: "border-box",
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            border: `2px solid ${AMBER}`,
            padding: "10px 16px", fontSize: 11, letterSpacing: "0.12em",
            color: AMBER,
            animation: "alertFlash 1.4s ease-in-out infinite, alertBorder 1.4s ease-in-out infinite",
          }}>
            <span style={{ fontSize: 15 }}>⚠</span>
            <span>
              LOCAL CORE OFFLINE — RESPONSES ROUTED TO CLAUDE CLOUD UPLINK.
              YOUR MESSAGES ARE LEAVING THIS MACHINE. RESTART OLLAMA AND RELOAD TO RESTORE LOCAL MODE.
            </span>
          </div>
        </div>
      )}
      <main style={{
        flex: 1, display: "grid", gap: 24, padding: "10px 40px 16px",
        gridTemplateColumns: "minmax(160px, 210px) 1fr minmax(300px, 460px)",
        alignItems: "stretch", minHeight: 0,
        maxWidth: 1680, width: "100%", margin: "0 auto",
      }}>
        <section style={{
          alignSelf: "center",
          border: `1px solid ${CYAN}33`, padding: "20px 18px",
          background: "#06141Fcc", backdropFilter: "blur(4px)",
          animation: "riseIn .6s both",
        }}>
          <div style={{
            fontFamily: display, fontSize: 11, letterSpacing: "0.3em",
            color: CYAN, marginBottom: 18,
          }}>
            SYSTEM TELEMETRY
          </div>
          <Gauge label="REACTOR OUTPUT" value={stats.pwr} unit="%" />
          <Gauge label="PROCESSOR LOAD" value={stats.cpu} unit="%" />
          <Gauge label="UPLINK SIGNAL" value={stats.net} unit="%" />
          <Gauge label="CORE TEMP" value={stats.tmp} unit="°C" />
          <div style={{
            marginTop: 18, paddingTop: 14, borderTop: `1px dashed ${CYAN}33`,
            fontSize: 10, letterSpacing: "0.2em", display: "flex",
            justifyContent: "space-between",
          }}>
            <span style={{ opacity: 0.7 }}>COGNITION</span>
            <span style={{ color: aiStatus.state !== "online" || aiStatus.fallback ? AMBER : CYAN }}>
              {aiStatus.state !== "online" ? "▲ OFFLINE"
                : aiStatus.fallback ? "⚠ CLOUD FALLBACK"
                : `● ${aiStatus.detail}`}
            </span>
          </div>
          <div style={{
            marginTop: 10,
            fontSize: 10, letterSpacing: "0.2em", display: "flex",
            justifyContent: "space-between",
          }}>
            <span style={{ opacity: 0.7 }}>STATUS</span>
            <span style={{ color: coreState === "idle" ? CYAN : AMBER }}>
              {coreState === "idle" ? "● NOMINAL"
                : coreState === "thinking" ? "◌ PROCESSING"
                : coreState === "listening" ? "◉ LISTENING"
                : "▲ RESPONDING"}
            </span>
          </div>
          <div style={{
            marginTop: 10,
            fontSize: 10, letterSpacing: "0.2em", display: "flex",
            justifyContent: "space-between",
          }}>
            <span style={{ opacity: 0.7 }}>MEMORY</span>
            <span style={{ color: CYAN }}>
              {messages.filter(m => m.role !== "action").length} LOG{messages.filter(m => m.role !== "action").length !== 1 ? "S" : ""}
            </span>
          </div>
          <div style={{
            marginTop: 10,
            fontSize: 10, letterSpacing: "0.2em", display: "flex",
            justifyContent: "space-between",
          }}>
            <span style={{ opacity: 0.7 }}>VOICE</span>
            <span style={{ color: CYAN, fontSize: 9 }}>
              {TTS_BACKEND === "browser" ? "SYS TTS"
                : TTS_BACKEND === "openai" ? (TTS_API_KEY ? `OPENAI·${OPENAI_VOICE.toUpperCase()}` : "NO KEY")
                : TTS_API_KEY ? "ELEVENLABS" : "NO KEY"}
            </span>
          </div>
        </section>
        <section style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <ReactorCore state={coreState} amplitude={amplitude} />
        </section>
        <section style={{
          display: "flex", flexDirection: "column", minHeight: 0,
          border: `1px solid ${CYAN}33`, background: "#06141Fcc",
          backdropFilter: "blur(4px)", animation: "riseIn .6s both",
        }}>
          <div style={{
            fontFamily: display, fontSize: 11, letterSpacing: "0.3em", color: CYAN,
            padding: "16px 18px 12px", borderBottom: `1px solid ${CYAN}22`,
          }}>
            COMMUNICATION LOG
          </div>
          <div ref={logRef} data-log="true" style={{ flex: 1, overflowY: "auto", padding: "14px 18px", minHeight: 0 }}>
            {messages.map((m, i) => m.role === "action" ? (
              <div key={i} role="group" aria-label="Action confirmation" style={{
                marginBottom: 14, padding: "12px 14px", animation: "riseIn .3s both",
                border: `1px solid ${m.status === "pending" ? AMBER : m.status === "done" ? CYAN : "#145060"}`,
                background: m.status === "pending" ? AMBER + "10" : "transparent",
              }}>
                <div style={{
                  fontSize: 9, letterSpacing: "0.25em", marginBottom: 6,
                  color: m.status === "pending" ? AMBER : m.status === "done" ? CYAN : "#5A7E8A",
                }}>
                  {m.status === "pending" ? "⚠ ACTION REQUIRES AUTHORIZATION"
                    : m.status === "executing" ? "◌ EXECUTING…"
                    : m.status === "done" ? "✓ EXECUTED"
                    : "✕ CANCELED"}
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.5, marginBottom: m.status === "pending" ? 10 : 0 }}>
                  {m.summary}
                </div>
                {m.status === "pending" && (
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => resolveAction(m.id, true)} style={{
                      fontFamily: display, fontSize: 9, letterSpacing: "0.2em",
                      background: AMBER, color: "#030A12", border: "none",
                      padding: "7px 14px", cursor: "pointer",
                    }}>
                      AUTHORIZE
                    </button>
                    <button onClick={() => resolveAction(m.id, false)} style={{
                      fontFamily: display, fontSize: 9, letterSpacing: "0.2em",
                      background: "transparent", color: CYAN, border: `1px solid ${CYAN}66`,
                      padding: "7px 14px", cursor: "pointer",
                    }}>
                      CANCEL
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div key={i} style={{
                marginBottom: 14,
                borderLeft: `2px solid ${m.role === "user" ? AMBER + "66" : CYAN + "44"}`,
                paddingLeft: 12,
                animation: "riseIn .3s both",
              }}>
                <div style={{
                  display: "flex", justifyContent: "space-between", alignItems: "baseline",
                  marginBottom: 5,
                }}>
                  <span style={{
                    fontSize: 8, letterSpacing: "0.3em", fontFamily: "'Orbitron', sans-serif",
                    color: m.role === "user" ? AMBER : CYAN,
                  }}>
                    {m.role === "user" ? "YOU" : "JARVIS"}
                  </span>
                  {m.ts && (
                    <span style={{ fontSize: 8, color: CYAN, opacity: 0.28, letterSpacing: "0.06em" }}>
                      {m.ts}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: TEXT, opacity: 0.95 }}>
                  <MessageText text={m.text} />
                  {m._streaming && (
                    <span style={{ animation: "breathe 0.8s ease-in-out infinite", color: CYAN }}>▌</span>
                  )}
                </div>
              </div>
            ))}
            {coreState === "thinking" && (
              <div style={{ fontSize: 11, color: CYAN, letterSpacing: "0.2em", animation: "breathe 1s infinite" }}>
                ▸ ANALYZING…
              </div>
            )}
          </div>
        </section>
      </main>
      <footer style={{ padding: "0 40px 30px", maxWidth: 1680, width: "100%", margin: "0 auto" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 14,
          border: `1px solid ${CYAN}55`, background: "#06141Fdd",
          padding: "12px 18px", boxShadow: `0 0 24px ${CYAN}1a inset`,
        }}>
          <span style={{ color: AMBER, fontSize: 14 }}>❯</span>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && send()}
            placeholder={listening ? "Listening, sir…" : "Issue a command, sir…"}
            aria-label="Command input"
            style={{
              flex: 1, background: "transparent", border: "none", outline: "none",
              color: TEXT, fontFamily: mono, fontSize: 14, letterSpacing: "0.05em",
              caretColor: CYAN,
            }}
          />
          <button
            onMouseDown={() => { pttSourceRef.current = "local"; startListening(); }}
            onMouseUp={stopListening}
            onMouseLeave={stopListening}
            onTouchStart={(e) => { e.preventDefault(); pttSourceRef.current = "local"; startListening(); }}
            onTouchEnd={(e) => { e.preventDefault(); stopListening(); }}
            disabled={!micSupported}
            aria-pressed={listening}
            aria-label={listening ? "Release to send" : "Hold to speak a command"}
            title={micSupported ? "Hold to talk (or hold ⌥ Option)" : "Voice input not supported in this browser"}
            style={{
              width: 40, height: 40, borderRadius: "50%", cursor: micSupported ? "pointer" : "not-allowed",
              border: `1px solid ${listening ? AMBER : CYAN}`,
              background: listening ? AMBER + "22" : "transparent",
              color: listening ? AMBER : CYAN, fontSize: 16,
              boxShadow: listening ? `0 0 18px ${AMBER}99` : `0 0 8px ${CYAN}33`,
              animation: listening ? "breathe 1s ease-in-out infinite" : "none",
              transition: "all .3s", flexShrink: 0,
              opacity: micSupported ? 1 : 0.4,
            }}
          >
            {listening ? "◉" : "🎙"}
          </button>
          <button
            onClick={send}
            disabled={coreState === "thinking"}
            style={{
              fontFamily: display, fontSize: 10, letterSpacing: "0.3em",
              color: coreState === "thinking" ? "#14506088" : "#030A12",
              background: coreState === "thinking" ? "transparent" : CYAN,
              border: `1px solid ${CYAN}`, padding: "8px 18px", cursor: "pointer",
              boxShadow: coreState === "thinking" ? "none" : `0 0 14px ${CYAN}88`,
              transition: "all .3s",
            }}
          >
            EXECUTE
          </button>
        </div>
        {(listening || (coreState === "idle" && !listening)) && (
          <div style={{
            textAlign: "center", marginTop: 8,
            fontSize: 9, letterSpacing: "0.25em",
            color: listening ? AMBER + "99" : CYAN + "44", fontFamily: display,
            pointerEvents: "none", userSelect: "none",
          }}>
            {listening ? "RELEASE TO SEND" : "HOLD ⌥ TO TALK · ⌥V ANYWHERE"}
          </div>
        )}
      </footer>
      {memoryPanelOpen && (
        <div style={{
          position: "fixed", top: 0, right: 0, bottom: 0,
          width: "min(400px, 90vw)",
          background: "#030A12f0", backdropFilter: "blur(10px)",
          borderLeft: `1px solid ${CYAN}44`,
          display: "flex", flexDirection: "column",
          zIndex: 200, animation: "riseIn .2s both",
        }}>
          <div style={{
            padding: "20px 18px 14px",
            borderBottom: `1px solid ${CYAN}22`,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <div style={{ fontFamily: display, fontSize: 11, letterSpacing: "0.3em", color: CYAN }}>
              🧠 BRAIN MEMORY
              <span style={{ fontSize: 9, opacity: 0.55, marginLeft: 8 }}>{memories.length}/200</span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => {
                  if (!window.confirm("Clear all brain memories? This cannot be undone.")) return;
                  setMemories([]);
                }}
                style={{
                  fontFamily: display, fontSize: 8, letterSpacing: "0.15em",
                  background: "transparent", color: AMBER + "88",
                  border: `1px solid ${AMBER}44`, padding: "5px 9px", cursor: "pointer",
                  transition: "all .2s",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = AMBER; e.currentTarget.style.borderColor = AMBER; }}
                onMouseLeave={e => { e.currentTarget.style.color = AMBER + "88"; e.currentTarget.style.borderColor = AMBER + "44"; }}
              >
                CLEAR ALL
              </button>
              <button
                onClick={() => setMemoryPanelOpen(false)}
                style={{
                  fontFamily: display, fontSize: 10, background: "transparent",
                  color: CYAN + "99", border: `1px solid ${CYAN}44`,
                  padding: "5px 9px", cursor: "pointer", transition: "all .2s",
                }}
                onMouseEnter={e => { e.currentTarget.style.color = CYAN; e.currentTarget.style.borderColor = CYAN; }}
                onMouseLeave={e => { e.currentTarget.style.color = CYAN + "99"; e.currentTarget.style.borderColor = CYAN + "44"; }}
                aria-label="Close memory panel"
              >
                ✕
              </button>
            </div>
          </div>
          <div style={{ padding: "12px 18px", borderBottom: `1px solid ${CYAN}22` }}>
            <div style={{
              display: "flex", gap: 8, alignItems: "center",
              border: `1px solid ${CYAN}33`, padding: "8px 12px",
              background: "#06141F88",
            }}>
              <input
                value={newMemoryText}
                onChange={e => setNewMemoryText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && newMemoryText.trim()) {
                    addMemory(newMemoryText);
                    setNewMemoryText("");
                  }
                }}
                placeholder="Add a memory manually…"
                style={{
                  flex: 1, background: "transparent", border: "none", outline: "none",
                  color: TEXT, fontFamily: "'Share Tech Mono', monospace",
                  fontSize: 11, letterSpacing: "0.04em", caretColor: CYAN,
                }}
              />
              <button
                onClick={() => { addMemory(newMemoryText); setNewMemoryText(""); }}
                style={{
                  fontFamily: display, fontSize: 8, letterSpacing: "0.2em",
                  background: CYAN, color: "#030A12", border: "none",
                  padding: "5px 10px", cursor: "pointer", flexShrink: 0,
                }}
              >
                ADD
              </button>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 18px" }}>
            {memories.length === 0 ? (
              <div style={{
                fontSize: 11, color: CYAN, opacity: 0.35, letterSpacing: "0.12em",
                textAlign: "center", marginTop: 50, fontFamily: display,
              }}>
                NO MEMORIES STORED
              </div>
            ) : (
              [...memories].sort((a,b) => (b.importance||2)-(a.importance||2)).map(m => {
                const catColor = CATEGORY_COLOR[m.category] || CATEGORY_COLOR.general;
                return (
                <div key={m.id} style={{
                  marginBottom: 8, padding: "9px 12px",
                  border: `1px solid ${catColor}22`,
                  borderLeft: `3px solid ${catColor}88`,
                  background: "#06141F88",
                  display: "flex", gap: 10, alignItems: "flex-start",
                  animation: "riseIn .2s both",
                }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <span style={{
                        fontSize: 8, letterSpacing: "0.15em", fontFamily: "'Share Tech Mono', monospace",
                        color: catColor, background: catColor + "22",
                        padding: "1px 5px", borderRadius: 2,
                      }}>
                        {(m.category || "general").toUpperCase()}
                      </span>
                      {"★".repeat(Math.min(m.importance || 2, 5)).split("").map((s,i) => (
                        <span key={i} style={{ fontSize: 7, color: catColor, opacity: 0.7 }}>{s}</span>
                      ))}
                    </div>
                    <div style={{
                      fontSize: 11.5, lineHeight: 1.55, color: TEXT,
                      fontFamily: "'Share Tech Mono', monospace",
                    }}>
                      {m.content}
                    </div>
                    <div style={{ fontSize: 9, color: CYAN, opacity: 0.35, marginTop: 5, letterSpacing: "0.07em" }}>
                      {new Date(m.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                      {m.accessCount > 0 && ` · referenced ${m.accessCount}×`}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteMemory(m.id)}
                    aria-label="Delete memory"
                    style={{
                      background: "transparent", border: "none", cursor: "pointer",
                      color: "#3A6070", fontSize: 15, flexShrink: 0,
                      padding: "0 2px", lineHeight: 1, transition: "color .2s",
                    }}
                    onMouseEnter={e => e.currentTarget.style.color = AMBER}
                    onMouseLeave={e => e.currentTarget.style.color = "#3A6070"}
                  >
                    🗑
                  </button>
                </div>
              );})
            )}
          </div>
        </div>
      )}
      {taskPanelOpen && (
        <div style={{
          position: "fixed", top: 0, right: 0, bottom: 0,
          width: "min(400px, 90vw)",
          background: "#030A12f0", backdropFilter: "blur(10px)",
          borderLeft: `1px solid ${PRIORITY_COLOR.high}44`,
          display: "flex", flexDirection: "column",
          zIndex: 200, animation: "riseIn .2s both",
        }}>
          <div style={{
            padding: "20px 18px 14px",
            borderBottom: `1px solid ${PRIORITY_COLOR.high}22`,
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <div style={{ fontFamily: display, fontSize: 11, letterSpacing: "0.3em", color: PRIORITY_COLOR.high }}>
              ☑ TASK LIST
              <span style={{ fontSize: 9, opacity: 0.55, marginLeft: 8 }}>
                {tasks.filter(t => !t.done).length} pending
              </span>
            </div>
            <button
              onClick={() => setTaskPanelOpen(false)}
              style={{
                fontFamily: display, fontSize: 10, background: "transparent",
                color: PRIORITY_COLOR.high + "99", border: `1px solid ${PRIORITY_COLOR.high}44`,
                padding: "5px 9px", cursor: "pointer", transition: "all .2s",
              }}
              onMouseEnter={e => { e.currentTarget.style.color = PRIORITY_COLOR.high; e.currentTarget.style.borderColor = PRIORITY_COLOR.high; }}
              onMouseLeave={e => { e.currentTarget.style.color = PRIORITY_COLOR.high + "99"; e.currentTarget.style.borderColor = PRIORITY_COLOR.high + "44"; }}
            >✕</button>
          </div>
          <div style={{ padding: "12px 18px", borderBottom: `1px solid ${PRIORITY_COLOR.high}22` }}>
            <div style={{
              border: `1px solid ${PRIORITY_COLOR.high}33`, background: "#06141F88",
            }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 12px" }}>
                <input
                  value={newTaskText}
                  onChange={e => setNewTaskText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && newTaskText.trim()) {
                      addTask(newTaskText, newTaskPriority);
                      setNewTaskText("");
                    }
                  }}
                  placeholder="New task…"
                  style={{
                    flex: 1, background: "transparent", border: "none", outline: "none",
                    color: TEXT, fontFamily: "'Share Tech Mono', monospace",
                    fontSize: 11, letterSpacing: "0.04em", caretColor: PRIORITY_COLOR.high,
                  }}
                />
                <button
                  onClick={() => { if (newTaskText.trim()) { addTask(newTaskText, newTaskPriority); setNewTaskText(""); } }}
                  style={{
                    fontFamily: display, fontSize: 8, letterSpacing: "0.2em",
                    background: PRIORITY_COLOR.high, color: "#030A12", border: "none",
                    padding: "5px 10px", cursor: "pointer", flexShrink: 0,
                  }}
                >ADD</button>
              </div>
              <div style={{ display: "flex", gap: 0, borderTop: `1px solid ${PRIORITY_COLOR.high}22` }}>
                {["high", "medium", "low"].map(p => (
                  <button
                    key={p}
                    onClick={() => setNewTaskPriority(p)}
                    style={{
                      flex: 1, fontFamily: display, fontSize: 8, letterSpacing: "0.15em",
                      padding: "5px 0",
                      background: newTaskPriority === p ? PRIORITY_COLOR[p] + "22" : "transparent",
                      border: "none",
                      borderRight: p !== "low" ? `1px solid ${PRIORITY_COLOR.high}22` : "none",
                      color: newTaskPriority === p ? PRIORITY_COLOR[p] : PRIORITY_COLOR[p] + "66",
                      cursor: "pointer", transition: "all .2s",
                    }}
                  >
                    {PRIORITY_LABEL[p]}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 18px" }}>
            {tasks.length === 0 ? (
              <div style={{
                fontSize: 11, color: PRIORITY_COLOR.high, opacity: 0.35, letterSpacing: "0.12em",
                textAlign: "center", marginTop: 50, fontFamily: display,
              }}>
                NO TASKS — ALL CLEAR, SIR
              </div>
            ) : (
              // Sort: undone high → undone medium → undone low → done
              [...tasks].sort((a, b) => {
                if (a.done !== b.done) return a.done ? 1 : -1;
                const order = { high: 0, medium: 1, low: 2 };
                return (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
              }).map(task => (
                <div key={task.id} style={{
                  marginBottom: 8, padding: "9px 12px",
                  border: `1px solid ${task.done ? "#ffffff11" : PRIORITY_COLOR[task.priority] + "33"}`,
                  borderLeft: `3px solid ${task.done ? "#ffffff22" : PRIORITY_COLOR[task.priority] + "99"}`,
                  background: task.done ? "#06141F44" : "#06141F88",
                  display: "flex", gap: 10, alignItems: "center",
                  animation: "riseIn .2s both",
                  opacity: task.done ? 0.5 : 1,
                  transition: "all .2s",
                }}>
                  <button
                    onClick={() => toggleTask(task.id)}
                    aria-label={task.done ? "Mark incomplete" : "Mark complete"}
                    style={{
                      width: 16, height: 16, flexShrink: 0,
                      border: `1.5px solid ${task.done ? "#ffffff44" : PRIORITY_COLOR[task.priority]}`,
                      background: task.done ? PRIORITY_COLOR[task.priority] + "44" : "transparent",
                      cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
                      color: PRIORITY_COLOR[task.priority], fontSize: 10, transition: "all .2s",
                      borderRadius: 2,
                    }}
                  >{task.done ? "✓" : ""}</button>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <span style={{
                        fontSize: 8, letterSpacing: "0.15em", fontFamily: "'Share Tech Mono', monospace",
                        color: PRIORITY_COLOR[task.priority],
                        background: PRIORITY_COLOR[task.priority] + "22",
                        padding: "1px 5px", borderRadius: 2,
                      }}>{PRIORITY_LABEL[task.priority]}</span>
                    </div>
                    <div style={{
                      fontSize: 12, lineHeight: 1.45, color: task.done ? TEXT + "66" : TEXT,
                      fontFamily: "'Share Tech Mono', monospace",
                      textDecoration: task.done ? "line-through" : "none",
                      textDecorationColor: PRIORITY_COLOR[task.priority] + "88",
                    }}>
                      {task.title}
                    </div>
                    <div style={{ fontSize: 9, color: CYAN, opacity: 0.3, marginTop: 4, letterSpacing: "0.07em" }}>
                      {new Date(task.createdAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                    </div>
                  </div>
                  <button
                    onClick={() => deleteTask(task.id)}
                    aria-label="Delete task"
                    style={{
                      background: "transparent", border: "none", cursor: "pointer",
                      color: "#3A6070", fontSize: 15, flexShrink: 0,
                      padding: "0 2px", lineHeight: 1, transition: "color .2s",
                    }}
                    onMouseEnter={e => e.currentTarget.style.color = AMBER}
                    onMouseLeave={e => e.currentTarget.style.color = "#3A6070"}
                  >🗑</button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <style>{`
        @media (max-width: 860px) {
          /* Let the page grow & scroll when panels stack vertically */
          [data-root] { height: auto !important; min-height: 100vh !important; overflow: visible !important; }
          /* Stack the three panels, reactor first */
          main { grid-template-columns: 1fr !important; gap: 16px !important; padding: 6px 16px 12px !important; }
          main > section:nth-child(2) { order: -1; }
          /* Reactor: scale up for single-column view */
          main > section:nth-child(2) > div { width: min(62vw, 280px, 34vh) !important; }
          /* Header: let controls wrap instead of overflowing */
          header { flex-wrap: wrap !important; gap: 12px !important; padding: 18px 16px 6px !important; }
          header > div:last-child { flex-wrap: wrap !important; gap: 10px !important; justify-content: flex-end; }
          header select { max-width: 130px !important; }
          /* Footer command line */
          footer { padding: 0 16px 18px !important; }
          footer input { font-size: 16px !important; } /* prevents iOS zoom-on-focus */
          footer > div { gap: 8px !important; padding: 8px 12px !important; }
          footer button:last-child { padding: 8px 12px !important; letter-spacing: 0.15em !important; }
          /* Fallback banner */
          [role="alert"] { padding: 0 16px !important; }
          [role="alert"] > div { font-size: 10px !important; letter-spacing: 0.06em !important; }
          /* Comm log: keep the input reachable without scrolling */
          [data-log] { max-height: 34vh !important; }
          /* Telemetry panel reads better full-width */
          main > section:first-of-type { align-self: stretch !important; }
        }
        @media (max-width: 400px) {
          header > div:first-child > div:first-child { font-size: 16px !important; letter-spacing: 0.3em !important; }
          footer button:last-child { display: none; } /* Enter key / mic still send */
        }
      `}</style>
    </div>
  );
}
