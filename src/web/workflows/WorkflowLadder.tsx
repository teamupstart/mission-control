import type { WorkflowRunDetail, WorkflowRunSummary } from "@shared/workflow.ts";
import {
  nodeLabel,
  projectStages,
  stageName,
  stageSummary,
} from "@shared/workflow-stages.ts";
import { duration } from "../lib/format.ts";
import {
  WorkflowChip,
  workflowRunTone,
} from "../components/session-bits.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import type { PipelineStatus } from "./pipeline-bits.tsx";
import {
  checkOutcomeOf,
  checkStatus,
  checkStatusView,
  deliveryStateView,
  endStatus,
  gateSummaryStatus,
  gateWaitSentence,
  inspectorOnlyRoundSentence,
  latestAttemptsFor,
  nodeStatusesForSubmission,
  reviewerStatus,
  runStatusLabel,
  selectedSubmission,
  shortSha,
  stageStatus,
  submissionStatus,
  verdictMeta,
  verdictOf,
} from "./run-model.ts";
import { useWorkflowRunDetail } from "./useWorkflowRunDetail.ts";

interface WorkflowLadderProps {
  summary: WorkflowRunSummary;
  detail: WorkflowRunDetail;
  onOpenRun: () => void;
}

function rungState(status: PipelineStatus, pending = false): string {
  if (status.tone === "passed") return "is-passed";
  if (status.tone === "running") return "is-running";
  if (status.tone === "failed") return "is-failed";
  return pending ? "is-pending" : "is-waiting";
}

function statusGlyph(status: PipelineStatus): string {
  if (status.degraded) return "○";
  if (status.tone === "passed") return "✓";
  if (status.tone === "failed") return "×";
  if (status.tone === "running") return "●";
  return "○";
}

function Rung({
  name,
  sub = null,
  status,
  terminal = false,
  pending = false,
  children = null,
}: {
  name: string;
  sub?: string | null;
  status: PipelineStatus;
  terminal?: boolean;
  pending?: boolean;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <li
      className={[
        "wf-ladder-rung",
        `workflow-${status.tone}`,
        rungState(status, pending),
        terminal ? "is-terminal" : "",
      ].filter(Boolean).join(" ")}
    >
      <div className="wf-ladder-row">
        <span className="wf-ladder-title">
          <strong>{name}</strong>
          {sub && <span className="wf-ladder-sub">{sub}</span>}
        </span>
        <span className="wf-ladder-state">{status.label}</span>
      </div>
      {children}
    </li>
  );
}

/**
 * One workflow run, projected onto a compact vertical reading of its authored stages.
 *
 * This is deliberately a pure renderer. Fetch ownership stays in `WorkflowLadderPanel`, so
 * tests and later phases can provide literal run detail without opening a second client path.
 */
