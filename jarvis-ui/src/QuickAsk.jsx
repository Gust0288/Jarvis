import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";

// Quick Ask overlay.

const SERVER_URL = "http://127.0.0.1:7077";
const mono = "'Share Tech Mono', monospace";
const display = "'Orbitron', sans-serif";
const CYAN = "#35D6F0";
const TEXT = "#D8F4FA";

// Inline markdown.
function renderInline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  if (parts.length === 1) return text;
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**"))
      return <strong key={i} style={{ color: TEXT, fontWeight: 700 }}>{p.slice(2, -2)}</strong>;
    if (p.startsWith("`") && p.endsWith("`"))
      return <code key={i} style={{
        background: CYAN + "1a", color: CYAN, padding: "1px 5px",
        borderRadius: 2, fontSize: "0.88em", fontFamily: mono,
      }}>{p.slice(1, -1)}</code>;
    return p;
  });
}

// Message renderer.
function MessageText({ text }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter(l => l.trim());
        if (!lines.length) return null;

        const isBullet = l => /^[•\-\*]\s/.test(l);
        const stripBullet = l => l.replace(/^[•\-\*]\s/, "");

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

// Log sync.
const LS_KEY = "jarvis-quick-log";

function appendToLog(entry) {
  try {
    const existing = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    existing.push(entry);
    localStorage.setItem(LS_KEY, JSON.stringify(existing));
  } catch {}
}

export default function QuickAsk() {
  const [input, setInput] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingAction, setPendingAction] = useState(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const historyRef = useRef([]);

  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  useLayoutEffect(() => {
    if (panelRef.current && window.electronAPI?.resizeQuickAsk) {
      window.electronAPI.resizeQuickAsk(Math.ceil(panelRef.current.getBoundingClientRect().height) + 2);
    }
  });

  useEffect(() => {
    inputRef.current?.focus();
    if (!window.electronAPI?.onQuickShown) return;
    return window.electronAPI.onQuickShown(() => {
      // Clear previous reply when overlay is summoned again
      setReply("");
      setError("");
      setPendingAction(null);
      setInput("");
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, []);

  const hide = useCallback(() => window.electronAPI?.hideQuickAsk?.(), []);

  const ask = useCallback(async (text) => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setError("");
    setReply("");
    setPendingAction(null);
    historyRef.current.push({ role: "user", content: q });
    try {
      const r = await fetch(`${SERVER_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: historyRef.current }),
      });
      const data = await r.json();
      if (data.pendingAction) {
        setPendingAction(data.pendingAction);
      } else {
        const answer = data.reply || "…";
        historyRef.current.push({ role: "assistant", content: answer });
        setReply(answer);

        // Write to localStorage buffer — App.jsx drains this on focus/mount
        const entry = { user: q, assistant: answer, ts: Date.now() };
        appendToLog(entry);
        // Also fire IPC as a fast path when the main window is already loaded
        window.electronAPI?.sendQuickExchange?.(entry);
      }
    } catch {
      setError("Tool server offline — run `node jarvis-server.mjs` (and `ollama serve`).");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const resolveAction = useCallback(async (approve) => {
    if (!pendingAction) return;
    setBusy(true);
    try {
      const r = await fetch(`${SERVER_URL}/${approve ? "confirm" : "cancel"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: pendingAction.id }),
      });
      const data = await r.json();
      const answer = data.reply || (approve ? "Done, sir." : "Cancelled.");
      const lastUser = [...historyRef.current].reverse().find(m => m.role === "user");
      historyRef.current.push({ role: "assistant", content: answer });
      setReply(answer);

      const entry = { user: lastUser?.content || "", assistant: answer, ts: Date.now() };
      appendToLog(entry);
      window.electronAPI?.sendQuickExchange?.(entry);
    } catch {
      setError("Tool server offline — run `node jarvis-server.mjs`.");
    } finally {
      setPendingAction(null);
      setBusy(false);
      inputRef.current?.focus();
    }
  }, [pendingAction]);

  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (pendingAction) resolveAction(false);
      else hide();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (pendingAction) {
        resolveAction(true);
      } else {
        ask(input);
        setInput("");
      }
    }
  };

  return (
    <div
      ref={panelRef}
      onKeyDown={onKeyDown}
      style={{
        fontFamily: mono,
        background: "rgba(3, 10, 18, 0.92)",
        border: "1px solid rgba(0, 229, 255, 0.35)",
        borderRadius: 12,
        boxShadow: "0 0 24px rgba(0, 229, 255, 0.18), inset 0 0 40px rgba(0, 229, 255, 0.04)",
        overflow: "hidden",
        WebkitAppRegion: "no-drag",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');
        @keyframes quickPulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
      `}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px" }}>
        <span
          style={{
            fontFamily: display,
            fontWeight: 900,
            fontSize: 17,
            letterSpacing: "0.2em",
            color: "#00E5FF",
            textShadow: "0 0 10px rgba(0,229,255,0.7)",
            animation: busy ? "quickPulse 1s ease-in-out infinite" : "none",
            userSelect: "none",
          }}
        >
          J
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "Processing…" : "Ask JARVIS anything…"}
          spellCheck={false}
          autoFocus
          style={{
            flex: 1,
            background: "transparent",
            border: "none",
            outline: "none",
            color: "#D7F4FF",
            fontFamily: mono,
            fontSize: 19,
            caretColor: "#00E5FF",
          }}
        />
        <span style={{ fontSize: 10, color: "rgba(0,229,255,0.4)", letterSpacing: "0.15em", userSelect: "none" }}>
          ESC
        </span>
      </div>
      {pendingAction && (
        <div
          style={{
            borderTop: "1px solid rgba(255, 184, 0, 0.3)",
            padding: "14px 20px",
            color: "#FFD37A",
            fontSize: 14,
            lineHeight: 1.5,
          }}
        >
          <div style={{ fontFamily: display, fontSize: 10, letterSpacing: "0.25em", marginBottom: 6, color: "#FFB800" }}>
            CONFIRM ACTION
          </div>
          {pendingAction.summary}
          <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
            <button onClick={() => resolveAction(true)} style={confirmBtn("#00E5FF")}>⏎ CONFIRM</button>
            <button onClick={() => resolveAction(false)} style={confirmBtn("#FF5470")}>ESC CANCEL</button>
          </div>
        </div>
      )}
      {(reply || error) && !pendingAction && (
        <div
          style={{
            borderTop: "1px solid rgba(0, 229, 255, 0.18)",
            padding: "14px 20px 16px",
            color: error ? "#FF8DA1" : "#BCE9F7",
            fontSize: 15,
            lineHeight: 1.55,
            maxHeight: 380,
            overflowY: "auto",
          }}
        >
          {error ? error : <MessageText text={reply} />}
        </div>
      )}
    </div>
  );
}

const confirmBtn = (color) => ({
  fontFamily: display,
  fontSize: 10,
  letterSpacing: "0.2em",
  padding: "6px 14px",
  background: "transparent",
  border: `1px solid ${color}`,
  borderRadius: 4,
  color,
  cursor: "pointer",
});
