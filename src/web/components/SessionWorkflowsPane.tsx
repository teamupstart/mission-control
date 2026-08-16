import type { Session } from "@shared/types.ts";
import type { PipelineRun } from "@shared/pipeline.ts";
import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { WorkflowLadderPanel } from "../workflows/WorkflowLadder.tsx";
import { PipelineLadder } from "../pipelines/PipelineLadder.tsx";
import { usePipelineRunDetail } from "../pipelines/usePipelineRunDetail.ts";

/**
 * The run bound to one session, presented in the session detail pane.
 *
 * A component of its own rather than a branch inside ConsoleDetail so it can be rendered
 * and asserted directly: this repo renders with `renderToStaticMarkup` and has no jsdom, so
 * a test cannot click the tab that would otherwise mount it, and a body left inline could
 * only be checked by grepping the source - which pins spelling, not conduct.
 *
 * TWO KINDS OF RUN reach this pane, and they are drawn by two ladders rather than one. A
 * workflow run is Mission Control's own review of this session's work; a pipeline run is an
 * external engine driving the session itself. They answer different questions and share no
 * fields, so a merged component would be two renderers behind one name - but they share the
 * ladder GRAMMAR (`Rung`, `PipelineStatusChip`), which is what makes them read as one pane.
 *
 * The pipeline arm takes precedence when a session has both, and the case is not theoretical:
 * an engine-driven session can also carry a workflow binding from a repository's defaults.
 * The engine is what is driving the agent, so it is what the pane is about; the workflow's
 * own chip on the card still opens its run.
 *
 * Returns a fragment: the scrollable `.detail-pane` wrapper belongs to the host, which
 * registers it with the console's arrow-key reader.
 */
export function SessionWorkflowsPane({
  run,
  session,
  pipelineRun = null,
  onOpenRun,
  onOpenPipelineRun,
}: {
  /** The workflow run bound to this session, if any. */
  run: WorkflowRunSummary | null;
  /** The session the pane belongs to - the ladder's retro offer is conditioned on it. */
  session: Session;
  /**
   * The projection of the pipeline this session is correlated to, when the fleet has sent
   * it. Null covers both "not correlated" and "correlated, projection not here yet"; the
   * ladder is mounted on the session's own `pipeline` link, so the second case still draws.
   */
  pipelineRun?: PipelineRun | null;
  onOpenRun: (runId: string) => void;
  /** Open the pipeline run in Runs. Absent means the host cannot, so nothing is drawn. */
  onOpenPipelineRun?: () => void;
}): React.JSX.Element {
  const link = session.pipeline;
  // Hooks run unconditionally, so this is called on every session including the ones with no
  // pipeline at all - which is why it takes nulls and answers `loading` without a request.
  const detail = usePipelineRunDetail(
    link?.provider ?? null,
    link?.repoRoot ?? null,
    link?.slug ?? null,
    pipelineRun?.updatedAt ?? 0,
  );

  if (link) {
    return (
      <PipelineLadder
        link={link}
        run={pipelineRun}
        gates={detail.state === "ready" ? detail.detail.gates : []}
        onOpenRun={() => onOpenPipelineRun?.()}
      />
    );
  }

  return (
    <>
      {run && (
        <WorkflowLadderPanel run={run} session={session} onOpenRun={() => onOpenRun(run.id)} />
      )}
      {!run && <p className="detail-empty">No workflow is bound to this session.</p>}
    </>
  );
}
