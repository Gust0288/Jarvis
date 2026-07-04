/* ============================================================
   JARVIS LOCAL TOOL SERVER
   ------------------------------------------------------------
   The "hands" of your JARVIS. Runs on YOUR Mac, localhost only.
   - Talks to Ollama (the brain) with tool-calling enabled
   - Exposes exactly two write-tools: add_calendar_event, add_note
   - NEVER executes a write without explicit confirmation from
     the UI (two-step: /chat returns a pendingAction, the user
     confirms in the HUD, then /confirm executes it)

   Requirements: Node 18+, Ollama running with a tool-capable
   model (qwen3.5 supports tools).

   Run:  node jarvis-server.mjs
   Env:  JARVIS_MODEL=qwen3.5:9b  CALENDAR_NAME="Hjem"  PORT=7077
   ============================================================ */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";

const PORT = Number(process.env.PORT || 7077);
const HOST = "127.0.0.1"; // localhost ONLY — never 0.0.0.0
const OLLAMA = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
let MODEL = process.env.JARVIS_MODEL || "qwen3.5:9b"; // mutable — hot-swappable via POST /model
// Calendar to write events into. Leave empty to auto-pick the first
// writable calendar (avoids read-only subscribed ones like Birthdays,
// and works regardless of how macOS localizes default calendar names).
const CALENDAR_NAME = process.env.CALENDAR_NAME || "";

// Optional: set TAVILY_API_KEY env var for much better web search results.
// Free tier at https://tavily.com — 1 000 searches/month, no credit card needed.
// Without it, search falls back to DuckDuckGo + Wikipedia (still works, narrower coverage).
const TAVILY_KEY = process.env.TAVILY_API_KEY || "";

// Inference settings applied to every Ollama call.
// think: true  — enables qwen3's silent chain-of-thought reasoning on final answers
// temperature  — lower = more focused, less hallucination
// num_ctx      — context window; covers ~6 k words of conversation history
// repeat_penalty — discourages rambling repetition
const MODEL_OPTIONS = { temperature: 0.35, num_ctx: 8192, repeat_penalty: 1.1 };
const modelSupportsThinking = () => MODEL.startsWith("qwen3");

const PERSONA =
  "You are JARVIS, a calm, dryly witty AI butler. Answer concisely (1-3 sentences). " +
  "Address the user as 'sir' occasionally. " +
  "Today's date is " + new Date().toDateString() + ". " +
  "You have eight tools: open_app, add_calendar_event, add_note, get_notes, get_calendar, get_weather, web_search, and get_news. " +
  "When the user asks to open, launch, or start any application — call open_app immediately with the exact macOS app name. " +
  "When the user asks to see, show, find, read, or retrieve notes — call get_notes immediately. Do not ask what keyword to use first. " +
  "When the user asks about their schedule, agenda, calendar, upcoming events, or what they have planned — call get_calendar immediately. " +
  "When the user asks about the weather, temperature, forecast, or conditions — call get_weather immediately with the relevant location. " +
  "When the user asks about the news, headlines, or what's happening in the world — call get_news immediately. " +
  "When the user asks you to look something up, search for information, or research a topic — call web_search immediately. " +
  "Use add_calendar_event or add_note only when explicitly asked to create one. " +
  "For all other requests — questions, conversation, advice, status — just answer directly. " +
  "NEVER mention your tools, their absence, or your limitations in a response. " +
  "When creating events, resolve relative dates (tomorrow, Thursday) to concrete dates. " +
  "When the user asks you to add a task, add something to their to-do list, or remember to do something, " +
  "include one or more [TASK:title:priority] tags in your reply — one per task. Priority must be high, medium, or low. " +
  "Assign priority yourself if the user does not specify. " +
  "Example: 'Added to your task list, sir. [TASK:Fix login bug:high]' " +
  "Example for multiple: 'Here are your tasks, sir. [TASK:Improve UI:medium][TASK:Write tests:low]' " +
  "Only include [TASK:...] tags when explicitly asked to add a task or to-do item. " +
  "The user's current task list is provided in context when it exists. To mark a task done emit [TASK_DONE:title], " +
  "to delete one emit [TASK_REMOVE:title] — use the exact title from the list. " +
  "Example: 'Marked as complete, sir. [TASK_DONE:Fix login bug]'";

/* ---------- Tool definitions (what the model is allowed to do) ---------- */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "open_app",
      description: "Open an application on macOS. Call this when the user asks to open, launch, or start any app.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "The exact macOS application name, e.g. 'Spotify', 'Firefox', 'Safari', 'Terminal'" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_calendar_event",
      description: "Create an event in the user's macOS Calendar app.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Event title" },
          startISO: { type: "string", description: "Start datetime in ISO 8601, e.g. 2026-06-11T14:00:00" },
          durationMinutes: { type: "number", description: "Duration in minutes, default 60" },
        },
        required: ["title", "startISO"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_note",
      description: "Create a new note in the user's macOS Notes app.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Note title" },
          body: { type: "string", description: "Note content" },
        },
        required: ["title", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_notes",
      description: "Read notes from the user's macOS Notes app. Call with no arguments to list the 5 most recent notes. Pass query to search by keyword. Always call this tool immediately when the user asks to see, find, read, or retrieve notes — do not ask for clarification first.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Optional keyword to filter notes by title or content." },
          limit: { type: "number", description: "Max number of notes to return, default 5." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_calendar",
      description: "Read upcoming events from the user's macOS Calendar. Call immediately when the user asks about their schedule, agenda, upcoming events, or what they have planned.",
      parameters: {
        type: "object",
        properties: {
          days: { type: "number", description: "How many days ahead to look. Default 7." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather and forecast for a location. Call immediately when the user asks about weather, temperature, or conditions.",
      parameters: {
        type: "object",
        properties: {
          location: { type: "string", description: "City or location name. Use 'Copenhagen' if no location is specified." },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web for information on any topic. Call immediately when the user asks you to look something up, research a topic, or asks a factual question you may not know.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news",
      description: "Get the latest news headlines. Call immediately when the user asks about news, headlines, or what's happening in the world.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Optional topic to filter news by, e.g. 'technology', 'sports', 'business'. Leave empty for top headlines." },
          limit: { type: "number", description: "Number of headlines to return. Default 6." },
        },
        required: [],
      },
    },
  },
];

