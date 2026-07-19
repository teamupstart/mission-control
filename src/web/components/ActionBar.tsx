import { useEffect, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { api } from "../lib/api.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/drafts.ts";
import { formatChord, useKeybindings } from "../lib/keybindings.ts";

/**
 * Imperative surface an ActionBar registers with the App so keyboard shortcuts
 * (send / focus / queue / mode / kill / esc on the selected card) drive the exact
 * same compose, queue, mode-cycle and confirm-kill flows as the on-card buttons -
 * one source of truth for both.
 */
export interface ActionBarHandle {
  startSend: () => void;
  focusPane: () => void;
  toggleQueue: () => void;
  cycleMode: () => void;
  requestKill: () => void;
  cancel: () => void;
}

/**
 * Per-session controls: focus its pane, send a message into its prompt, show its
 * work queue, reset its checkout, or terminate it. "Send" puts a cursor in this
 * card's one compose box; "Queue" toggles the work-queue panel; "Reset" (only with
 * a working dir) opens an app-level confirm; "Kill" requires a second confirming
 * click so a stray click can't take down a session.
 */
export function ActionBar({
  session,
  hasReply = false,
  queueOpen = false,
  onToggleQueue,
  onFocusReply,
  registerActions,
  onReset,
  variant = "card",
  onDiff,
}: {
  session: Session;
  /**
   * Which control set to draw. "card" (default, unchanged) is the grid's full row -
   * Send / Focus / Queue / Reset / Kill. "foot" is the console's detail footer, which
   * matches the mockup: Focus / Diff / Reset / Kill, since Send is the conversation's own
   * reply box and Queue is a tab. The imperative HANDLE is identical either way, so every
   * keyboard shortcut still works in both - only the buttons drawn differ. */
  variant?: "card" | "foot";
  /** Open the diff viewer. Only drawn by the "foot" variant. */
  onDiff?: () => void;
  /**
   * Whether the card is currently carrying the transcript's reply box - the live
   * answer to "is there already a compose box here?", reported by the panel itself
   * rather than inferred from whatever the caller thinks it is showing.
   */
  hasReply?: boolean;
  /** Whether the work-queue panel is currently showing, so Queue can read as pressed. */
  queueOpen?: boolean;
  /** Show / hide this card's work-queue panel. */
  onToggleQueue?: () => void;
  /**
   * Put the cursor in the transcript's reply box, returning whether there was one to
   * focus. A card may only ever have ONE compose box: when the expanded transcript is
   * carrying it, Send hands off here instead of opening a second one beside it.
   */
  onFocusReply?: () => boolean;
  registerActions?: (id: string, handle: ActionBarHandle | null) => void;
  /** Open the reset-to-origin confirm (app-level modal). Absent = no reset control. */
  onReset?: () => void;
}): React.JSX.Element {
  const { bindings } = useKeybindings();
  const [composing, setComposing] = useState(false);
  const [confirmKill, setConfirmKill] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const canSend = Boolean(session.tmux || session.wezterm);
  // Queued work is the reason to open a hidden panel, so the button carries the count
  // rather than making you press it to find out whether anything is waiting.
  const openQueued = session.queue?.openCount ?? 0;

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
    // An expanded card already has a compose box - the transcript's reply. Send means
    // "let me type", not "give me another box", so put the cursor in that one. Only a
    // collapsed card, with no transcript panel mounted at all, opens our own.
    if (onFocusReply?.()) return;
    setComposing(true);
  }

  // A card has at most ONE send input, and the transcript's reply box wins whenever it
  // exists: this box may only be open while there is genuinely no other. So close it the
  // moment a reply box appears - the card expanding under a box already open here.
  // The text is in the draft map, so reopening Send brings it straight back.
  useEffect(() => {
    if (hasReply) setComposing(false);
  }, [hasReply]);

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

  function toggleQueue() {
    onToggleQueue?.();
  }

  // Register a stable handle that always calls the latest closures, so App can
  // drive this bar by keyboard without re-registering on every render.
  const latest = useRef({ startSend, focusPane, toggleQueue, cycleMode, requestKill, cancel });
  latest.current = { startSend, focusPane, toggleQueue, cycleMode, requestKill, cancel };
  useEffect(() => {
    if (!registerActions) return;
    const handle: ActionBarHandle = {
      startSend: () => latest.current.startSend(),
      focusPane: () => latest.current.focusPane(),
      toggleQueue: () => latest.current.toggleQueue(),
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
      ) : variant === "foot" ? (
        // The console footer: the mockup's Focus / Diff / Reset / Kill. Send lives in the
        // conversation's reply box and Queue is a tab, so neither is drawn here - but the
        // handle above still carries startSend and toggleQueue, so `s` and `q` work.
        <>
          <button
            className="act act-focus"
            onClick={focusPane}
            title="Bring this session's terminal pane to the front"
          >
            <kbd>{formatChord(bindings.focus)}</kbd> focus
          </button>
          {onDiff && session.cwd && (
            <button className="act" onClick={onDiff} title="View changes vs source branch">
              <kbd>{formatChord(bindings.diff)}</kbd> diff
            </button>
          )}
          {session.cwd && onReset && (
            <button
              className="act act-reset"
              onClick={onReset}
              title={`Reset checkout to origin's default branch and clear context (${formatChord(bindings.reset)})`}
            >
              <kbd>{formatChord(bindings.reset)}</kbd> reset
            </button>
          )}
          {confirmKill ? (
            <button
              className="act act-danger"
              onClick={() => void doKill()}
              title={
                session.tmux
                  ? `Terminates the agent and kills its tmux session "${session.tmux.session}"`
                  : "Terminates the agent process"
              }
            >
              confirm kill
            </button>
          ) : (
            <button className="act act-danger" onClick={() => setConfirmKill(true)}>
              <kbd>{formatChord(bindings.kill)}</kbd> kill
            </button>
          )}
          {confirmKill && (
            <button className="act" onClick={() => setConfirmKill(false)}>
              cancel
            </button>
          )}
        </>
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
          {onToggleQueue && (
            <button
              className={`btn btn-queue${queueOpen ? " on" : ""}`}
              aria-expanded={queueOpen}
              title={`${queueOpen ? "Hide" : "Show"} the work queued for this session (${formatChord(bindings.queue)})`}
              onClick={onToggleQueue}
            >
              Queue
              {openQueued > 0 && <span className="btn-count">{openQueued}</span>}
            </button>
          )}
          {session.cwd && onReset && (
            <button
              className="btn btn-reset"
              title={`Reset checkout to origin's default branch and clear context (${formatChord(bindings.reset)})`}
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
