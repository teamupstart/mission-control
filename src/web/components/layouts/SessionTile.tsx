import { useState } from "react";
import type { AssignResetConfirm, Session } from "@shared/types.ts";
import { gateStepView, relativeTime, stateDisplay, uptime } from "../../lib/format.ts";
import { AgentDot, CostChip, RuntimeMetaRow } from "../session-bits.tsx";
import { canAcceptTask, dropTaskOnSession } from "./BacklogColumn.tsx";

/**
 * Whether a click only marks the end of a drag-select rather than a click on the thing
 * underneath it. Copying a branch name off a tile is a fair thing to want on a triage
 * board, and the mouseup that ends that drag lands on the tile as a click - which should
 * not navigate you into a session you were only reading.
 *
 * Takes the selection rather than reading it, so the decision can be tested without a DOM.
 */
export function isDragSelection(sel: { isCollapsed: boolean } | null): boolean {
  return sel != null && !sel.isCollapsed;
}

/**
 * A session shrunk to what you'd triage by, without opening it: who it is, what it's
 * for, what it's doing this second, where its gate is parked, how much context it has
 * left, and whether it wants something. The conversation, the diff, and the gate's
 * buttons are all one click away in the console detail the tile opens.
 *
 * An idle tile is also a drop target for a backlog card - see BacklogColumn.
 *
 * Lives beside BoardView rather than inside it for consistency with the rest of the
 * board layout - BacklogColumn, RailRow and ConsoleDetail are each their own file, and
 * the tile was the one piece still inline. BoardView is left composing the board.
 */
