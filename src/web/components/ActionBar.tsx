import { useEffect, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";

/**
 * Imperative surface an ActionBar registers with the App so keyboard shortcuts
 * (s / f / k / esc on the selected card) drive the exact same compose and
 * confirm-kill flow as the on-card buttons - one source of truth for both.
 */
export interface ActionBarHandle {
  startSend: () => void;
  focusPane: () => void;
  requestKill: () => void;
  cancel: () => void;
}

/**
 * Per-session controls: focus its pane, send a message into its prompt, or
 * terminate it. "Send" reveals an inline input; "Kill" requires a second
 * confirming click so a stray click can't take down a session.
 */
export function ActionBar({
  session,
  registerActions,
}: {
  session: Session;
  registerActions?: (id: string, handle: ActionBarHandle | null) => void;
}): React.JSX.Element {
  const [composing, setComposing] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canSend = Boolean(session.tmux || session.wezterm);

  async function run(label: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setBusy(label);
    const r = await fn();
    setBusy(null);
    if (!r.ok) {
      setFlash(r.error ?? "failed");
      setTimeout(() => setFlash(null), 3500);
    }
    return r;
  }

  async function submitMessage() {
    const text = inputRef.current?.value.trim();
    if (!text) return;
    const r = await run("send", () => api.sendText(session.id, text));
    if (r.ok) {
      setComposing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function doKill() {
    await run("kill", () => api.kill(session.id));
    setConfirmKill(false);
  }

  function startSend() {
    if (!canSend) return;
    setConfirmKill(false);
    setComposing(true);
  }

  function focusPane() {
    void run("focus", () => api.focus(session.id));
  }

  // First press arms the confirm; a second press commits - mirrors the mouse flow.
  function requestKill() {
    if (confirmKill) void doKill();
    else {
      setComposing(false);
      setConfirmKill(true);
    }
  }

  function cancel() {
    setComposing(false);
    setConfirmKill(false);
  }

  // Register a stable handle that always calls the latest closures, so App can
  // drive this bar by keyboard without re-registering on every render.
  const latest = useRef({ startSend, focusPane, requestKill, cancel });
  latest.current = { startSend, focusPane, requestKill, cancel };
  useEffect(() => {
    if (!registerActions) return;
    const handle: ActionBarHandle = {
      startSend: () => latest.current.startSend(),
      focusPane: () => latest.current.focusPane(),
      requestKill: () => latest.current.requestKill(),
      cancel: () => latest.current.cancel(),
    };
    registerActions(session.id, handle);
    return () => registerActions(session.id, null);
  }, [session.id, registerActions]);

  return (
    <div className="actions">
      {composing ? (
        <div className="compose">
          <input
            ref={inputRef}
            className="compose-input"
            placeholder="Message to send…"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitMessage();
              if (e.key === "Escape") setComposing(false);
            }}
          />
          <button className="btn btn-send" disabled={busy === "send"} onClick={() => void submitMessage()}>
            Send
          </button>
          <button className="btn btn-ghost" onClick={() => setComposing(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <>
          <button
            className="btn"
            disabled={!canSend}
            title={canSend ? "Type into this session's prompt" : "No pane to send to"}
            onClick={startSend}
          >
            Send
          </button>
          <button className="btn" onClick={focusPane}>
            Focus
          </button>
          <span className="actions-spacer" />
          {confirmKill ? (
            <button className="btn btn-danger" onClick={() => void doKill()}>
              Confirm kill
            </button>
          ) : (
            <button className="btn btn-danger-ghost" onClick={() => setConfirmKill(true)}>
              Kill
            </button>
          )}
          {confirmKill && (
            <button className="btn btn-ghost" onClick={() => setConfirmKill(false)}>
              Cancel
            </button>
          )}
        </>
      )}
      {flash && <span className="action-flash">{flash}</span>}
    </div>
  );
}
