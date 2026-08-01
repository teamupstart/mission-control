import type { WorkflowRunDetail, WorkflowRunSummary } from "@shared/workflow.ts";
import {
  nodeLabel,
  projectStages,
  stageMembers,
  stageName,
  stageSummary,
} from "@shared/workflow-stages.ts";
import { workflowRunLabel, workflowRunTone } from "../components/session-bits.tsx";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import {
  checkOutcomeOf,
  checkStatus,
  checkStatusView,
  deliveryStateView,
  endStatus,
  gateSummaryStatus,
  gateWaitSentence,
  latestAttemptsFor,
  nodeStatusesForSubmission,
  reviewerStatus,
  selectedSubmission,
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

function peekPriority(stage: StagePeek): number {
  if (stage.status.tone === "failed") return 0;
  if (stage.status.tone === "running") return 1;
  if (stage.status.degraded) return 2;
  if (stage.status.tone === "waiting") return 3;
  return 4;
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
      name: "Inspector gate",
      sub: facts.join(" · ") || null,
      status: gateSummaryStatus(summary.gate),
      members: [],
      sentence: gateWaitSentence(gate.state.waitReason),
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

  if (submission.mode === "inspector_only") {
    return {
      name: "Session",
      sub: "Inspector-only round",
      status: submissionStatus(submission, changesRequested),
      members: [],
      sentence: null,
    };
  }

  const stages: StagePeek[] = pipeline.stages.map((stage, index) => {
    let sentence: string | null = null;
    let degradedSentence: string | null = null;
    const members = stageMembers(stage).map((member, memberIndex) => {
      const nodeId = member.nodeId;
      const node = nodeId ? nodes.get(nodeId) : undefined;
      const attempt = nodeId ? attempts.get(nodeId) : undefined;
      const outcome = attempt ? checkOutcomeOf(attempt) : null;
      const status = member.kind === "check"
        ? checkStatus(nodeId ? statuses[nodeId] : undefined, outcome?.status ?? null)
        : reviewerStatus(nodeId ? statuses[nodeId] : undefined);
      const name = node
        ? nodeLabel(graph, node, personaNames, actionNames)
        : member.kind === "check"
          ? `Check · ${member.slot}`
          : member.kind === "session_action" ? "Missing session action" : "Missing persona";
      const verdict = attempt ? verdictOf(attempt) : null;
      if (sentence === null && verdict?.verdict === "fail") {
        sentence = `${name}: ${verdict.summary}`;
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
    return {
      index,
      name: stageName(stage, index, personaNames, actionNames),
      sub: stageSummary(stage),
      status: stageStatus(members.map((member) => member.status)),
      members,
      sentence,
      degradedSentence,
    };
  });

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
      }
    : {
        name: pipeline.endOutcome,
        sub: null,
        status: end,
        members: [],
        sentence: null,
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

export function WorkflowLadderPeek({
  summary,
  detail,
}: {
  summary: WorkflowRunSummary;
  detail: WorkflowRunDetail;
}): React.JSX.Element {
  const view = workflowLadderPeekView(summary, detail);
  const sentence = view?.sentence ? splitSentence(view.sentence) : null;
  return (
    <section
      className={`wf-tile-peek workflow-${view?.status.tone ?? workflowRunTone(summary)}`}
      aria-label={`${summary.workflowName}: ${workflowRunLabel(summary)}`}
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
        </div>
      ) : (
        <p className="wf-tile-peek-unavailable">This workflow has no stage-shaped preview.</p>
      )}
    </section>
  );
}

export function WorkflowLadderPeekPlaceholder({
  summary,
  error = false,
}: {
  summary: WorkflowRunSummary;
  error?: boolean;
}): React.JSX.Element {
  return (
    <section
      className={`wf-tile-peek workflow-${workflowRunTone(summary)} is-placeholder`}
      aria-label={`${summary.workflowName}: ${workflowRunLabel(summary)}`}
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
    </section>
  );
}
