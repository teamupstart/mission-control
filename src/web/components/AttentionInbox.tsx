import { ensembleStageWord } from "@shared/ensemble.ts";
import type { AttentionFold, AttentionItem } from "../lib/attention.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { AgentDot, EnsembleProgressDots } from "./session-bits.tsx";
import { ReviewCard } from "./ReviewModal.tsx";

/**
 * One place to drain everything that is waiting on a person.
 *
 * It replaces a chip that opened the FIRST answerable review's session modal: a second blocked
 * session, a run parked on your decision, and a stuck finalization were
 * all things the operator found by noticing them. What is drawn here is the fold in
 * `lib/attention.ts` and nothing else - this component decides no ordering, no counting and no
 * severity, so the chip's figure and the list cannot disagree, and the app keeps ONE alert
 * engine rather than growing a second one behind a modal.
 *
 * A MODAL, not a chip-anchored popover. In the desktop shell the topbar IS the title bar and
 * carries `-webkit-app-region: drag`; a floating layer over it hovers correctly while the OS
 * swallows its clicks, because only an explicit `no-drag` subtracts from the region. The shared
 * `.modal-backdrop` is already in that list, so routing through `<Overlay>` inherits the fix
 * instead of adding a second thing to remember (`desktop-drag-region.test.ts`).
 *
 * Reviews are answered HERE, inline, through the same `ReviewCard` the per-session modal draws -
 * `api.resolveReview` is all it needs, and two agents' questions in one document stay separate
 * because the card names its radio group after the review id. A pane dialog is deliberately NOT
 * answered here: it is a transient TUI fact - a cursor on a row of a screen re-read every poll -
 * answered by keystrokes aimed at that pane, and the two wire protocols are not unified behind
 * one button without deciding what a stale menu does to it. It gets a row saying who is stuck
 * and a click through to the card that can answer it.
 */

/** The heading each kind of obligation sits under. The fold groups them; this names them. */
const SECTION_TITLES: Record<AttentionItem["kind"], string> = {
  ensemble_decision: "Decisions",
  session_reviews: "Questions from agents",
  member_dialog: "Members parked on a menu",
  parked_finalization: "Stuck finalizations",
};

export function AttentionInbox({
  fold,
  onClose,
  onOpenEnsemble,
  onOpenSession,
}: {
  fold: AttentionFold;
  onClose: () => void;
  /** Open a run's detail (the dossier, when it is parked on a decision). */
  onOpenEnsemble: (runId: string) => void;
  /** Focus a session on the fleet. */
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  // Every deep link LEAVES: what it opens is somewhere else, and an inbox still covering it
  // would hide the thing the click asked for. Answering a review in place does not close.
  const leave = (go: () => void) => () => {
    onClose();
    go();
  };
  let section: AttentionItem["kind"] | null = null;

  return (
    <Overlay
      id={OVERLAY_IDS.attention}
      onClose={onClose}
      className="modal attention-inbox"
      ariaLabel="Attention inbox"
    >
      <header className="modal-head">
        <div>
          <strong>{fold.total > 0 ? `${fold.total} need you` : "Nothing needs you"}</strong>
          <span className="dim"> · answers, decisions and stuck finalizations</span>
        </div>
        <Tooltip label="Close the inbox - nothing is resolved">
          <button className="btn btn-ghost" onClick={onClose}>
            Close (esc)
          </button>
        </Tooltip>
      </header>
      <div className="modal-body">
        {fold.items.length === 0 && (
          <p className="inbox-empty">
            You are all clear. Agents' questions, ensemble decisions and stuck finalizations
            collect here as they arrive.
          </p>
        )}
        {fold.items.map((item) => {
          const heading = item.kind === section ? null : SECTION_TITLES[item.kind];
          section = item.kind;
          return (
            <div key={item.id} className="inbox-entry">
              {heading && <h4 className="inbox-section">{heading}</h4>}
              <InboxItem
                item={item}
                onOpenEnsemble={(runId) => leave(() => onOpenEnsemble(runId))()}
                onOpenSession={(sessionId) => leave(() => onOpenSession(sessionId))()}
              />
            </div>
          );
        })}
      </div>
    </Overlay>
  );
}

function InboxItem({
  item,
  onOpenEnsemble,
  onOpenSession,
}: {
  item: AttentionItem;
  onOpenEnsemble: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  switch (item.kind) {
    case "ensemble_decision":
      return (
        <section className="inbox-item inbox-decision">
          <div className="inbox-head">
            <span className="inbox-glyph" aria-hidden>
              ⧉
            </span>
            <strong>{item.summary.title}</strong>
            <span className="inbox-meta">
              {item.summary.strategyLabel} · {ensembleStageWord(item.summary)}
            </span>
            <EnsembleProgressDots summary={item.summary} />
            <span className="inbox-spacer" />
            <Tooltip label="Open this run's decision dossier - what was at stake, every candidate side by side, and the decision">
              <button className="btn btn-primary" onClick={() => onOpenEnsemble(item.runId)}>
                Open dossier
              </button>
            </Tooltip>
          </div>
          <p className="inbox-line">
            Every candidate has settled. Nothing else in this run moves until you confirm a
            winner or record no consensus.
          </p>
        </section>
      );
    case "session_reviews":
      return (
        <section className="inbox-item inbox-reviews">
          <div className="inbox-head">
            <AgentDot agent={item.session.agent} />
            <strong>{item.session.name || "(unnamed)"}</strong>
            <span className="dim"> · {item.reviews.length} pending</span>
            {item.context && <span className="inbox-context">{item.context}</span>}
            <span className="inbox-spacer" />
            <Tooltip label="Focus this session on the fleet">
              <button className="btn btn-ghost" onClick={() => onOpenSession(item.session.id)}>
                Open session
              </button>
            </Tooltip>
          </div>
          {item.reviews.map((review) => (
            <ReviewCard key={review.id} review={review} />
          ))}
        </section>
      );
    case "member_dialog":
      return (
        <section className="inbox-item inbox-dialog">
          <div className="inbox-head">
            <AgentDot agent={item.session.agent} />
            <strong>{item.session.name || "(unnamed)"}</strong>
            <span className="inbox-context">{item.context}</span>
            <span className="inbox-spacer" />
            <Tooltip label="Focus this session - a terminal menu is answered on its card">
              <button className="btn btn-ghost" onClick={() => onOpenSession(item.session.id)}>
                Open session
              </button>
            </Tooltip>
          </div>
          <p className="inbox-line">
            {item.prompt ? `Parked on: ${item.prompt}` : "Parked on a menu in its terminal."}{" "}
            <span className="dim">Answered on the session card, not here.</span>
          </p>
        </section>
      );
    case "parked_finalization":
      return (
        <section className="inbox-item inbox-parked">
          <div className="inbox-head">
            <span className="inbox-glyph" aria-hidden>
              ⧉
            </span>
            <strong>{item.summary.title}</strong>
            <span className="inbox-meta">{item.summary.strategyLabel} · promoting</span>
            <span className="inbox-spacer" />
            <Tooltip label="Open this run - a finalization resumes from the step that failed, never from the start">
              <button className="btn btn-ghost" onClick={() => onOpenEnsemble(item.runId)}>
                Open run
              </button>
            </Tooltip>
          </div>
          <p className="inbox-line inbox-error">{item.error}</p>
        </section>
      );
  }
}