/* ---------- AppleScript executors (the ONLY things that touch macOS) ---- */

// Strip characters that could break out of AppleScript string literals
const sanitize = (s = "") => String(s).replace(/[\\"]/g, "").slice(0, 2000);

function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

/* ---------- Generic app-category resolution ----------
   "open my email" should open the user's mail client, not fail looking for
   an app literally named "my email". Categories with a `scheme` are resolved
   through LaunchServices so the user's actual default app is used; an env
   override (e.g. JARVIS_EMAIL_APP="Microsoft Outlook") always wins. */
const APP_ALIASES = {
  email:    { scheme: "mailto", fallback: "Mail",            env: "JARVIS_EMAIL_APP" },
  mail:     { scheme: "mailto", fallback: "Mail",            env: "JARVIS_EMAIL_APP" },
  inbox:    { scheme: "mailto", fallback: "Mail",            env: "JARVIS_EMAIL_APP" },
  browser:  { scheme: "http",   fallback: "Safari",          env: "JARVIS_BROWSER_APP" },
  web:      { scheme: "http",   fallback: "Safari",          env: "JARVIS_BROWSER_APP" },
  internet: { scheme: "http",   fallback: "Safari",          env: "JARVIS_BROWSER_APP" },
  music:    {                   fallback: "Music",           env: "JARVIS_MUSIC_APP" },
  calendar: {                   fallback: "Calendar" },
  messages: {                   fallback: "Messages" },
  texts:    {                   fallback: "Messages" },
  notes:    {                   fallback: "Notes" },
  photos:   {                   fallback: "Photos" },
  files:    {                   fallback: "Finder" },
  finder:   {                   fallback: "Finder" },
  settings: {                   fallback: "System Settings" },
  preferences: {                fallback: "System Settings" },
  terminal: {                   fallback: "Terminal",        env: "JARVIS_TERMINAL_APP" },
  calculator: {                 fallback: "Calculator" },
};

// Ask LaunchServices which bundle handles a URL scheme (mailto/http).
function lsDefaultBundle(scheme) {
  return new Promise((resolve) => {
    execFile("defaults",
      ["read", "com.apple.LaunchServices/com.apple.launchservices.secure", "LSHandlers"],
      { timeout: 5000 }, (err, out) => {
        if (err || !out) return resolve(null);
        const block = out.split(/\}\s*,?/)
          .find(b => new RegExp(`LSHandlerURLScheme\\s*=\\s*"?${scheme}"?;`).test(b));
        const m = block && block.match(/LSHandlerRoleAll\s*=\s*"?([A-Za-z0-9.-]+)"?;/);
        resolve(m ? m[1] : null);
      });
  });
}

// Spotlight fuzzy match: "photoshop" → /Applications/Adobe Photoshop 2025.app
function fuzzyFindApp(query) {
  const q = query.replace(/["\\]/g, "");
  return new Promise((resolve) => {
    execFile("mdfind",
      [`kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == "*${q}*"cd`],
      { timeout: 5000 }, (err, out) => {
        if (err || !out.trim()) return resolve(null);
        const apps = out.trim().split("\n").filter(p =>
          /^\/(System\/)?Applications\//.test(p) || p.startsWith(path.join(os.homedir(), "Applications") + "/"));
        if (!apps.length) return resolve(null);
        apps.sort((a, b) => a.length - b.length); // shortest path ≈ closest match
        resolve(apps[0]);
      });
  });
}

// Bundle id → .app path, so replies can name the real app ("Microsoft Outlook").
function appPathForBundle(bundleId) {
  return new Promise((resolve) => {
    execFile("mdfind", [`kMDItemCFBundleIdentifier == "${bundleId.replace(/["\\]/g, "")}"c`],
      { timeout: 5000 }, (err, out) => {
        resolve(!err && out.trim() ? out.trim().split("\n")[0] : null);
      });
  });
}

// Resolve what the user said into concrete `open` arguments.
async function resolveAppTarget(raw) {
  const key = raw.toLowerCase()
    .replace(/^(my|our|the)\s+/, "")
    .replace(/\s+app(lication)?$/, "")
    .trim();
  const alias = APP_ALIASES[key];
  if (!alias) return { args: ["-a", raw], label: raw };
  if (alias.env && process.env[alias.env]) {
    return { args: ["-a", process.env[alias.env]], label: process.env[alias.env] };
  }
  if (alias.scheme) {
    const bundle = await lsDefaultBundle(alias.scheme);
    if (bundle) {
      const appPath = await appPathForBundle(bundle);
      const label = appPath ? path.basename(appPath, ".app") : alias.fallback;
      return { args: ["-b", bundle], label };
    }
  }
  return { args: ["-a", alias.fallback], label: alias.fallback };
}

function openWith(args, label) {
  return new Promise((resolve, reject) => {
    execFile("open", args, { timeout: 10000 }, (err, _, stderr) => {
      if (err) reject(new Error(`Could not open ${label}: ${stderr || err.message}`));
      else resolve(`Opened ${label}`);
    });
  });
}

async function execOpenApp({ name }) {
  const appName = sanitize(name);
  const { args, label } = await resolveAppTarget(appName);
  try {
    return await openWith(args, label);
  } catch (firstErr) {
    // Exact name failed — try a Spotlight fuzzy match before giving up.
    const found = await fuzzyFindApp(appName);
    if (!found) throw firstErr;
    const niceName = path.basename(found, ".app");
    console.log(`[open_app] fuzzy match: "${appName}" → "${niceName}"`);
    return openWith([found], niceName);
  }
}

async function execAddCalendarEvent({ title, startISO, durationMinutes = 60 }) {
  const d = new Date(startISO);
  if (isNaN(d)) throw new Error("Invalid start date");
  const t = sanitize(title);
  // Build the date from components — avoids locale parsing issues
  const script = `
    set startDate to current date
    set year of startDate to ${d.getFullYear()}
    set month of startDate to ${d.getMonth() + 1}
    set day of startDate to ${d.getDate()}
    set hours of startDate to ${d.getHours()}
    set minutes of startDate to ${d.getMinutes()}
    set seconds of startDate to 0
    set endDate to startDate + (${Math.round(durationMinutes)} * minutes)
    tell application "Calendar"
      ${CALENDAR_NAME
        ? `set targetCal to calendar "${sanitize(CALENDAR_NAME)}"`
        : `set targetCal to first calendar whose writable is true`}
      tell targetCal
        make new event with properties {summary:"${t}", start date:startDate, end date:endDate}
      end tell
    end tell`;
  await runAppleScript(script);
  return `Event "${t}" created for ${d.toLocaleString()}`;
}

async function execAddNote({ title, body }) {
  const t = sanitize(title);
  const b = sanitize(body).replace(/\n/g, "<br>");
  const script = `tell application "Notes" to make new note with properties {name:"${t}", body:"<div><h1>${t}</h1><p>${b}</p></div>"}`;
  await runAppleScript(script);
  return `Note "${t}" created`;
}

async function execGetNotes({ query = "", limit = 5 }) {
  const q = sanitize(query);
  const n = Math.min(Math.max(1, Math.round(limit)), 20);
  const script = q
    ? `
      tell application "Notes"
        set output to ""
        set found to 0
        repeat with n in notes
          if found >= ${n} then exit repeat
          set t to name of n
          set b to plaintext of n
          if t contains "${q}" or b contains "${q}" then
            set preview to b
            if length of preview > 400 then set preview to (text 1 thru 400 of preview) & "..."
            set output to output & "## " & t & return & preview & return & return
            set found to found + 1
          end if
        end repeat
        if found = 0 then return "No notes found matching: ${q}"
        return output
      end tell`
    : `
      tell application "Notes"
        set output to ""
        set found to 0
        repeat with n in notes
          if found >= ${n} then exit repeat
          set t to name of n
          set b to plaintext of n
          set preview to b
          if length of preview > 400 then set preview to (text 1 thru 400 of preview) & "..."
          set output to output & "## " & t & return & preview & return & return
          set found to found + 1
        end repeat
        return output
      end tell`;
  const result = await runAppleScript(script);
  return result || "No notes found.";
}

async function execGetCalendar({ days = 7 }) {
  const n = Math.min(Math.max(1, Math.round(days)), 60);
  const script = `
    tell application "Calendar"
      set output to ""
      set startDate to current date
      set endDate to startDate + (${n} * days)
      repeat with c in calendars
        try
          repeat with e in (every event of c whose start date ≥ startDate and start date ≤ endDate)
            set output to output & (summary of e) & " | " & (start date of e as string) & return
          end repeat
        end try
      end repeat
      if output is "" then return "No events in the next ${n} days."
      return output
    end tell`;
  return await runAppleScript(script);
}

async function execGetWeather({ location = "Copenhagen" }) {
  const loc = encodeURIComponent(sanitize(location));
  const r = await fetch(`https://wttr.in/${loc}?format=%l:+%C+%t+%h+humidity,+wind+%w&lang=en`, {
    headers: { "User-Agent": "JARVIS/1.0" },
  });
  if (!r.ok) throw new Error(`Weather service returned ${r.status}`);
  return (await r.text()).trim();
}

async function execWebSearch({ query }) {
  const q = sanitize(query);

  // ── Tier 1: Tavily (real web results, AI-optimised) ──────────────────────
  // Set TAVILY_API_KEY env var to activate. Free tier: 1 000 searches/month.
  // https://tavily.com — no credit card required for the free plan.
  if (TAVILY_KEY) {
    try {
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: TAVILY_KEY,
          query: q,
          search_depth: "basic",
          include_answer: true,
          max_results: 5,
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const lines = [];
        if (d.answer) lines.push(`Answer: ${d.answer}`);
        if (d.results?.length) {
          lines.push("Sources:");
          for (const res of d.results.slice(0, 4)) {
            const snippet = (res.content || "").slice(0, 200).replace(/\n/g, " ");
            lines.push(`• ${res.title} — ${snippet}${snippet.length === 200 ? "…" : ""}`);
          }
        }
        if (lines.length) return `Search results for "${q}":\n\n` + lines.join("\n");
      }
    } catch (e) {
      console.warn("[tavily] error, falling back:", e.message);
    }
  }

  // ── Tier 2: DuckDuckGo instant answers ───────────────────────────────────
  // Fast, but only covers a narrow set of well-defined queries.
  try {
    const r = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`, {
      headers: { "User-Agent": "JARVIS/1.0" },
    });
    if (r.ok) {
      const d = await r.json();
      const lines = [];
      if (d.Answer) lines.push(`Answer: ${d.Answer}`);
      if (d.AbstractText) lines.push(`Summary: ${d.AbstractText}`);
      if (d.AbstractSource) lines.push(`Source: ${d.AbstractSource} (${d.AbstractURL})`);
      const topics = (d.RelatedTopics || []).filter(t => t.Text).slice(0, 4).map(t => `• ${t.Text}`);
      if (topics.length) lines.push("Related:\n" + topics.join("\n"));
      if (lines.length) return lines.join("\n\n");
    }
  } catch { /* fall through */ }

  // ── Tier 3: Wikipedia ────────────────────────────────────────────────────
  // Good factual coverage; misses current events and proprietary content.
  const sr = await fetch(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=3&format=json`,
    { headers: { "User-Agent": "JARVIS/1.0" } }
  );
  if (!sr.ok) throw new Error(`Search service returned ${sr.status}`);
  const hits = (await sr.json())?.query?.search || [];
  if (!hits.length) return `No results found for: ${query}`;

  const strip = (s = "") => s.replace(/<[^>]+>/g, "");
  const lines = [];
  try {
    const pr = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hits[0].title)}`, {
      headers: { "User-Agent": "JARVIS/1.0" },
    });
    if (pr.ok) {
      const p = await pr.json();
      if (p.extract) lines.push(`${p.title}: ${p.extract}`);
    }
  } catch {}
  for (const h of hits.slice(lines.length ? 1 : 0)) {
    lines.push(`• ${h.title} — ${strip(h.snippet)}`);
  }
  return `Search results for "${query}" (Wikipedia):\n\n` + lines.join("\n");
}

/* News RSS feeds — topic → BBC RSS URL */
const NEWS_FEEDS = {
  technology: "https://feeds.bbci.co.uk/news/technology/rss.xml",
  business:   "https://feeds.bbci.co.uk/news/business/rss.xml",
  sports:     "https://feeds.bbci.co.uk/news/sport/rss.xml",
  science:    "https://feeds.bbci.co.uk/news/science_and_environment/rss.xml",
  world:      "https://feeds.bbci.co.uk/news/world/rss.xml",
  default:    "https://feeds.bbci.co.uk/news/rss.xml",
};

function parseRssItems(xml, limit) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null && items.length < limit) {
    const get = (tag) => {
      const t = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, "i").exec(m[1]);
      return t ? t[1].trim() : "";
    };
    const title = get("title");
    const desc  = get("description").replace(/<[^>]+>/g, "").slice(0, 120);
    if (title) items.push(desc ? `• ${title} — ${desc}` : `• ${title}`);
  }
  return items;
}

async function execGetNews({ topic = "", limit = 6 }) {
  const key = Object.keys(NEWS_FEEDS).find(k => topic.toLowerCase().includes(k)) || "default";
  const url = NEWS_FEEDS[key];
  const r = await fetch(url, { headers: { "User-Agent": "JARVIS/1.0" } });
  if (!r.ok) throw new Error(`News feed returned ${r.status}`);
  const xml = await r.text();
  const items = parseRssItems(xml, Math.min(Math.max(1, Math.round(limit)), 10));
  return items.length
    ? `Latest ${key === "default" ? "headlines" : key + " news"} (BBC):\n` + items.join("\n")
    : "No headlines found.";
}

const EXECUTORS = {
  open_app: execOpenApp,
  add_calendar_event: execAddCalendarEvent,
  add_note: execAddNote,
  get_notes: execGetNotes,
  get_calendar: execGetCalendar,
  get_weather: execGetWeather,
  web_search: execWebSearch,
  get_news: execGetNews,
};

function describeAction(name, args) {
  if (name === "add_calendar_event") {
    const when = new Date(args.startISO);
    return `Add calendar event "${args.title}" — ${isNaN(when) ? args.startISO : when.toLocaleString()} (${args.durationMinutes || 60} min)`;
  }
  if (name === "add_note") return `Create note "${args.title}"`;
  if (name === "get_notes") return args.query ? `Retrieve notes matching "${args.query}"` : "Retrieve recent notes";
  return `${name}(${JSON.stringify(args)})`;
}

/* ---------- Pending confirmations (write-gate) ---------- */
const pending = new Map(); // id -> { toolCall, messages }
let nextId = 1;

/* ---------- Ollama chat ---------- */
async function ollamaChat(messages, withTools = true) {
  // Disable thinking during tool-calling: the model must emit structured JSON for
  // tool calls, and chain-of-thought reasoning can corrupt that output format.
  // Enable it on final-answer calls (withTools=false) where free-form text is fine.
  const think = !withTools && modelSupportsThinking();
  const r = await fetch(`${OLLAMA}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      think,
      options: MODEL_OPTIONS,
      messages: [{ role: "system", content: PERSONA }, ...messages],
      ...(withTools ? { tools: TOOLS } : {}),
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const data = await r.json();
  return data.message;
}

/* ---------- Wake-word handling ---------- */

// Whisper frequently mishears "Jarvis" — accept common phonetic variants at
// the start of an utterance, with an optional "hey"/"ok" prefix.
const WAKE_RE = /^(?:(?:hey|okay|ok|yo)[,\s]+)?(?:jarvis(?:['’]?s)?|jarviss|jarvys|jarvas|jarvus|jarviz|jarbis|jervis|javis|charvis|garvis|harvis|gervais|java['’]?s|jar\s+vis)\b[,!.:;\s]*/i;

// Remove the wake word for intent matching. If the utterance is ONLY the
// wake word, keep it so the model can respond ("Yes, sir?").
function stripWake(text = "") {
  const s = text.replace(WAKE_RE, "");
  return s.trim() ? s : text;
}

// Canonicalize a misheard wake word in a transcript: "Java's please open X"
// → "Jarvis, please open X". Used on /transcribe output so the UI displays
// (and the model receives) the corrected text.
function normalizeWake(text = "") {
  if (!WAKE_RE.test(text)) return text;
  return text.replace(WAKE_RE, "Jarvis, ").trim().replace(/^Jarvis,$/, "Jarvis?");
}

// Bias whisper decoding toward the wake word by priming it with fake prior
// transcript that uses the name.
const WHISPER_PROMPT = "Jarvis, what's the weather? Jarvis, please open Safari. Jarvis, add a task.";

/* ---------- App-open intent (bypasses the model's tool decision) ---------- */

function wantsOpenApp(text = "") {
  return /\b(open|launch|start|run)\b.+/i.test(text);
}

function extractAppName(text = "") {
  const m = text.match(/\b(?:open|launch|start|run)\s+(?:up\s+)?(?:the\s+)?([A-Za-z0-9.+ -]{2,40}?)(?:\s+(?:app|application|browser|for me|please|now|sir))*\s*[.,!?]?$/i);
  return m ? m[1].trim() : null;
}

/* ---------- Note-retrieval intent (bypasses the model's tool decision) ---- */

// Does the user clearly want to read existing notes?
function wantsNotes(text = "") {
  const t = text.toLowerCase();
  // Must reference notes AND a read-style verb; excludes "add/create a note".
  if (!/\bnotes?\b/.test(t)) return false;
  if (/\b(add|create|make|write|new)\b.*\bnote/.test(t)) return false;
  return /\b(show|see|find|read|get|retrieve|list|open|look|view|what|which|any|my)\b/.test(t);
}

// Pull a search keyword out of phrases like "the note about X" / "my X note".
function extractQuery(text = "") {
  const about = text.match(/notes?\s+(?:about|on|regarding|for|with|containing|that\s+(?:mentions|says|has))\s+(.+)/i);
  if (about) return about[1].replace(/[?.!]+$/, "").trim().slice(0, 60);
  const my = text.match(/\bmy\s+(.+?)\s+notes?\b/i);
  if (my) return my[1].replace(/[?.!]+$/, "").trim().slice(0, 60);
  return ""; // no keyword → list recent notes
}

// Run a read tool, then let the model phrase a reply around the results.
async function readToolReply(res, messages, toolName, args, fallbackLabel) {
  try {
    const result = await EXECUTORS[toolName](args);
    const follow = await ollamaChat(
      [...messages, { role: "tool", content: result }],
      false
    );
    return json(res, 200, { reply: follow.content?.trim() || result });
  } catch (e) {
    return json(res, 200, { reply: `I was unable to retrieve the ${fallbackLabel}, sir: ${e.message}` });
  }
}

// Run get_notes, then let the model phrase a reply around the results.
async function notesReply(res, messages, args) {
  return readToolReply(res, messages, "get_notes", args, "notes");
}

/* ---------- Calendar intent helpers ---------- */

function wantsCalendar(text = "") {
  const t = text.toLowerCase();
  return /\b(schedule|agenda|calendar|upcoming|events?|appointments?|meetings?|what.*(have|do i have|on|planned)|what'?s (on|happening)|today|tomorrow|this week|next week)\b/.test(t)
    && !/\b(add|create|make|schedule a|new event)\b/.test(t);
}

function extractCalendarDays(text = "") {
  if (/\btoday\b/i.test(text)) return 1;
  if (/\btomorrow\b/i.test(text)) return 2;
  if (/\bthis week\b/i.test(text)) return 7;
  if (/\bnext week\b/i.test(text)) return 14;
  if (/\bthis month\b/i.test(text)) return 30;
  const m = text.match(/\bnext\s+(\d+)\s+days?\b/i);
  if (m) return parseInt(m[1], 10);
  return 7;
}

/* ---------- Weather intent helpers ---------- */

function wantsWeather(text = "") {
  return /\b(weather|forecast|temperature|temp|rain|sunny|cloudy|wind|humidity|conditions?|hot|cold|warm|degrees?|°)\b/i.test(text);
}

function extractWeatherLocation(text = "") {
  const m = text.match(/\bin\s+([A-Za-z\s]{2,30}?)(?:\s*[?.,!]|$)/i);
  if (m) return m[1].trim();
  const m2 = text.match(/weather\s+(?:for|at|of)\s+([A-Za-z\s]{2,30}?)(?:\s*[?.,!]|$)/i);
  if (m2) return m2[1].trim();
  return "Copenhagen";
}

/* ---------- News intent helpers ---------- */

function wantsNews(text = "") {
  return /\b(news|headlines?|what'?s happening|what is happening|current events?|latest|top stories|breaking)\b/i.test(text);
}

function extractNewsTopic(text = "") {
  const topics = ["technology", "tech", "business", "sport", "science", "world"];
  const t = text.toLowerCase();
  return topics.find(k => t.includes(k)) || "";
}

/* ---------- Web search intent helpers ---------- */

function wantsSearch(text = "") {
  return /\b(look up|look it up|search (for|the web)?|research|find (me|out|the)|what (is|was|are|were)|who (is|was|won|invented|wrote|discovered)|when (is|was|did)|where (is|was)|how (many|much|old|tall|far|long)|tell me about|google)\b/i.test(text);
}

function extractSearchQuery(text = "") {
  const m = text.match(/(?:look up|search for|search|research|find out about|find (?:me|us)?|tell me about|google)\s+(.+)/i);
  if (m) return m[1].replace(/[?.!]+$/, "").trim();
  const m2 = text.match(/(?:what|who|where|when|why|how)\s+(?:is|are|was|were|does|did|do|won|many|much)\s+(.+)/i);
  if (m2) return text.replace(/[?.!]+$/, "").trim();
  return text.trim();
}

/* ---------- Task intent helpers ---------- */

function wantsTask(text = "") {
  return /\b(add (a |an |this )?task|create (a |an |this )?task|add (to |it to )?(my )?(to.?do|task list)|new task|put .* (on|in) (my )?(to.?do|task)|remind me to|remember to (do )?)\b/i.test(text);
}

function extractTaskInfo(text = "") {
  // Strip the intent prefix to get the raw task title
  let title = text
    .replace(/^add (a |an |this )?task[s]?[,:\s-]+/i, "")
    .replace(/^create (a |an |this )?task[,:\s-]+/i, "")
    .replace(/^new task[,:\s-]+/i, "")
    .replace(/^add (to |it to )?(my )?(to.?do|task list)[,:\s-]+/i, "")
    .replace(/^remind me to\s+/i, "")
    .replace(/^remember to (do\s+)?/i, "")
    .trim();

  // Detect explicit priority keyword
  let priority = "medium";
  if (/\b(high|urgent|important|critical)\b/i.test(title)) priority = "high";
  if (/\b(low|minor|whenever|someday)\b/i.test(title)) priority = "low";

  // Strip trailing priority phrase from the title so it reads cleanly
  title = title
    .replace(/[,.]?\s*(high|low|medium|urgent|important|critical|minor)\s+priority\b/i, "")
    .replace(/[,.]?\s*priority[:\s]+(high|low|medium|urgent|important|critical|minor)\b/i, "")
    .replace(/[,.]?\s*\((high|low|medium)\)\s*$/i, "")
    .trim();

  return { title: title || text.trim(), priority };
}

/* ---------- Local STT via whisper-cpp ---------- */
const WHISPER_MODEL_PATHS = [
  process.env.WHISPER_MODEL,
  path.join(os.homedir(), ".cache/whisper/ggml-base.en.bin"),
  "/opt/homebrew/share/whisper-cpp/models/ggml-base.en.bin",
  "/usr/local/share/whisper-cpp/models/ggml-base.en.bin",
].filter(Boolean);

function findWhisperModel() {
  return WHISPER_MODEL_PATHS.find(p => { try { fs.accessSync(p); return true; } catch { return false; } }) || null;
}

const readRawBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

const run = (bin, args, opts = {}) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { timeout: 60000, ...opts }, (err, stdout) => err ? reject(err) : resolve(stdout))
  );

/* whisper-server: keeps the model in RAM so transcription is fast after the first call */
const WHISPER_PORT = Number(process.env.WHISPER_PORT || 8765);
const WHISPER_SERVER_URL = `http://127.0.0.1:${WHISPER_PORT}`;
let whisperReady = false;

(function startWhisperServer() {
  const model = findWhisperModel();
  if (!model) { console.warn("[whisper] model not found — transcription unavailable"); return; }
  const proc = spawn(
    "whisper-server",
    ["-m", model, "--port", String(WHISPER_PORT), "--host", "127.0.0.1", "--convert"],
    { stdio: "inherit" }
  );
  proc.on("error", e => console.warn("[whisper-server] failed to start:", e.message));
  proc.on("exit", () => { whisperReady = false; });
  process.on("exit", () => proc.kill());
  // Give it 3s to load the model then mark ready
  setTimeout(() => { whisperReady = true; console.log("[whisper-server] ready"); }, 3000);
})();

/* ---------- HTTP server ---------- */
const json = (res, code, obj) => {
  res.writeHead(code, {
    "Content-Type": "application/json",
    // CORS: the UI runs on a different localhost port (e.g. Vite :5173)
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-audio-format",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(JSON.stringify(obj));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); } catch { resolve({}); }
    });
  });

http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});

  try {
    /* Health: lets the UI verify server + Ollama + model in one probe */
    if (req.method === "GET" && req.url === "/health") {
      const r = await fetch(`${OLLAMA}/api/tags`);
      const tags = await r.json();
      const hasModel = (tags.models || []).some((m) => m.name.startsWith(MODEL));
      return json(res, 200, { ok: hasModel, model: MODEL, tools: Object.keys(EXECUTORS) });
    }

    /* Model: read or hot-swap the active Ollama model — no restart needed.
       Ollama loads the new model on the next chat (a few seconds the first time). */
    if (req.method === "GET" && req.url === "/model") {
      return json(res, 200, { model: MODEL });
    }
    if (req.method === "POST" && req.url === "/model") {
      const { model } = await readBody(req);
      if (!model || typeof model !== "string") {
        return json(res, 400, { ok: false, error: "model name required" });
      }
      // Only switch to a model that's actually pulled
      const tagsRes = await fetch(`${OLLAMA}/api/tags`);
      const tags = await tagsRes.json();
      const pulled = (tags.models || []).some((m) => m.name.startsWith(model));
      if (!pulled) return json(res, 404, { ok: false, error: `model ${model} not pulled` });
      MODEL = model;
      console.log(`[model] switched to ${MODEL}`);
      return json(res, 200, { ok: true, model: MODEL });
    }

    /* Chat: returns either { reply } or { pendingAction } */
    if (req.method === "POST" && req.url === "/chat") {
      const { messages = [] } = await readBody(req);

      // Intent shortcut: small models are unreliable at deciding to call a
      // read tool, so detect the "show me my notes" intent ourselves and run
      // get_notes directly — no dependence on the model's tool-calling.
      const rawLast = [...messages].reverse().find(m => m.role === "user")?.content || "";
      // The UI may prepend a memory-context block to the user message. Intent
      // regexes must only see the actual utterance — a memory that mentions
      // "weather" must not hijack a "open Outlook" command into get_weather.
      const utterance = rawLast.replace(/^JARVIS MEMORY:\n[\s\S]*?\n\n/, "");
      // Strip wake-word prefix (incl. Whisper mishearings like "Java's") so
      // intent patterns and extraction regexes work regardless of invocation.
      const last = stripWake(utterance).trim() || utterance;

      // Task intent: handle before anything else so the model never gets a chance
      // to misfire a tool call for something like "add task: set up API"
      if (wantsTask(last)) {
        const { title, priority } = extractTaskInfo(last);
        console.log(`[intent→add_task] "${title}" (${priority})`);
        return json(res, 200, { reply: `[TASK:${title}:${priority}]` });
      }

      if (wantsNotes(last)) {
        console.log(`[intent→get_notes]`, last);
        return notesReply(res, messages, { query: extractQuery(last) });
      }
      if (wantsCalendar(last)) {
        console.log(`[intent→get_calendar]`, last);
        return readToolReply(res, messages, "get_calendar", { days: extractCalendarDays(last) }, "calendar");
      }
      if (wantsWeather(last)) {
        console.log(`[intent→get_weather]`, last);
        return readToolReply(res, messages, "get_weather", { location: extractWeatherLocation(last) }, "weather");
      }
      if (wantsNews(last)) {
        console.log(`[intent→get_news]`, last);
        return readToolReply(res, messages, "get_news", { topic: extractNewsTopic(last) }, "news");
      }
      if (wantsSearch(last)) {
        console.log(`[intent→web_search]`, last);
        return readToolReply(res, messages, "web_search", { query: extractSearchQuery(last) }, "search results");
      }
      const appName = wantsOpenApp(last) ? extractAppName(last) : null;
      if (appName) {
        console.log(`[intent→open_app]`, appName);
        try {
          const result = await execOpenApp({ name: appName });
          const opened = result.replace(/^Opened /, ""); // resolved name, e.g. "Microsoft Outlook"
          return json(res, 200, { reply: `[OPEN:${opened}]` }); // silent — no prose
        } catch (e) {
          return json(res, 200, { reply: `I'm afraid I couldn't open ${appName}, sir. ${e.message}` });
        }
      }

      const msg = await ollamaChat(messages);

      if (msg.tool_calls?.length) {
        const tc = msg.tool_calls[0];
        const name = tc.function?.name;
        const args = tc.function?.arguments || {};
        if (!EXECUTORS[name]) return json(res, 200, { reply: "I'm afraid that action is not in my toolkit, sir." });

        // Small models sometimes reach for a personal-data tool to answer a
        // general question. If the user never mentioned notes/calendar,
        // reroute the question to web_search instead.
        if (
          (name === "get_notes" && !/\bnotes?\b/i.test(last)) ||
          (name === "get_calendar" && !/\b(calendar|schedule|agenda|events?|appointments?|meetings?)\b/i.test(last))
        ) {
          console.log(`[reroute ${name}→web_search]`, last);
          return readToolReply(res, messages, "web_search", { query: last }, "search results");
        }

        // Non-destructive tools execute immediately — no confirmation needed
        if (name === "get_notes") {
          console.log(`[read] ${name}`, args);
          return notesReply(res, messages, args);
        }
        if (name === "get_calendar") {
          console.log(`[read] ${name}`, args);
          return readToolReply(res, messages, "get_calendar", args, "calendar");
        }
        if (name === "get_weather") {
          console.log(`[read] ${name}`, args);
          return readToolReply(res, messages, "get_weather", args, "weather");
        }
        if (name === "web_search") {
          console.log(`[read] ${name}`, args);
          return readToolReply(res, messages, "web_search", args, "search results");
        }
        if (name === "get_news") {
          console.log(`[read] ${name}`, args);
          return readToolReply(res, messages, "get_news", args, "news");
        }
        if (name === "open_app") {
          console.log(`[open_app]`, args.name);
          try {
            await execOpenApp(args);
            return json(res, 200, { reply: `[OPEN:${args.name}]` }); // silent
          } catch (e) {
            return json(res, 200, { reply: `I'm afraid I couldn't open ${args.name}, sir. ${e.message}` });
          }
        }

        const id = String(nextId++);
        pending.set(id, { name, args, messages });
        console.log(`[pending #${id}]`, describeAction(name, args));
        return json(res, 200, {
          pendingAction: { id, tool: name, summary: describeAction(name, args) },
        });
      }
      const replyText = msg.content?.trim();

      // Detect when the model refuses to search ("I can't access the internet",
      // "I don't have real-time information", etc.) and do the search ourselves.
      const isRefusal = replyText && /\b(don'?t have (access|information|the ability)|unable to (search|browse|access|retrieve|look up)|can'?t (search|browse|access|look up|provide real.time)|no access to (the )?internet|not able to (search|browse|access)|I cannot (search|browse|access)|requires? (searching|browsing|accessing) the web|through this interface|real.?time (data|information)|my knowledge (is limited|cutoff|doesn'?t)|as of my (last|knowledge)|I'?m not connected)\b/i.test(replyText);

      const isQuestion = /\?|^(what|who|when|where|why|how|which|find|tell|is|are|was|were|did|does|can|could)\b/i.test(last);

      if ((!replyText || isRefusal) && isQuestion) {
        console.log(`[${isRefusal ? "refusal" : "empty reply"}→web_search]`, last);
        return readToolReply(res, messages, "web_search", { query: last }, "search results");
      }
      return json(res, 200, { reply: replyText || "I'm sorry sir, I didn't quite catch that. Could you rephrase?" });
    }

    /* Confirm: the user approved — NOW we execute */
    if (req.method === "POST" && req.url === "/confirm") {
      const { id } = await readBody(req);
      const p = pending.get(id);
      if (!p) return json(res, 404, { reply: "That request has expired, sir." });
      pending.delete(id);
      console.log(`[execute #${id}]`, describeAction(p.name, p.args));
      try {
        const result = await EXECUTORS[p.name](p.args);
        // Let the model phrase the confirmation naturally
        const follow = await ollamaChat(
          [...p.messages, { role: "assistant", content: `[Tool executed: ${result}]` },
           { role: "user", content: "Confirm to me briefly that it's done." }],
          false
        );
        return json(res, 200, { reply: follow.content?.trim() || result });
      } catch (e) {
        console.error(`[failed #${id}]`, e.message);
        return json(res, 200, { reply: `I'm afraid the action failed, sir: ${e.message}` });
      }
    }

    /* Cancel */
    if (req.method === "POST" && req.url === "/cancel") {
      const { id } = await readBody(req);
      pending.delete(id);
      return json(res, 200, { reply: "Understood, sir. Standing down." });
    }

    /* Transcribe: fast path via in-memory whisper-server, CLI fallback */
    if (req.method === "POST" && req.url === "/transcribe") {
      const audio = await readRawBody(req);
      const ext = req.headers["x-audio-format"] || "webm";

      if (whisperReady) {
        const fd = new FormData();
        fd.append("file", new Blob([audio], { type: `audio/${ext}` }), `audio.${ext}`);
        fd.append("response_format", "json");
        fd.append("prompt", WHISPER_PROMPT); // bias decoding toward "Jarvis"
        const r = await fetch(`${WHISPER_SERVER_URL}/inference`, { method: "POST", body: fd });
        if (!r.ok) throw new Error(`whisper-server ${r.status}: ${await r.text()}`);
        const raw = ((await r.json()).text || "").trim();
        const text = normalizeWake(raw);
        if (text !== raw) console.log(`[transcribe] wake-word fix: "${raw}" → "${text}"`);
        else console.log(`[transcribe] "${text}"`);
        return json(res, 200, { text });
      }

      // CLI fallback (slow — loads model each call)
      const tmp = path.join(os.tmpdir(), `jarvis_${Date.now()}`);
      const inFile = `${tmp}.${ext}`;
      const wavFile = `${tmp}.wav`;
      const txtFile = `${wavFile}.txt`;
      fs.writeFileSync(inFile, audio);
      try {
        await run("ffmpeg", ["-y", "-i", inFile, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavFile]);
        const model = findWhisperModel();
        if (!model) return json(res, 503, { error: "Whisper model not found." });
        await run("whisper-cli", ["-f", wavFile, "-m", model, "-np", "-nt", "-otxt", "--prompt", WHISPER_PROMPT]);
        const text = normalizeWake(fs.readFileSync(txtFile, "utf8")
          .replace(/\[BLANK_AUDIO\]/gi, "").replace(/\[[^\]]*\]/g, "").trim());
        console.log(`[transcribe] "${text}"`);
        return json(res, 200, { text });
      } finally {
        [inFile, wavFile, txtFile].forEach(f => { try { fs.unlinkSync(f); } catch {} });
      }
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    json(res, 500, { reply: "Internal fault in the tool server, sir." });
  }
}).listen(PORT, HOST, () => {
  console.log(`JARVIS tool server — http://${HOST}:${PORT}`);
  console.log(`Brain: ${OLLAMA} (${MODEL}) · Tools: ${Object.keys(EXECUTORS).join(", ")}`);
  console.log(`Write actions require confirmation from the UI. Logs appear here.`);
});
