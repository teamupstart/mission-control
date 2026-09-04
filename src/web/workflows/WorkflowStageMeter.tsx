import type { WorkflowRunSummary } from "@shared/workflow.ts";
import { workflowRunHasNoRepairsLeft } from "@shared/workflow.ts";
import { SegmentMeter } from "../components/SegmentMeter.tsx";
import { workflowRunTone } from "../components/session-bits.tsx";
import type { StagePeek, WorkflowLadderPeekView } from "./WorkflowLadderPeek.tsx";

function resolvedWithoutRunning(stage: StagePeek): boolean {
  return stage.status.skipKind === "carried_pass" || stage.status.degraded === true;
}

function stageFillPercent(stage: StagePeek): number {
  if (resolvedWithoutRunning(stage)) return 100;
  return stage.status.tone === "waiting" || stage.status.tone === "stopped" ? 0 : 100;
}

function clearedStageCount(stages: readonly StagePeek[]): number {
  return stages.filter((stage) =>
    stage.status.tone === "passed" || resolvedWithoutRunning(stage)
  ).length;
}

export function RepairRoundMeter({ summary }: { summary: WorkflowRunSummary }): React.JSX.Element {
  const noRepairsLeft = workflowRunHasNoRepairsLeft(summary);
  const currentTone = workflowRunTone(summary);
  const roundCount = summary.maxRepairRounds + 1;

  return (
    <span className="wf-repair-meter" role="group" aria-label="Repair-round budget">
      <span className="wf-repair-label">rounds</span>
      <span className="wf-repair-pips">
        {Array.from({ length: roundCount }, (_, index) => {
          const round = index + 1;
          const spent = round < summary.round;
          const current = round === summary.round;
          const state = spent
            ? "spent"
            : current
              ? noRepairsLeft ? "current, no repairs left" : "current"
              : "available";
          return (
            <span
              key={round}
              className={`wf-repair-pip${spent ? " is-spent" : ""}${
                current ? ` is-current workflow-${currentTone}` : ""
              }`}
              role="img"
              aria-label={`Round ${round}: ${state}`}
            />
          );
        })}
      </span>
      <span className="wf-repair-count">R{summary.round} / {summary.maxRepairRounds}</span>
      {noRepairsLeft && <span className="wf-repair-none">no repairs left</span>}
    </span>
  );
}

/** The stage-shaped Board summary: whole pipeline, active caption, then repair budget. */
export function WorkflowStageMeter({
  summary,
  stages,
  active,
}: {
  summary: WorkflowRunSummary;
  stages: readonly StagePeek[];
  active: WorkflowLadderPeekView;
}): React.JSX.Element {
  return (
    <span className="wf-stage-meter">
      <span className="wf-stage-track-row">
        <SegmentMeter
          segments={stages.map((stage) => ({
            key: stage.index,
            tone: stage.status.tone,
            fillPercent: stageFillPercent(stage),
            grow: 1,
            current: stage.index === active.stageIndex,
            degraded: resolvedWithoutRunning(stage),
            accessibleLabel: `${stage.name}: ${stage.status.label}`,
            // The whole card is already one link. Named images keep each stage readable
            // without putting invalid nested tab stops inside that link.
            focusable: false,
            role: "img",
            tooltip: `${stage.name}: ${stage.status.label}`,
          }))}
        />
        <span className="wf-stage-count">
          {clearedStageCount(stages)} / {stages.length} stages
        </span>
      </span>
      <span className="wf-stage-caption">
        <strong>{active.name}</strong>
        <span className={`workflow-${active.status.tone}`}>{active.status.label}</span>
      </span>
      <RepairRoundMeter summary={summary} />
    </span>
  );
}
