import type { Session } from "@shared/types.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { WorkflowLadderPanel } from "../workflows/WorkflowLadder.tsx";

/**
 * The workflow run bound to one session, presented in the session detail pane.
 *
 * A component of its own rather than a branch inside ConsoleDetail so it can be rendered
 * and asserted directly: this repo renders with `renderToStaticMarkup` and has no jsdom, so
 * a test cannot click the tab that would otherwise mount it, and a body left inline could
 * only be checked by grepping the source - which pins spelling, not conduct.
 *
 * Returns a fragment: the scrollable `.detail-pane` wrapper belongs to the host, which
 * registers it with the console's arrow-key reader.
 */
export function SessionWorkflowsPane({
  run,
  session,
  onOpenRun,
}: {
  /** The workflow run bound to this session, if any. */
  run: WorkflowRunSummary | null;
  /** The session the pane belongs to - the ladder's retro offer is conditioned on it. */
  session: Session;
  onOpenRun: (runId: string) => void;
}): React.JSX.Element {
  return (
    <>
      {run && (
        <WorkflowLadderPanel run={run} session={session} onOpenRun={() => onOpenRun(run.id)} />
      )}
      {!run && <p className="detail-empty">No workflow is bound to this session.</p>}
    </>
  );
}
