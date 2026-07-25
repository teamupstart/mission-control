import { useEffect, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import { canCycleMode } from "@shared/session.ts";
import { canMessage, canWriteTo, muxHandle } from "@shared/pane.ts";
import { api } from "../lib/api.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/drafts.ts";
import { formatChord, useKeybindings } from "../lib/keybindings.ts";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";

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
  requestComplete: () => void;
  requestKill: () => void;
  cancel: () => void;
}

/**
 * Per-session controls: focus its pane, send a message into its prompt, show its
 * work queue, reset its checkout, complete its task, or terminate it. "Send" puts a
 * cursor in this card's one compose box; "Queue" toggles the work-queue panel.
 *
 * "Reset", "Complete" and "Kill" all open an APP-LEVEL confirm rather than deciding
 * anything here. Kill used to arm itself in place on a first click; it moved out for
 * the reason `KillModal` documents - the consequence worth stating (a task settling as
 * failed, and the Complete that avoids it) does not fit on a button that turns red.
 * Keeping all three on one mechanism also means one overlay registration each, so
 * Escape and the backdrop behave identically across them.
 */
export function ActionBar({
  session,
  hasReply = false,
  queueOpen = false,
  onToggleQueue,
  onFocusReply,
  registerActions,
  onReset,
  onComplete,
  onKill,
  variant = "card",
  onDiff,
  onFiles,
}: {
  session: Session;
  /**
   * Which control set to draw. "card" (default, unchanged) is the grid's full row -
   * Send / Focus / Queue / Reset / Kill. "foot" is the console's detail footer, which
   * matches the mockup: Focus / Diff / Reset / Kill, since Send is the conversation's own
   * reply box and Queue is a tab. The imperative HANDLE is identical either way, so every
   * keyboard shortcut still works in both - only the buttons drawn differ. */
  variant?: "card" | "foot";
  /** Reveal the session detail's Diff tab. Only drawn by the "foot" variant. */
  onDiff?: () => void;
  /** Open the checkout's extracted file workspace. */
  onFiles?: () => void;
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
  /**
   * Open the complete-and-close confirm (app-level modal). Absent = no complete control.
   * The button is drawn but disabled when this session carries no task, because "there
   * is nothing to mark done" is worth saying once, in a tooltip, rather than leaving the
   * operator to wonder why the affordance they were told about is missing.
   */
  onComplete?: () => void;
  /** Open the kill confirm (app-level modal). Absent = no kill control. */
  onKill?: () => void;
}): React.JSX.Element {
  const { bindings } = useKeybindings();
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Delivery, not pane mechanics: the Send box asks whether a turn can REACH this
  // session, which a driver-run one answers yes to without holding a pane.
  const canSend = canMessage(session);
  // What Kill tears down beyond the process itself: a multiplexer's named session, which an
  // emulator has no equivalent of. The backend names itself in the sentence, so the tmux
  // copy is unchanged and a second multiplexer's is true rather than borrowed.
  const killsMux = muxHandle(session);
  // Queued work is the reason to open a hidden panel, so the button carries the count
  // rather than making you press it to find out whether anything is waiting.
  const openQueued = session.queue?.openCount ?? 0;

  // Written once and used by both variants, so the two rows cannot drift into telling
  // different stories about the same click.
  const completeLabel = session.task
    ? `Record an outcome for "${session.task.title}" and close this session (${formatChord(bindings.complete)})`
    : "This session has no Mission Control task to complete";
  const killLabel = killsMux
    ? `Terminates the agent and kills its ${killsMux.backend} session "${killsMux.session}" - confirms first (${formatChord(bindings.kill)})`
    : `Terminates the agent process - confirms first (${formatChord(bindings.kill)})`;

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

  function startSend() {
    if (!canSend) return;
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

  // Cycle the permission mode (Shift+Tab) - only meaningful for a harness whose live
  // control is that cycle, with a pane to inject the keystroke into.
  function cycleMode() {
    if (!canCycleMode(session)) return;
    void run("mode", () => api.cycleMode(session.id));
  }

  // Both open their dialog rather than acting: the confirm lives in the modal, which
  // owns its own Escape, so the chord and the button reach the identical flow.
  function requestComplete() {
    setComposing(false);
    onComplete?.();
  }

  function requestKill() {
    setComposing(false);
    onKill?.();
  }

  // Escape's job here is now only the compose box. The dialogs are overlays and peel
  // themselves off first - App stands down while any is open (`overlays.anyOpen`), so
  // clearing their state from here would be reaching across that boundary.
  function cancel() {
    setComposing(false);
  }

  function toggleQueue() {
    onToggleQueue?.();
  }

  // Register a stable handle that always calls the latest closures, so App can
  // drive this bar by keyboard without re-registering on every render.
  const latest = useRef({
    startSend, focusPane, toggleQueue, cycleMode, requestComplete, requestKill, cancel,
  });
  latest.current = {
    startSend, focusPane, toggleQueue, cycleMode, requestComplete, requestKill, cancel,
  };
  useEffect(() => {
    if (!registerActions) return;
    const handle: ActionBarHandle = {
      startSend: () => latest.current.startSend(),
      focusPane: () => latest.current.focusPane(),
      toggleQueue: () => latest.current.toggleQueue(),
      cycleMode: () => latest.current.cycleMode(),
      requestComplete: () => latest.current.requestComplete(),
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
          <Tooltip label={busy === "send" ? "Sending…" : "Send this message to the agent's prompt"}>
            <button className="btn btn-send" disabled={busy === "send"} onClick={() => void submitMessage()}>
              Send
            </button>
          </Tooltip>
          <Tooltip label="Close the compose box - the draft is kept">
            <button className="btn btn-ghost" onClick={() => setComposing(false)}>
              Cancel
            </button>
          </Tooltip>
        </div>
      ) : variant === "foot" ? (
        // The console footer: the mockup's Focus / Diff / Reset / Kill. Send lives in the
        // conversation's reply box and Queue is a tab, so neither is drawn here - but the
        // handle above still carries startSend and toggleQueue, so `s` and `q` work.
        <>
          <Tooltip label="Bring this session's terminal pane to the front">
            <button className="act act-focus" onClick={focusPane}>
              <Keycap action="focus" /> focus
            </button>
          </Tooltip>
          {onDiff && session.cwd && (
            <Tooltip label="View this checkout's changes vs its source branch">
              <button className="act" onClick={onDiff}>
                <Keycap action="diff" /> diff
              </button>
            </Tooltip>
          )}
          {session.cwd && onReset && (
            <Tooltip
              label={`Reset checkout to origin's default branch and clear context (${formatChord(bindings.reset)})`}
            >
              <button className="act act-reset" onClick={onReset}>
                <Keycap action="reset" /> reset
              </button>
            </Tooltip>
          )}
          {onComplete && (
            <Tooltip label={completeLabel}>
              <button
                className="act act-complete"
                onClick={requestComplete}
                disabled={!session.task}
              >
                <Keycap action="complete" /> complete
              </button>
            </Tooltip>
          )}
          {onKill && (
            <Tooltip label={killLabel}>
              <button className="act act-danger" onClick={requestKill}>
                <Keycap action="kill" /> kill
              </button>
            </Tooltip>
          )}
        </>
      ) : (
        <>
          <Tooltip
            label={
              canSend
                ? `Type into this session's prompt (${formatChord(bindings.send)})`
                : "No pane to send to"
            }
          >
            <button className="btn" disabled={!canSend} onClick={startSend}>
              <Keycap action="send" /> Send
            </button>
          </Tooltip>
          <Tooltip
            label={`Bring this session's terminal pane to the front (${formatChord(bindings.focus)})`}
          >
            <button className="btn" onClick={focusPane}>
              <Keycap action="focus" /> Focus
            </button>
          </Tooltip>
          {session.cwd && onFiles && (
            <Tooltip label={`Browse and edit checkout files (${formatChord(bindings.files)})`}>
              <button className="btn" onClick={onFiles}>
                <Keycap action="files" /> Files
              </button>
            </Tooltip>
          )}
          {onToggleQueue && (
            <Tooltip
              label={`${queueOpen ? "Hide" : "Show"} the work queued for this session (${formatChord(bindings.queue)})`}
            >
              <button
                className={`btn btn-queue${queueOpen ? " on" : ""}`}
                aria-expanded={queueOpen}
                onClick={onToggleQueue}
              >
                <Keycap action="queue" /> Queue
                {openQueued > 0 && <span className="btn-count">{openQueued}</span>}
              </button>
            </Tooltip>
          )}
          {session.cwd && onReset && (
            <Tooltip
              label={`Reset checkout to origin's default branch and clear context (${formatChord(bindings.reset)})`}
            >
              <button className="btn btn-reset" onClick={onReset}>
                <Keycap action="reset" /> Reset
              </button>
            </Tooltip>
          )}
          <span className="actions-spacer" />
          {onComplete && (
            <Tooltip label={completeLabel}>
              <button className="btn btn-complete" onClick={requestComplete} disabled={!session.task}>
                <Keycap action="complete" /> Complete
              </button>
            </Tooltip>
          )}
          {onKill && (
            <Tooltip label={killLabel}>
              <button className="btn btn-danger-ghost" onClick={requestKill}>
                <Keycap action="kill" /> Kill
              </button>
            </Tooltip>
          )}
        </>
      )}
      {flash && <span className="action-flash">{flash}</span>}
    </div>
  );
}
