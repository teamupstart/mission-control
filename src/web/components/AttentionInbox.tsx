import { ensembleStageWord } from "@shared/ensemble.ts";
import {
  PIPELINE_HALT_ACTIONS,
  PIPELINE_HALT_CLASS_INFO,
  PIPELINE_HALT_CONSOLES,
  PIPELINE_PROVIDER_INFO,
} from "@shared/pipeline.ts";
import { PipelineActions } from "../pipelines/PipelineActions.tsx";
import { pipelineRunHash } from "../workflows/useWorkflowRoute.ts";
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
  session_dialog: "Parked on a menu",
  pipeline_halt: "Pipeline halts",
  session_blocked: "Waiting on you",
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
      // `Overlay` defaults `role` to undefined, and an `aria-label` on a role-less div is
      // dropped by most screen readers - so this modal announced itself as nothing at all,
      // alone among the overlays (every sibling passes this). It is also what lets a test
      // address the inbox by role instead of by class.
      role="dialog"
      ariaLabel="Attention inbox"
    >
      <header className="modal-head">
        <div>
          {/*
            "to answer", matching the segment that opens this - not "need you", which is the
            OTHER segment (sessions in an attention tone). Clicking `3 to answer` and landing
            on a panel headed `3 need you` made the operator reconcile two labels for one
            figure at the moment they were trying to drain it.
          */}
          <strong>{fold.total > 0 ? `${fold.total} to answer` : "Nothing to answer"}</strong>
          {/* Enumerates the sections below, so it has to grow when one does - a subtitle that
              lists four kinds of obligation over a panel holding five reads as a panel showing
              you less than it has. */}
          <span className="dim"> · answers, decisions, halts and stuck finalizations</span>
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
                onLeave={onClose}
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
  onLeave,
}: {
  item: AttentionItem;
  onOpenEnsemble: (runId: string) => void;
  onOpenSession: (sessionId: string) => void;
  /** Close the inbox, for the one row whose deep link is an `href` rather than a handler. */
  onLeave: () => void;
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
            <ReviewCard key={review.id} review={review} note={item.session.note} />
          ))}
        </section>
      );
    case "session_dialog":
      return (
        <section className="inbox-item inbox-dialog">
          <div className="inbox-head">
            <AgentDot agent={item.session.agent} />
            <strong>{item.session.name || "(unnamed)"}</strong>
            {item.context && <span className="inbox-context">{item.context}</span>}
            <span className="inbox-spacer" />
            <Tooltip label="Focus this session - a terminal menu is answered on its card">
              <button className="btn btn-ghost" onClick={() => onOpenSession(item.session.id)}>
                Open session
              </button>
            </Tooltip>
          </div>
          <p className="inbox-line">
            {item.prompt ? `Parked on: ${item.prompt}` : "Parked on a menu in its terminal."}
            {/* The agent's own text ends without punctuation, so the aside used to butt
                straight onto it ("...use Bash Answered on the session card"). The app's
                separator rather than a full stop, because the clause is a different voice. */}
            <span className="dim"> · Answered on the session card, not here.</span>
          </p>
        </section>
      );
    case "pipeline_halt":
      return (
        <section className="inbox-item inbox-halt">
          <div className="inbox-head">
            <span className="inbox-glyph" aria-hidden>
              ⇶
            </span>
            <strong>{item.run.slug}</strong>
            <span className="inbox-meta">
              {PIPELINE_PROVIDER_INFO[item.run.provider].label} ·{" "}
              {PIPELINE_HALT_CLASS_INFO[item.haltClass].label}
            </span>
            <span className="inbox-spacer" />
            {/*
              An ANCHOR, not a button, and the only row here that is one. Every other deep
              link in this inbox leaves through a handler the app owns, because it moves
              within a page's own state; this one addresses a route by hash, which is exactly
              what `pipelineRunHash` exists to assemble - and an anchor is what lets an
              operator open a halted run in a second window without losing the inbox.

              It still closes the inbox, like every other deep link here: what it opens is
              somewhere else, and a modal left standing over it would hide the thing the
              click asked for.
            */}
            <Tooltip label="Open this pipeline's run - its steps, its gate verdicts, and what stopped it">
              <a className="btn btn-ghost" href={pipelineRunHash(item.run)} onClick={onLeave}>
                Open run
              </a>
            </Tooltip>
          </div>
          <p className="inbox-line">
            {item.reason}
            {/* The app's separator rather than a full stop: the engine's own sentence ends
                without punctuation, and the clause after it is a different voice. */}
            <span className="dim"> · {PIPELINE_HALT_CLASS_INFO[item.haltClass].blurb}</span>
          </p>
          <p className="inbox-line inbox-runbook">
            <span className="dim">Runbook: </span>
            {item.runbook}
          </p>
          {/*
            The verbs this halt's own class calls for, and nothing wider: an unpark on a row
            the engine will re-kick itself, a grant where a DECIDE gate refused, the reseal
            ceremony where a seal broke. The daemon verbs are deliberately absent - they act
            on the whole repository, and a repository-wide pause reached from a row about one
            feature is the mis-click this inbox should not offer.

            The row does NOT close when a verb lands. Draining is the point of this panel, and
            the halt clearing is what removes the row - through the projection's own event, so
            what disappears is a row the daemon agrees is finished rather than one this
            component hid on its own.
          */}
          <PipelineActions
            run={item.run}
            actions={PIPELINE_HALT_ACTIONS[item.haltClass]}
            consoles={PIPELINE_HALT_CONSOLES[item.haltClass]}
          />
        </section>
      );
    case "session_blocked":
      return (
        <section className="inbox-item inbox-blocked">
          <div className="inbox-head">
            <AgentDot agent={item.session.agent} />
            <strong>{item.session.name || "(unnamed)"}</strong>
            {item.context && <span className="inbox-context">{item.context}</span>}
            <span className="inbox-spacer" />
            <Tooltip label="Focus this session - it reported that it is waiting on you, so the answer goes to the agent directly">
              <button className="btn btn-ghost" onClick={() => onOpenSession(item.session.id)}>
                Open session
              </button>
            </Tooltip>
          </div>
          <p className="inbox-line">
            {item.activity
              ? `Waiting on you: ${item.activity}`
              : "Reported that it is waiting on you."}
            <span className="dim"> · Answered in the session, not here.</span>
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
