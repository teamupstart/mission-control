import { useEffect, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { canCycleMode, canInterruptSession } from "@shared/session.ts";
import { interruptUnsupportedWhy } from "@shared/harness-capabilities.ts";
import { canMessage, muxHandle } from "@shared/pane.ts";
import { api, type ActionResult } from "../lib/api.ts";
import { retroOffer, retroOutcome } from "../lib/retro-offer.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/drafts.ts";
import { formatChord, useKeybindings } from "../lib/keybindings.ts";
import { clearInterrupting, interruptReport, markInterrupting } from "../lib/interrupting.ts";
import { sdkDeliveryConfirmation } from "../lib/sdk-delivery.ts";
import { revealPaneDialog } from "../lib/pane-dialog-anchor.ts";
import {
  latestEditablePendingTurn,
  PENDING_TURN_HELD_REASON,
  PENDING_TURN_HELD_STATUS,
  pendingTurnHold,
  pendingTurnStatus,
  RECALL_ACKNOWLEDGEMENT_LOST_MESSAGE,
  recallPendingTurnIntoDraft,
  shouldRecallPendingTurn,
} from "../lib/pending-turns.ts";
import { Keycap } from "./Keycap.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { useTourTaskTargetRef } from "../tour/target-context.tsx";

/**
 * Imperative surface an ActionBar registers with the App so keyboard shortcuts
 * (send / focus / queue / mode / kill / esc on the selected session) drive the exact
 * same compose, queue, mode-cycle and confirm-kill flows as the detail controls -
 * one source of truth for both.
 */
export interface ActionBarHandle {
  startSend: () => void;
  focusPane: () => void;
  toggleQueue: () => void;
  cycleMode: () => void;
  requestComplete: () => void;
  requestKill: () => void;
  /**
   * Stop the current turn, drop the queue, and put the cursor in the composer.
   *
   * Unlike its neighbours it opens no dialog: interrupt is neither destructive nor
   * irreversible, and a confirm between the operator and a stop they want immediately is
   * the feature failing.
   */
  requestInterrupt: () => void;
  cancel: () => void;
  /**
   * Hand an embedded session to a terminal. A no-op on a pane-backed one, which is
   * already where a handoff would put it.
   */
  handoff: () => void;
}

/**
 * What "Continue in terminal" does, said once for the shared session footer.
 *
 * It names the one-way part, because that is the thing an operator cannot undo by clicking
 * again: after this the terminal session holds the conversation and this detail is gone.
 */
const HANDOFF_LABEL =
  "Stop the embedded driver and reopen this exact conversation in a terminal. One way - the terminal session takes over from here.";

/**
 * Per-session controls: focus its pane, send a message into its prompt, show its
 * work queue, reset its checkout, stop the turn it is running, complete its task, or
 * terminate it. "Send" puts a cursor in the detail's one compose box; "Queue" toggles the
 * work-queue tab.
 *
 * "Interrupt" is the one control here that acts immediately and asks nothing, and that is
 * the measure of it: it ends a TURN, not the session, so there is nothing to undo and
 * nothing to warn about. A confirm in front of a stop the operator wants right now is the
 * feature failing at the moment it is used.
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
  onToggleQueue,
  onFocusReply,
  registerActions,
  onReset,
  onComplete,
  onKill,
  onDiff,
  workflowRun = null,
}: {
  session: Session;
  /**
   * The workflow run bound to this session, when the caller already holds it.
   *
   * Read for ONE thing: the Inspector gate's `clean`, which is the strongest form of "the
   * pull request exists and its findings are addressed" and therefore decides whether Retro
   * is offered. Null is not a degraded answer - `retroOffer` falls back to the session's own
   * Inspector chip, which is the only predicate available to a session with no workflow.
   */
  workflowRun?: WorkflowRunSummary | null;
  /** Reveal the session detail's Diff tab. */
  onDiff?: () => void;
  /**
   * Whether the detail is currently carrying the transcript's reply box - the live
   * answer to "is there already a compose box here?", reported by the panel itself
   * rather than inferred from whatever the caller thinks it is showing.
   */
  hasReply?: boolean;
  /** Show / hide this session's work-queue panel. */
  onToggleQueue?: () => void;
  /**
   * Put the cursor in the transcript's reply box, returning whether there was one to
   * focus. A detail may only ever have one compose box: when the transcript is
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
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const tourTargetRef = useTourTaskTargetRef<HTMLDivElement>(
    "session-actions",
    session.task?.id,
  );
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showFlash(next: { text: string; ok: boolean }, duration: number): void {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(next);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setFlash(null);
    }, duration);
  }

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  // Delivery, not pane mechanics: the Send box asks whether a turn can REACH this
  // session, which a driver-run one answers yes to without holding a pane.
  const canSend = canMessage(session);
  // No pane to raise, so Focus is replaced rather than disabled: the affordance an embedded
  // session wants in that slot is the handoff that GIVES it one.
  const isEmbedded = session.runtime === "sdk";
  // What Kill tears down beyond the process itself: a multiplexer's named session, which an
  // emulator has no equivalent of. The backend names itself in the sentence, so the tmux
  // copy is unchanged and a second multiplexer's is true rather than borrowed.
  const killsMux = muxHandle(session);
  // Queued work is the reason to open a hidden panel, so the button carries the count
  // rather than making you press it to find out whether anything is waiting.
  const latestEditable = latestEditablePendingTurn(session.pendingTurns);
  // An OFFER, not permanent chrome: it appears at the one moment the plan chose and is
  // absent every other time, so its presence is itself the message. That is why there is no
  // disabled Retro anywhere in this row - a greyed-out button for the whole
  // life of a session would say "you could have retrospected" rather than "now is the time".
  const retro = retroOffer(session, workflowRun);

  // Written once so every control tells the same story about the click.
  const completeLabel = session.task
    ? `Record an outcome for "${session.task.title}" and close this session (${formatChord(bindings.complete)})`
    : "This session has no Mission Control task to complete";
  const killLabel = killsMux
    ? `Terminates the agent and kills its ${killsMux.backend} session "${killsMux.session}" - confirms first (${formatChord(bindings.kill)})`
    : `Terminates the agent process - confirms first (${formatChord(bindings.kill)})`;
  // Drawn in every session detail, and DISABLED rather than hidden when it cannot be used, because
  // the two reasons it cannot are worth different sentences and both are worth reading. A
  // harness/runtime pair with no mechanism gets the capability's own words - which is what
  // makes the next phase turn this control on by declaring a capability rather than by
  // touching this file. An idle agent gets the plainer fact: there is nothing to stop.
  const interruptable = canInterruptSession(session);
  const interruptLabel = interruptUnsupportedWhy(session.agent, session.runtime)
    ?? (interruptable
      ? `Stop what this session is doing now and drop its queued messages - the conversation stays (${formatChord(bindings.interrupt)})`
      : "This session isn't running a turn, so there is nothing to stop");

  async function run<T extends ActionResult>(label: string, fn: () => Promise<T>): Promise<T> {
    setBusy(label);
    const r = await fn();
    setBusy(null);
    if (!r.ok) {
      showFlash({ text: r.error ?? "failed", ok: false }, 3500);
    }
    return r;
  }

  async function submitMessage() {
    const text = inputRef.current?.value.trim();
    if (!text) return;
    const r = await run("send", () => api.sendText(session.id, text));
    if (r.ok) {
      const confirmation = sdkDeliveryConfirmation(r.delivery);
      if (confirmation) {
        showFlash({ text: confirmation, ok: true }, 5000);
      }
      // Sent, so the draft is spent. On failure it stays: `run` has already put the
      // reason on screen next to the text it's about.
      clearDraft(session.id, "send");
      if (r.delivery !== "pending") setComposing(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function recallPending(): Promise<void> {
    const input = inputRef.current;
    if (!input || !latestEditable || busy) return;
    if (input.value.length > 0) {
      showFlash({ text: "Clear the current draft before editing a queued message.", ok: false }, 3500);
      return;
    }
    const result = await run("pending", () =>
      recallPendingTurnIntoDraft({
        client: api,
        sessionId: session.id,
        turn: latestEditable,
        restore: (text) => {
          input.value = text;
          writeDraft(session.id, "send", text);
          input.focus();
          input.setSelectionRange(text.length, text.length);
        },
      }),
    );
    if (result.acknowledgementLost) {
      showFlash(
        {
          text: RECALL_ACKNOWLEDGEMENT_LOST_MESSAGE,
          ok: false,
        },
        6000,
      );
    }
  }

  async function retryPending(id: string, revision: number): Promise<void> {
    await run("pending", () => api.retryPendingTurn(session.id, id, revision));
  }

  async function resolvePending(id: string, revision: number): Promise<void> {
    await run("pending", () => api.resolvePendingTurn(session.id, id, revision));
  }

  function startSend() {
    if (!canSend) return;
    // A mounted transcript already has a compose box. Send means "let me type", not
    // "give me another box", so put the cursor in that one. Another tab opens our own.
    if (onFocusReply?.()) return;
    setComposing(true);
  }

  // A detail has at most one send input, and the transcript's reply box wins whenever it
  // exists. Close this fallback the moment that reply box appears.
  // The text is in the draft map, so reopening Send brings it straight back.
  useEffect(() => {
    if (hasReply) setComposing(false);
  }, [hasReply]);

  function focusPane() {
    void run("focus", () => api.focus(session.id));
  }

  /**
   * "Continue in terminal": stop the driver and reopen the same conversation in a pane.
   *
   * One-way, and the detail says so rather than asking: the alternative to offering it is an
   * embedded session an operator cannot take over, which is the one thing the runtime
   * genuinely costs them. The detail that comes back is a NEW session (a terminal one that
   * discovery adopted), so this one disappears - which is why nothing here waits for a
   * success message to render.
   */
  function handoff() {
    if (!isEmbedded) return;
    void run("handoff", () => api.handoff(session.id));
  }

  /**
   * Hand the session its own retrospective.
   *
   * A single click with no confirm, and that is the right weight for it: the daemon types an
   * instruction, and the instruction's own first rule is that nothing gets written without
   * the human approving it. The consequential step is the approval, which happens later and
   * item by item - putting a confirm in front of the request would be guarding the harmless
   * half of the ceremony.
   *
   * The success flash is not decoration either. The route has two success arms that mean
   * different things - typed into this session, or filed as a backlog task because it could
   * not be - and a live session is not a promise of delivery, so the outcome is REPORTED
   * rather than assumed from a 200.
   */
  async function runRetro(): Promise<void> {
    const result = await run("retro", () => api.runRetro(session.id));
    if (result.ok) showFlash({ text: retroOutcome(result), ok: true }, 6000);
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

  /**
   * Stop the turn, drop the queue, and hand the operator the composer.
   *
   * Deliberately NOT a dialog, which is the one way it differs from the two above. Kill and
   * Complete confirm because they are irreversible and settle a task; this ends a turn and
   * keeps everything else, and a confirm step in front of a stop someone wants immediately
   * is the feature failing at the moment it is used.
   *
   * `startSend` rather than a focus call of its own, so the cursor lands wherever this detail
   * puts a composer - the transcript's reply box when one is mounted, this bar's own box
   * otherwise. That is the same routing the `s` chord takes, and it is the point of the
   * gesture: the replacement instruction gets typed now, not after the agent finishes work
   * nobody wants.
   *
   * The optimistic badge is raised before the request and cleared on refusal, because the
   * failure the operator must never see is a detail that says "interrupting" about a stop the
   * daemon declined. A success leaves it up for the next real reading to retire.
   */
  async function requestInterrupt(): Promise<void> {
    if (!interruptable || busy === "interrupt") return;
    markInterrupting(session.id);
    const result = await run("interrupt", () => api.interrupt(session.id));
    const report = interruptReport(result);
    // `settled` covers both the refusal and the stop that found nothing. Neither will produce
    // a reading that retires the badge, so it has to be taken back here or it sits there
    // describing something that did not happen for its whole timeout.
    if (report.settled) clearInterrupting(session.id);
    if (report.flash) showFlash({ text: report.flash, ok: true }, 6000);
    // The composer regardless, including on a stop that found nothing: the operator pressed
    // this key in order to type, and a failed stop does not make that less true.
    if (result.ok) startSend();
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
    startSend, focusPane, toggleQueue, cycleMode, requestComplete, requestKill,
    requestInterrupt, cancel, handoff,
  });
  latest.current = {
    startSend, focusPane, toggleQueue, cycleMode, requestComplete, requestKill,
    requestInterrupt, cancel, handoff,
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
      requestInterrupt: () => void latest.current.requestInterrupt(),
      cancel: () => latest.current.cancel(),
      handoff: () => latest.current.handoff(),
    };
    registerActions(session.id, handle);
    return () => registerActions(session.id, null);
  }, [session.id, registerActions]);

  return (
    <div className="actions" ref={tourTargetRef}>
      {composing ? (
        <div className="compose">
          {session.pendingTurns.length > 0 && (
            <div className="compose-pending-list" aria-label="Pending messages">
              {session.pendingTurns.map((turn) => {
                const hold = pendingTurnHold(turn, session);
                return (
                <div
                  className={`compose-pending is-${turn.state}${hold ? " is-held" : ""}`}
                  key={turn.id}
                >
                  <span className="compose-pending-text">{turn.text}</span>
                  <Tooltip
                    label={hold ? `${PENDING_TURN_HELD_REASON[hold]}.` : "Waiting to be delivered"}
                  >
                    <span className="compose-pending-state">
                      {hold ? PENDING_TURN_HELD_STATUS : pendingTurnStatus(turn)}
                    </span>
                  </Tooltip>
                  {hold === "review" && (
                    <Tooltip label="Scroll to the review that is holding this message">
                      <button type="button" onClick={() => revealPaneDialog(session.id)}>
                        Go to review
                      </button>
                    </Tooltip>
                  )}
                  {turn.id === latestEditable?.id && (
                    <Tooltip label="Move this queued message back into the send box">
                      <button type="button" disabled={busy !== null} onClick={() => void recallPending()}>
                        Edit
                      </button>
                    </Tooltip>
                  )}
                  {turn.state === "uncertain" && (
                    <>
                      <Tooltip label="Queue this message again because it was not delivered">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void retryPending(turn.id, turn.revision)}
                        >
                          Retry
                        </button>
                      </Tooltip>
                      <Tooltip label="Remove this warning because the agent already received the message">
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void resolvePending(turn.id, turn.revision)}
                        >
                          Mark sent
                        </button>
                      </Tooltip>
                    </>
                  )}
                </div>
                );
              })}
            </div>
          )}
          <textarea
            ref={inputRef}
            className="compose-input"
            placeholder="Message to send…"
            rows={1}
            autoFocus
            // Cancel and Escape only close this box - they unmount the input, so
            // without these the text died with it and reopening Send showed a blank.
            // Neither gesture is a human deleting anything.
            defaultValue={readDraft(session.id, "send")}
            onChange={(e) => writeDraft(session.id, "send", e.currentTarget.value)}
            onKeyDown={(e) => {
              if (
                latestEditable &&
                shouldRecallPendingTurn({
                  key: e.key,
                  value: e.currentTarget.value,
                  selectionStart: e.currentTarget.selectionStart,
                  selectionEnd: e.currentTarget.selectionEnd,
                  composing: e.nativeEvent.isComposing,
                  modified: e.altKey || e.ctrlKey || e.metaKey || e.shiftKey,
                  busy: busy !== null,
                  hasAttachments: false,
                })
              ) {
                e.preventDefault();
                void recallPending();
              } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submitMessage();
              }
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
      ) : (
        // The console footer: the mockup's Focus / Diff / Reset / Kill, plus Interrupt.
        // Send lives in the conversation's reply box and Queue is a tab, so neither is
        // drawn here - but the handle above still carries startSend and toggleQueue, so
        // `s` and `q` work.
        <>
          {isEmbedded ? (
            <Tooltip label={HANDOFF_LABEL}>
              <button className="act act-focus" onClick={handoff} disabled={busy === "handoff"}>
                <Keycap action="handoff" /> {busy === "handoff" ? "opening…" : "terminal"}
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="Bring this session's terminal pane to the front">
              <button className="act act-focus" onClick={focusPane}>
                <Keycap action="focus" /> focus
              </button>
            </Tooltip>
          )}
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
          {retro && (
            <Tooltip label={retro.tooltip}>
              <button
                className="act act-retro"
                onClick={() => void runRetro()}
                disabled={busy === "retro"}
              >
                {busy === "retro" ? "sending…" : "retro"}
              </button>
            </Tooltip>
          )}
          <Tooltip label={interruptLabel}>
            <button
              className="act act-interrupt"
              onClick={() => void requestInterrupt()}
              disabled={!interruptable || busy === "interrupt"}
            >
              {/* "interrupt", not "stop": the badge beside it already says "stopping" for
                  a session being evicted, and two words a keystroke apart meaning end-the-
                  turn and end-the-session is the confusion this control exists to remove. */}
              <Keycap action="interrupt" /> {busy === "interrupt" ? "interrupting…" : "interrupt"}
            </button>
          </Tooltip>
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
      )}
      {flash && (
        <span className={`action-flash${flash.ok ? " is-ok" : ""}`} role="status">
          {flash.text}
        </span>
      )}
    </div>
  );
}
