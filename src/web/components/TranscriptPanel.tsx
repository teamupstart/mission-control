import { useEffect, useRef, useState } from "react";
import type { AgentType, TranscriptMessage, TranscriptStreamMsg } from "@shared/types.ts";
import { api } from "../lib/api.ts";

const AGENT_LABEL: Record<AgentType, string> = { claude: "claude", codex: "codex" };

/**
 * The expanded card's live conversation. Opens a dedicated SSE stream to the
 * session's transcript (the server tails the JSONL file), renders the turns, and
 * offers an inline reply that types straight into the agent's prompt via the
 * existing send action. Closing the panel closes the stream, so the server stops
 * tailing.
 */
export function TranscriptPanel({
  sessionId,
  agent,
  canSend,
}: {
  sessionId: string;
  agent: AgentType;
  canSend: boolean;
}): React.JSX.Element {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "unavailable">("connecting");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    setMessages([]);
    setStatus("connecting");
    setNote("");
    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/transcript/stream`);
    es.onmessage = (ev) => {
      let msg: TranscriptStreamMsg;
      try {
        msg = JSON.parse(ev.data) as TranscriptStreamMsg;
      } catch {
        return;
      }
      if (msg.type === "init") {
        setMessages(msg.messages);
        setStatus("live");
      } else if (msg.type === "append") {
        setMessages((prev) => mergeById(prev, msg.messages));
      } else if (msg.type === "unavailable") {
        setStatus("unavailable");
        setNote(msg.reason);
      }
    };
    // EventSource auto-reconnects on transient errors; keep the last view.
    return () => es.close();
  }, [sessionId]);

  // Follow the tail only when the reader is already at the bottom.
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Deliberately don't grab focus when the panel opens. Focus mode is opened with
  // `e` and closed with `e`, and the grid's global keys (including that toggle)
  // stand down while a text field is focused - so auto-focusing the reply box
  // would swallow the collapse press. The reader stays on the grid; one click on
  // the (prominent, full-width) reply box drops in when it's time to respond.
  function onScroll(): void {
    const el = logRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }

  async function send(): Promise<void> {
    const text = inputRef.current?.value.trim();
    if (!text) return;
    setSending(true);
    const r = await api.sendText(sessionId, text);
    setSending(false);
    if (r.ok) {
      if (inputRef.current) inputRef.current.value = "";
    } else {
      setFlash(r.error ?? "send failed");
      setTimeout(() => setFlash(null), 3500);
    }
  }

  return (
    // Stop clicks inside the panel from re-selecting / collapsing the card.
    <div className="transcript" onClick={(e) => e.stopPropagation()}>
      <div className="transcript-log" ref={logRef} onScroll={onScroll}>
        {status === "unavailable" ? (
          <p className="transcript-empty">{note}</p>
        ) : messages.length === 0 ? (
          <p className="transcript-empty">{status === "connecting" ? "Loading…" : "No messages yet."}</p>
        ) : (
          messages.map((m) => <Turn key={m.id} m={m} agentLabel={AGENT_LABEL[agent]} />)
        )}
      </div>

      {status !== "unavailable" && (
        <div className="transcript-compose">
          <textarea
            ref={inputRef}
            className="transcript-input"
            placeholder={
              canSend
                ? "Reply to this session…  (Enter to send, Shift+Enter for newline)"
                : "No pane to send to"
            }
            rows={2}
            disabled={!canSend}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape") {
                // Blur back to the grid so card keyboard nav (e to collapse) works.
                e.currentTarget.blur();
              }
            }}
          />
          <button
            className="btn btn-send"
            disabled={!canSend || sending}
            onClick={() => void send()}
          >
            Send
          </button>
          {flash && <span className="action-flash">{flash}</span>}
        </div>
      )}
    </div>
  );
}

function Turn({ m, agentLabel }: { m: TranscriptMessage; agentLabel: string }): React.JSX.Element {
  return (
    <div className={`turn turn-${m.role}`}>
      <div className="turn-role">{m.role === "assistant" ? agentLabel : "you"}</div>
      {m.text && <div className="turn-text">{m.text}</div>}
      {m.tools.length > 0 && (
        <div className="turn-tools">
          {m.tools.map((t, i) => (
            // The chip stays the bare name - the card is a glance, not an audit. `t.input`
            // rides along for Foreman's reviewer and is deliberately not rendered here.
            <span key={`${t.name}-${i}`} className="tool-chip" title={t.input}>
              {t.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** Append only turns we haven't already shown (init and append can overlap). */
function mergeById(prev: TranscriptMessage[], next: TranscriptMessage[]): TranscriptMessage[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((m) => m.id));
  const add = next.filter((m) => !seen.has(m.id));
  return add.length ? [...prev, ...add] : prev;
}
