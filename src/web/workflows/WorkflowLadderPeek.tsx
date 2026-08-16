import type { WorkflowRunDetail, WorkflowRunSummary } from "@shared/workflow.ts";
import {
  nodeLabel,
  projectStages,
  stageMembers,
  stageName,
  stageSummary,
} from "@shared/workflow-stages.ts";
import { workflowRunLabel, workflowRunTone } from "../components/session-bits.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { isDragSelection } from "../lib/pointer.ts";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import type { InheritedPass } from "./run-model.ts";
import {
  actionBlockSentence,
  actionWaitSentence,
  carriedStageStatus,
  carriedStatus,
  checkOutcomeOf,
  checkStatus,
  checkStatusView,
  deliveryStateView,
  endStatus,
  gateSummaryStatus,
  gateWaitSentence,
  inheritedPasses,
  latestAttemptsFor,
  newestInheritedSource,
  nodeStatusesForSubmission,
  reviewerStatus,
  selectedSubmission,
  sessionActionProgress,
  sessionActionStatus,
  shortSha,
  stageStatus,
  submissionStatus,
  verdictOf,
} from "./run-model.ts";

export interface WorkflowLadderPeekMember {
  key: string;
  name: string;
  status: PipelineStatus;
}

export interface WorkflowLadderPeekView {
  name: string;
  sub: string | null;
  status: PipelineStatus;
  members: WorkflowLadderPeekMember[];
  sentence: string | null;
  /** `3 stages carried from Round 1 · evidence 1`, or null when this round ran them all. */
  carried: string | null;
}

interface StagePeek {
  index: number;
  name: string;
  sub: string;
  status: PipelineStatus;
  members: WorkflowLadderPeekMember[];
  sentence: string | null;
  degradedSentence: string | null;
}

/**
 * Which rung is worth the tile's one slot.
 *
 * A CARRIED stage sorts as resolved rather than as a wait, and that ordering is the whole
 * correctness of this function on a continuation segment. Carried stages have no attempt in the
 * viewed submission, so before this they fell through to amber `waiting` and won the sort ahead
 * of the action actually running - the tile named "Stage 1", a stage that had already passed
 * and would never run again, while the Pull Request below it was the live work. A tile that
 * points at the wrong rung is worse than one that points at nothing.
 */
function peekPriority(stage: StagePeek): number {
  if (stage.status.tone === "failed") return 0;
  if (stage.status.tone === "running") return 1;
  if (stage.status.degraded) return 2;
  if (stage.status.skipKind === "carried_pass") return 4;
  if (stage.status.tone === "waiting") return 3;
  return 4;
}

/** The tile's one line about everything this round did not have to run again. */
function carriedLine(passes: readonly InheritedPass[], stages: number): string | null {
  if (stages === 0) return null;
  const source = newestInheritedSource(passes);
  if (!source) return null;
  return `${stages} stage${stages === 1 ? "" : "s"} carried from ${source.roundLabel}`;
}

/**
 * The one rung worth spending Board height on.
 *
 * This is a projection over the same helpers the full ladder uses. It does not invent a second
 * workflow status vocabulary: an uncertain delivery wins, then the Inspector gate, then the
 * first failed/running/degraded stage. A healthy run falls through to its next end state.
 */