export function SessionTile({
  session,
  gateNeedsYou,
  onOpen,
  draggingRepo,
  onDropped,
  onDropError,
  onDropConfirm,
}: {
  session: Session;
  gateNeedsYou: boolean;
  onOpen: () => void;
  draggingRepo: string | null;
  onDropped: () => void;
  onDropError: (message: string) => void;
  /** The drop needs a yes: the handover would take something from this agent. */
  onDropConfirm: (pending: { taskId: string; confirm: AssignResetConfirm }) => void;
}): React.JSX.Element {
  const st = stateDisplay(session);
  // A run always produces a gate line, and the line always carries the run's segments:
  // pairing them here is what lets the tile head drop its own diamond (below) on the
  // strength of a single guard rather than re-deriving the invariant at each use.
  const nm = session.nomistakes;
  const gate = nm ? { ...gateStepView(nm), steps: nm.steps } : null;
  const isRunning = session.state === "working" || session.state === "starting";
  const [over, setOver] = useState(false);

  const droppable = canAcceptTask(session, draggingRepo);

  return (
    <div
      className={`tile tone-${st.tone}${st.tone === "attention" ? " attention" : ""}${
        droppable ? " can-drop" : ""
      }${over ? " drop-over" : ""}`}
      onDragOver={(e) => {
        if (!droppable) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOver(true);
      }}
      onClick={() => {
        if (isDragSelection(window.getSelection())) return;
        onOpen();
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!droppable) return;
        e.preventDefault();
        // Clear the drag here as well as on dragend: a drop that lands inside a
        // re-rendering board can swallow the dragend, leaving every tile lit.
        onDropped();
        void dropTaskOnSession(e, session, onDropError, onDropConfirm);
      }}
    >
      {/* The tile is not a <button> around its content, because the PR flag has to be a
          real link and a link cannot live inside a button - nested there it could only
          ever have been a span, which is what made clicking a PR open the console and
          cost you a second click on the chip in there.

          So the open action is split. The pointer half lives on the tile root above:
          clicks land on whatever content you aimed at and bubble up, which keeps the
          `title` tooltips on the model, effort, context meter and gate diamonds
          hoverable. This stretched button is the keyboard half - focusable, labelled,
          Enter/Space-activatable, which a bare div with onClick would not be. It takes
          no pointer events, so it can never swallow a click meant for the content. The
          PR flag is a real link that stops propagation, so it navigates instead of
          opening the console.

          It opens the session itself rather than letting its click bubble to the root,
          because the root declines clicks that merely end a text selection. Reaching a
          session by keyboard must not depend on whether something happens to be selected
          somewhere on the page. */}
      <button
        type="button"
        className="tile-open"
        onClick={(e) => {
          e.stopPropagation();
          onOpen();
        }}
        aria-label={`Open ${session.name || "unnamed session"}`}
      />

      <span className="tile-head">
        <AgentDot agent={session.agent} />
        <span className="tile-name">{session.name || "(unnamed)"}</span>
        {session.nomistakesGated && !session.nomistakes && (
          <span className="gated" title="Gated by no-mistakes" aria-hidden>
            ◇
          </span>
        )}
      </span>

      {session.goal?.text && <span className="tile-goal">{session.goal.text}</span>}

      {/* What it's doing right now - the board's only live signal past "6s ago", and what
          tells an actively-editing session apart from one stalled on a prompt. Only a
          running session has a live action to report: once it settles, activity holds a
          status label ("idle", "ended (logout)") the column and badge already carry, and
          a ticker there would animate over a session that isn't moving. `instrumented`
          is the freshness half of that: when hooks lapse past the overlay TTL the passive
          poller refreshes `state` from the transcript but leaves `activity` at its stale
          overlay value, so only a live hook makes the label worth animating. */}
      {session.instrumented && isRunning && session.activity && (
        <span className="tile-activity">
          <span className="ta-glyph" aria-hidden>
            ⟳
          </span>
          <span className="ta-txt">{session.activity}</span>
        </span>
      )}

      {/* The gate as a named hairline: the segment bar the tile always afforded, now with
          the stage a glance should land on spelled out above it (gateStepView picks it).
          The full strip - findings and buttons - stays in the console detail. */}
      {gate && (
        <span className="tile-gate">
          <span className="tile-gate-row">
            <span className="gate-brand" title="Gated by no-mistakes" aria-hidden>
              ◇
            </span>
            <span className={`gate-step gate-${gate.tone}`}>{gate.label}</span>
            {!gate.done && gate.pos != null && (
              <span className="gate-pos">
                step {gate.pos} / {gate.total}
              </span>
            )}
          </span>
          <span className="tile-rail" aria-hidden>
            {gate.steps.map((step) => (
              <span key={step.step} className={`tr-${step.status}`} />
            ))}
          </span>
        </span>
      )}

      <span className="tile-marks">
        {gateNeedsYou && <span className="tile-flag tf-gate">gate</span>}
        {session.note && (
          <span className={`tile-flag tf-${session.note.disposition}`}>
            {session.note.disposition === "escalated" ? "◆ decision" : "✎ draft"}
          </span>
        )}
        {session.pendingReviews > 0 && <span className="tile-flag tf-review">review</span>}
        {session.queue && session.queue.openCount > 0 && (
          <span className="tile-flag tf-queue">{session.queue.openCount} queued</span>
        )}
        {/* A PR the operator can reach in one click, from the board, without a detour
            through the console. Only a link when there is somewhere to go: a number
            with no URL yet stays the flag it always was. */}
        {session.prNumber &&
          (() => {
            const tone = `pr-${session.prState ?? "open"}`;
            const label = (
              <>
                #{session.prNumber}
                {session.prChecks === "failing" && " ⚠"}
              </>
            );
            return session.prUrl ? (
              <a
                className={`tile-flag tile-flag-link ${tone}`}
                href={session.prUrl}
                target="_blank"
                rel="noreferrer"
                // Without this the click also reaches the root's onClick and opens the
                // console behind the new tab - the exact second click this fix removes.
                // stopPropagation only: the link still has to navigate.
                onClick={(e) => e.stopPropagation()}
                title={
                  session.prChecks === "failing"
                    ? "A CI check failed on this pull request - open on GitHub"
                    : `Pull request #${session.prNumber} - open on GitHub`
                }
              >
                {label}
              </a>
            ) : (
              <span className={`tile-flag ${tone}`}>{label}</span>
            );
          })()}
      </span>

      {/* Only rendered while a compatible card is in the air, so it costs the tile
          nothing the rest of the time. */}
      {droppable && <span className="tile-drop-hint">↳ drop to hand this over</span>}

      {/* The same runtime row the card shows - model, thinking level, and a context meter
          that now carries its number. The board used to draw only the bare meter here; the
          percentage is the triage signal (a session near full is about to compact). */}
      {/* Beside the runtime row, deliberately NOT up in `.tile-marks` above: that row
          means "things that want your attention", and a routine spend figure is not an
          alert. When it stops being routine the chip's own tone says so (costTone), which
          keeps one spelling of the number per surface rather than two. */}
      <span className="tile-runtime-line">
        {session.meta && <RuntimeMetaRow meta={session.meta} />}
        <CostChip cost={session.cost} />
      </span>

      <span className="tile-foot">
        <span className="tile-branch">{session.gitBranch ?? session.nameSource}</span>
        <span className="tile-seen">
          {session.lastActivity ? relativeTime(session.lastActivity) : uptime(session.startedAt)}
        </span>
      </span>
    </div>
  );
}