export function WorkflowLadder({
  summary,
  detail,
  onOpenRun,
}: WorkflowLadderProps): React.JSX.Element {
  const submission = selectedSubmission(detail, null);
  const attempts = latestAttemptsFor(detail, submission?.id ?? null);
  const statuses = nodeStatusesForSubmission(detail, submission?.id ?? null);
  const pipeline = detail.version ? projectStages(detail.version.graph) : null;

  if (pipeline === null) {
    return (
      <section className="wf-ladder-fallback" aria-label="Workflow run">
        <WorkflowChip run={summary} onOpen={onOpenRun} />
        <Tooltip label="Open this workflow in Runs">
          <button className="wf-ladder-open" type="button" onClick={onOpenRun}>
            Open run
          </button>
        </Tooltip>
      </section>
    );
  }

  const graph = detail.version!.graph;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const personaNames = graph.nodes.flatMap((node) =>
    node.kind === "persona" && "persona" in node
      ? [{ id: node.persona.sourcePersonaId, name: node.persona.name }]
      : []);
  const calls = detail.llmCalls ?? [];
  const changesRequested = [...attempts.values()]
    .some((attempt) => verdictOf(attempt)?.verdict === "fail");
  const session = submissionStatus(submission, changesRequested);
  const end = endStatus(detail, submission, true);
  const inspectorOnly = submission?.mode === "inspector_only";
  const gate = detail.inspectorGate
    && detail.inspectorGate.state.waitReason !== null
    ? detail.inspectorGate
    : null;
  const uncertain = detail.deliveries.find((delivery) => delivery.state === "uncertain");
  const delivery = uncertain ? deliveryStateView(uncertain.state) : null;

  return (
    <section className="wf-ladder-panel" aria-label={`${summary.workflowName} workflow stages`}>
      <header className="wf-ladder-head">
        <span className="wf-ladder-name">⌁ {summary.workflowName}</span>
        <span className="wf-ladder-version">v{summary.workflowVersion}</span>
        <span className={`wf-ladder-runstate workflow-${workflowRunTone(summary)}`}>
          {runStatusLabel(summary.status)}
        </span>
        <span className="wf-ladder-round">
          round {summary.round} / {summary.maxRepairRounds}
        </span>
      </header>

      {inspectorOnly && (
        <p className="wf-ladder-bypass">{inspectorOnlyRoundSentence()}</p>
      )}

      <ul className="wf-ladder">
        <Rung name="Session" status={session} terminal />

        {pipeline.stages.map((stage, index) => {
          const members = stage.members.map((member) => {
            const nodeId = member.nodeId;
            const node = nodeId ? nodes.get(nodeId) : undefined;
            const attempt = nodeId ? attempts.get(nodeId) : undefined;
            const outcome = attempt ? checkOutcomeOf(attempt) : null;
            const status = member.kind === "check"
              ? checkStatus(nodeId ? statuses[nodeId] : undefined, outcome?.status ?? null)
              : reviewerStatus(nodeId ? statuses[nodeId] : undefined);
            const name = node
              ? nodeLabel(graph, node, personaNames)
              : member.kind === "check" ? `Check · ${member.slot}` : "Missing persona";
            const verdict = attempt ? verdictOf(attempt) : null;
            const meta = attempt ? verdictMeta(attempt, calls) : null;
            return { member, name, attempt, outcome, status, verdict, meta };
          });
          const status = stageStatus(members.map((member) => member.status));
          const expanded = status.tone === "running"
            || status.tone === "failed"
            || members.some((member) => member.status.degraded);
          const objection = members.find((member) => member.verdict?.verdict === "fail");

          return (
            <Rung
              key={stage.joinId ?? `stage:${index}`}
              name={stageName(stage, index, personaNames)}
              sub={stageSummary(stage)}
              status={status}
            >
              {expanded && (
                <ul className="wf-ladder-members">
                  {members.map((member) => {
                    const checkExplanation = member.status.degraded
                      && member.outcome
                      ? checkStatusView(member.outcome.status).sentence
                      : null;
                    const meta = member.meta
                      ? [
                          member.verdict
                            ? `${Math.round(member.verdict.confidence * 100)}% confident`
                            : null,
                          member.meta.durationMs === null
                            ? null
                            : duration(member.meta.durationMs),
                          member.meta.costUsd === null
                            ? null
                            : `$${member.meta.costUsd.toFixed(4)}`,
                        ].filter((part): part is string => part !== null).join(" · ")
                      : "";
                    return (
                      <li
                        className={`wf-ladder-member workflow-${member.status.tone}`}
                        key={member.member.nodeId
                          ?? `${index}:${member.member.kind === "check"
                            ? member.member.slot
                            : member.member.personaId}`}
                      >
                        <span className="wf-ladder-member-row">
                          <span className="wf-ladder-member-mark" aria-hidden>
                            {statusGlyph(member.status)}
                          </span>
                          <span className="wf-ladder-member-name">{member.name}</span>
                          <span className="wf-ladder-member-state">{member.status.label}</span>
                        </span>
                        {meta && <span className="wf-ladder-member-meta">{meta}</span>}
                        {checkExplanation && (
                          <span className="wf-ladder-member-note">{checkExplanation}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {objection?.verdict?.verdict === "fail" && (
                <p className="wf-ladder-why">
                  <strong>{objection.name}:</strong> {objection.verdict.summary}
                </p>
              )}
            </Rung>
          );
        })}

        {gate && (
          <Rung
            name="Inspector gate"
            status={gateSummaryStatus(summary.gate)}
          >
            <p className="wf-ladder-sentence">
              {gateWaitSentence(gate.state.waitReason)}
            </p>
            <dl className="wf-ladder-meta">
              <div>
                <dt>pull request</dt>
                <dd>{summary.gatePrNumber ? `#${summary.gatePrNumber}` : "not resolved"}</dd>
              </div>
              <div>
                <dt>target head</dt>
                <dd>{shortSha(summary.gateHeadShort) ?? "not pinned"}</dd>
              </div>
              <div>
                <dt>posture</dt>
                <dd>{summary.reviewPosture ?? "unknown"}</dd>
              </div>
            </dl>
          </Rung>
        )}

        {delivery && (
          <Rung
            name="Repair delivery"
            status={{ tone: "waiting", label: delivery.label }}
          >
            <p className="wf-ladder-sentence">{delivery.sentence}</p>
          </Rung>
        )}

        <Rung
          name={pipeline.endOutcome}
          status={end}
          terminal
          pending={end.tone === "waiting"}
        />
      </ul>

      <div className="wf-ladder-actrow">
        <Tooltip label="Open this workflow in Runs">
          <button className="wf-ladder-open" type="button" onClick={onOpenRun}>
            Open run
          </button>
        </Tooltip>
      </div>
    </section>
  );
}

export function WorkflowLadderPanel({
  run,
  onOpenRun,
}: {
  run: WorkflowRunSummary;
  onOpenRun: () => void;
}): React.JSX.Element {
  const state = useWorkflowRunDetail(run.id, run.updatedAt);
  if (state.state === "loading") {
    return (
      <section className="wf-ladder-feedback" aria-busy="true">
        Loading workflow stages…
      </section>
    );
  }
  if (state.state === "error") {
    return (
      <section className="wf-ladder-feedback" role="alert">
        <p className="wf-ladder-error">{state.message}</p>
        <Tooltip label="Open this workflow in Runs">
          <button className="wf-ladder-open" type="button" onClick={onOpenRun}>
            Open run
          </button>
        </Tooltip>
      </section>
    );
  }
  return <WorkflowLadder summary={run} detail={state.detail} onOpenRun={onOpenRun} />;
}