export function workflowLadderPeekView(
  summary: WorkflowRunSummary,
  detail: WorkflowRunDetail,
): WorkflowLadderPeekView | null {
  const uncertain = detail.deliveries.find((delivery) => delivery.state === "uncertain");
  if (uncertain) {
    const view = deliveryStateView(uncertain.state);
    return {
      name: "Repair delivery",
      sub: null,
      status: { tone: "waiting", label: view.label },
      members: [],
      sentence: view.sentence,
      carried: null,
    };
  }

  const gate = detail.inspectorGate
    && detail.inspectorGate.state.waitReason !== null
    ? detail.inspectorGate
    : null;
  if (gate) {
    const facts = [
      summary.gatePrNumber ? `PR #${summary.gatePrNumber}` : null,
      shortSha(summary.gateHeadShort)
        ? `head ${shortSha(summary.gateHeadShort)}`
        : null,
    ].filter((fact): fact is string => fact !== null);
    return {
      name: "GitHub Inspector gate",
      sub: facts.join(" · ") || null,
      status: gateSummaryStatus(summary.gate),
      members: [],
      sentence: gateWaitSentence(gate.state.waitReason),
      carried: null,
    };
  }

  const submission = selectedSubmission(detail, null);
  const pipeline = detail.version ? projectStages(detail.version.graph) : null;
  if (!pipeline || !submission) return null;

  const graph = detail.version!.graph;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const personaNames = graph.nodes.flatMap((node) =>
    node.kind === "persona" && "persona" in node
      ? [{ id: node.persona.sourcePersonaId, name: node.persona.name }]
      : []);
  const actionNames = graph.nodes.flatMap((node) =>
    node.kind === "session_action" && "action" in node
      ? [{ id: node.action.sourceSessionActionId, name: node.action.name }]
      : []);
  const attempts = latestAttemptsFor(detail, submission.id);
  const statuses = nodeStatusesForSubmission(detail, submission.id);
  const changesRequested = [...attempts.values()]
    .some((attempt) => verdictOf(attempt)?.verdict === "fail");
  const inherited = inheritedPasses(detail, submission);

  if (submission.mode === "inspector_only") {
    return {
      name: "Session",
      sub: "GitHub Inspector-only round",
      status: submissionStatus(submission, changesRequested),
      members: [],
      sentence: null,
      // Counted in STAGES rather than nodes, so the tile and the ladder beside it agree on
      // what a unit is. An Inspector-only round bypasses whole stages at a time.
      carried: carriedLine(
        [...inherited.values()],
        pipeline.stages.filter((stage) => {
          const ids = stageMembers(stage).flatMap((member) =>
            member.nodeId ? [member.nodeId] : []);
          return ids.length > 0 && ids.every((id) => inherited.has(id));
        }).length,
      ),
    };
  }

  let carriedStages = 0;
  const stages: StagePeek[] = pipeline.stages.map((stage, index) => {
    let sentence: string | null = null;
    let degradedSentence: string | null = null;
    const stageCarriedPasses: InheritedPass[] = [];
    const members = stageMembers(stage).map((member, memberIndex) => {
      const nodeId = member.nodeId;
      const node = nodeId ? nodes.get(nodeId) : undefined;
      const attempt = nodeId ? attempts.get(nodeId) : undefined;
      const carried = nodeId ? inherited.get(nodeId) ?? null : null;
      if (carried) stageCarriedPasses.push(carried);
      const outcome = attempt ? checkOutcomeOf(attempt) : null;
      // Not gated on `waiting`, for the full ladder's reason: a block is `state: "error"`.
      const actionState = member.kind === "session_action" && attempt
        ? sessionActionProgress(attempt)
        : null;
      const status = carried
        ? carriedStatus(carried.roundLabel)
        : member.kind === "session_action"
          ? sessionActionStatus(nodeId ? statuses[nodeId] : undefined, actionState?.wait ?? null)
          : member.kind === "check"
            ? checkStatus(nodeId ? statuses[nodeId] : undefined, outcome?.status ?? null)
            : reviewerStatus(nodeId ? statuses[nodeId] : undefined);
      const name = node
        ? nodeLabel(graph, node, personaNames, actionNames)
        : member.kind === "check"
          ? `Command · ${member.slot}`
          : member.kind === "session_action" ? "Missing session action" : "Missing persona";
      const verdict = attempt ? verdictOf(attempt) : null;
      if (sentence === null && verdict?.verdict === "fail") {
        sentence = `${name}: ${verdict.summary}`;
      }
      // The peek shows ONE sentence, and a running action's is the most useful thing on the
      // tile: the stage is moving, so no failure sentence exists to claim the slot, and
      // without this the card reads "Session working" with nothing saying on what.
      if (sentence === null && actionState?.blocked) {
        sentence = `${name}: ${actionBlockSentence(actionState.blocked.code)}`;
      } else if (sentence === null && actionState?.wait) {
        sentence = `${name}: ${actionWaitSentence(actionState.wait)}`;
      }
      if (degradedSentence === null && status.degraded && outcome) {
        degradedSentence = checkStatusView(outcome.status).sentence;
      }
      return {
        key: nodeId ?? `${index}:${memberIndex}:${name}`,
        name,
        status,
      };
    });
    const stageCarried = members.length > 0 && stageCarriedPasses.length === members.length;
    if (stageCarried) carriedStages += 1;
    return {
      index,
      name: stageName(stage, index, personaNames, actionNames),
      sub: stageSummary(stage),
      status: stageCarried
        ? carriedStageStatus(stageCarriedPasses.map((pass) => pass.roundLabel))
        : stageStatus(members.map((member) => member.status), stage.kind),
      members,
      sentence,
      degradedSentence,
    };
  });

  const carried = carriedLine([...inherited.values()], carriedStages);
  const active = stages
    .slice()
    .sort((left, right) => peekPriority(left) - peekPriority(right) || left.index - right.index)[0];
  if (active && peekPriority(active) < 4) {
    return {
      name: active.name,
      sub: active.sub,
      status: active.status,
      members: active.members,
      sentence: active.sentence ?? active.degradedSentence,
      carried,
    };
  }

  const end = endStatus(detail, submission, true);
  if (end.tone !== "passed") {
    return {
      name: pipeline.endOutcome,
      sub: null,
      status: end,
      members: [],
      sentence: null,
      carried,
    };
  }

  const lastStage = stages.at(-1);
  return lastStage
    ? {
        name: lastStage.name,
        sub: lastStage.sub,
        status: lastStage.status,
        members: lastStage.members,
        sentence: lastStage.sentence ?? lastStage.degradedSentence,
        carried,
      }
    : {
        name: pipeline.endOutcome,
        sub: null,
        status: end,
        members: [],
        sentence: null,
        carried,
      };
}

function glyph(status: PipelineStatus): string {
  if (status.degraded) return "○";
  if (status.tone === "passed") return "✓";
  if (status.tone === "failed") return "×";
  if (status.tone === "running") return "●";
  return "○";
}

