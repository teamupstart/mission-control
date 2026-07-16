import { useEffect, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/drafts.ts";

/**
 * Imperative surface an ActionBar registers with the App so keyboard shortcuts
 * (send / focus / mode / kill / esc on the selected card) drive the exact same
 * compose, mode-cycle and confirm-kill flows as the on-card buttons - one source
 * of truth for both.
 */
export interface ActionBarHandle {
  startSend: () => void;
  focusPane: () => void;
  cycleMode: () => void;
  requestKill: () => void;
  cancel: () => void;
}

/**
 * Per-session controls: focus its pane, send a message into its prompt, reset its
 * checkout, or terminate it. "Send" reveals an inline input; "Reset" (only with a
 * working dir) opens an app-level confirm; "Kill" requires a second confirming
 * click so a stray click can't take down a session.
 */
export function ActionBar({
  session,
  expanded = false,
  registerActions,
  onReset,
}: {
  session: Session;
  /** When the card is expanded, the transcript panel owns the reply box, so we
   * hide this bar's Send button to avoid two send surfaces. */
  expanded?: boolean;
  registerActions?: (id: string, handle: ActionBarHandle | null) => void;
  /** Open the reset-to-origin confirm (app-level modal). Absent = no reset control. */
  onReset?: () => void;
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
      // Sent, so the draft is spent. On failure it stays: `run` has already put the
      // reason on screen next to the text it's about.
      clearDraft(session.id, "send");
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

  // Cycle the permission mode (Shift+Tab) - only meaningful for a Claude session
  // with a pane to inject the keystroke into; a no-op otherwise.
  function cycleMode() {
    if (!canSend || session.agent !== "claude") return;
    void run("mode", () => api.cycleMode(session.id));
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
  const latest = useRef({ startSend, focusPane, cycleMode, requestKill, cancel });
  latest.current = { startSend, focusPane, cycleMode, requestKill, cancel };
  useEffect(() => {
    if (!registerActions) return;
    const handle: ActionBarHandle = {
      startSend: () => latest.current.startSend(),
      focusPane: () => latest.current.focusPane(),
      cycleMode: () => latest.current.cycleMode(),
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
            // Cancel and Escape only close this box - they unmount the input, so
            // without these the text died with it and reopening Send showed a blank.
            // Neither gesture is a human deleting anything.
            defaultValue={readDraft(session.id, "send")}
            onChange={(e) => writeDraft(session.id, "send", e.currentTarget.value)}
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
          {!expanded && (
            <button
              className="btn"
              disabled={!canSend}
              title={canSend ? "Type into this session's prompt" : "No pane to send to"}
              onClick={startSend}
            >
              Send
            </button>
          )}
          <button className="btn" onClick={focusPane}>
            Focus
          </button>
          {session.cwd && onReset && (
            <button
              className="btn btn-reset"
              title="Reset checkout to origin's default branch and clear context (Ctrl+R)"
              onClick={onReset}
            >
              Reset
            </button>
          )}
          <span className="actions-spacer" />
          {confirmKill ? (
            <button
              className="btn btn-danger"
              onClick={() => void doKill()}
              title={
                session.tmux
                  ? `Terminates the agent and kills its tmux session "${session.tmux.session}" (all its windows and panes)`
                  : "Terminates the agent process"
              }
            >
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
