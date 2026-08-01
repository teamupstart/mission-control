import type { Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { NomistakesStrip } from "./NomistakesStrip.tsx";
import { NomistakesFixLog } from "./NomistakesFixLog.tsx";
import { WorkflowLadderPanel } from "../workflows/WorkflowLadder.tsx";

/**
 * Every "how is this run going" readout for one session, in one pane: the Mission Control
 * workflow ladder and the no-mistakes gate.
 *
 * These are two genuinely separate systems - an in-app engine driving a graph of personas
 * and checks, and an external `no-mistakes` CLI polled through git - on unrelated data, and
 * neither reads the other's state. What they have in common is the only thing that matters
 * to an operator: both answer whether this change is allowed to land, and both were reading
 * as progress bars stacked above the transcript, where between them they could push the
 * first message of a long session off the bottom of the screen. This is where they live now.
 *
 * A component of its own rather than a branch inside ConsoleDetail so it can be rendered
 * and asserted directly: this repo renders with `renderToStaticMarkup` and has no jsdom, so
 * a test cannot click the tab that would otherwise mount it, and a body left inline could
 * only be checked by grepping the source - which pins spelling, not conduct.
 *
 * This pane is where the old Gate tab went. The requirement was three-sided and this is the
 * only arrangement that satisfies all of it: the no-mistakes strip MOVES here, everything
 * the Gate tab held comes with it, and the conversation window keeps none of it. So Gate is
 * gone from the tab strip rather than sitting beside this one - two adjacent tabs both
 * answering "is this change allowed to land" is the split that put one of them above the
 * transcript in the first place.
 *
 * Moved and not deleted because the strip is not a read-only progress bar: it carries the
 * Approve / Fix / Skip actions, and Console and the Board drill-in have no card to put them
 * on. Delete it and a parked gate becomes unanswerable in both, and the attention inbox's
 * "answer this gate" deep link has no destination. Cards is untouched throughout - it draws
 * no tab strip and keeps its own copy on the card.
 *
 * Returns a fragment: the scrollable `.detail-pane` wrapper belongs to the host, which
 * registers it with the console's arrow-key reader.
 */
export function SessionWorkflowsPane({
  session,
  run,
  gateNeedsYou,
  onOpenRun,
  onOpenDiff,
}: {
  session: Session;
  /** The workflow run bound to this session, if any. */
  run: WorkflowRunSummary | null;
  gateNeedsYou: boolean;
  onOpenRun: (runId: string) => void;
  onOpenDiff: (sha: string) => void;
}): React.JSX.Element {
  // Each on its own condition: a session can have a workflow, a gate, both or neither.
  const fixes = session.nomistakesFixes;
  return (
    <>
      {run && <WorkflowLadderPanel run={run} onOpenRun={() => onOpenRun(run.id)} />}
      {session.nomistakes && (
        <NomistakesStrip
          sessionId={session.id}
          nm={session.nomistakes}
          needsYou={gateNeedsYou}
          narration={session.nomistakesNarration}
        />
      )}
      {/* Not nested under `session.nomistakes`: a run retires while the commits it made do
          not, so the fix log outlives the strip above it. The old Gate tab nested the two
          and lost the log at that moment; the conversation copy did not, and this keeps the
          more generous of the two readings. */}
      {fixes.length > 0 && (
        <NomistakesFixLog sessionId={session.id} fixes={fixes} onOpenDiff={onOpenDiff} />
      )}
      {/* Two different nothings, and the old Gate tab's copy told them apart wrongly: it
          said "this repo isn't gated by no-mistakes" whenever `session.nomistakes` was
          null, which is also true of a gated repo that simply has no run in flight - so the
          sentence contradicted the ◇ gated chip in the footer three lines below it.
          `nomistakesGated` is the field that actually answers whether the repo is gated. */}
      {!run && !session.nomistakes && fixes.length === 0 && (
        <p className="detail-empty">
          {session.nomistakesGated
            ? "No workflow is bound to this session, and no-mistakes hasn't run on it yet."
            : "No workflow is bound to this session, and this repo isn't gated by no-mistakes."}
        </p>
      )}
    </>
  );
}