function splitSentence(sentence: string): { lead: string | null; rest: string } {
  const colon = sentence.indexOf(":");
  if (colon < 1) return { lead: null, rest: sentence };
  return {
    lead: sentence.slice(0, colon + 1),
    rest: sentence.slice(colon + 1).trimStart(),
  };
}

/**
 * Keep an ordinary primary click on App's single run opener, while preserving the native link
 * contract for opening a run in another tab. The href is the durable fallback; the callback is
 * the in-app path that owns navigation history and any route state worth carrying forward.
 */
function followRunLink(
  event: React.MouseEvent<HTMLAnchorElement>,
  onOpenRun: () => void,
): void {
  event.stopPropagation();
  if (isDragSelection(window.getSelection())) {
    event.preventDefault();
    return;
  }
  if (
    event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
  ) return;
  event.preventDefault();
  onOpenRun();
}

export function WorkflowLadderPeek({
  summary,
  detail,
  onOpenRun,
}: {
  summary: WorkflowRunSummary;
  detail: WorkflowRunDetail;
  onOpenRun: () => void;
}): React.JSX.Element {
  const view = workflowLadderPeekView(summary, detail);
  const sentence = view?.sentence ? splitSentence(view.sentence) : null;
  return (
    <Tooltip label={`Open ${summary.workflowName} v${summary.workflowVersion} in Runs`}>
      <a
        href={`#/runs/${encodeURIComponent(summary.id)}`}
        className={`wf-tile-peek workflow-${view?.status.tone ?? workflowRunTone(summary)}`}
        aria-label={`Open ${summary.workflowName} v${summary.workflowVersion} workflow run: ${workflowRunLabel(summary)}`}
        onClick={(event) => followRunLink(event, onOpenRun)}
      >
        <header className="wf-tile-peek-head">
          <span className="wf-tile-peek-name">⌁ {summary.workflowName}</span>
          <span className="wf-tile-peek-version">v{summary.workflowVersion}</span>
          <span className={`wf-tile-peek-runstate workflow-${workflowRunTone(summary)}`}>
            {workflowRunLabel(summary)}
          </span>
          <span className="wf-tile-peek-round">R{summary.round} / {summary.maxRepairRounds}</span>
        </header>
        {view ? (
          <div className="wf-tile-peek-rung">
            <div className="wf-tile-peek-row">
              <span className="wf-tile-peek-title">
                <strong>{view.name}</strong>
                {view.sub && <span>{view.sub}</span>}
              </span>
              <span className="wf-tile-peek-state">{view.status.label}</span>
            </div>
            {view.members.length > 0 && (
              <div className="wf-tile-peek-members">
                {view.members.map((member) => (
                  <span className={`workflow-${member.status.tone}`} key={member.key}>
                    <span aria-hidden>{glyph(member.status)}</span> {member.name}
                  </span>
                ))}
              </div>
            )}
            {sentence && (
              <p className="wf-tile-peek-sentence">
                {sentence.lead && <strong>{sentence.lead}</strong>}{" "}
                {sentence.rest}
              </p>
            )}
            {/* Last, and outside the rung's own reading: it is about the stages this tile is
                NOT showing, so putting it above the active rung would answer a question the
                reader has not asked yet. */}
            {view.carried && (
              <p className="wf-tile-peek-carried">
                <span className="wf-carried-tick" aria-hidden>✓</span> {view.carried}
              </p>
            )}
          </div>
        ) : (
          <p className="wf-tile-peek-unavailable">This workflow has no stage-shaped preview.</p>
        )}
      </a>
    </Tooltip>
  );
}

export function WorkflowLadderPeekPlaceholder({
  summary,
  error = false,
  onOpenRun,
}: {
  summary: WorkflowRunSummary;
  error?: boolean;
  onOpenRun: () => void;
}): React.JSX.Element {
  return (
    <Tooltip label={`Open ${summary.workflowName} v${summary.workflowVersion} in Runs`}>
      <a
        href={`#/runs/${encodeURIComponent(summary.id)}`}
        className={`wf-tile-peek workflow-${workflowRunTone(summary)} is-placeholder`}
        aria-label={`Open ${summary.workflowName} v${summary.workflowVersion} workflow run: ${workflowRunLabel(summary)}`}
        onClick={(event) => followRunLink(event, onOpenRun)}
      >
        <header className="wf-tile-peek-head">
          <span className="wf-tile-peek-name">⌁ {summary.workflowName}</span>
          <span className="wf-tile-peek-version">v{summary.workflowVersion}</span>
          <span className={`wf-tile-peek-runstate workflow-${workflowRunTone(summary)}`}>
            {workflowRunLabel(summary)}
          </span>
          <span className="wf-tile-peek-round">R{summary.round} / {summary.maxRepairRounds}</span>
        </header>
        <p className="wf-tile-peek-unavailable">
          {error ? "Stage detail is unavailable." : "Loading the current stage…"}
        </p>
      </a>
    </Tooltip>
  );
}
