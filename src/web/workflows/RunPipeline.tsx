import { useCallback, useMemo } from "react";
import type { WorkflowCheckStatus, WorkflowVersion } from "@shared/workflow.ts";
import {
  nodeLabel,
  projectStages,
  stageName,
  stageSummary,
  type StageNode,
} from "@shared/workflow-stages.ts";
import {
  PipelineFrame,
  ReviewerRow,
  StageCard,
  StageSeam,
  TerminusCard,
  type PipelineStatus,
} from "./pipeline-bits.tsx";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";
import { checkStatus, reviewerStatus, stageStatus } from "./run-model.ts";

/**
 * The run, drawn on the pipeline its author drew.
 *
 * The same leaves the editor uses (`pipeline-bits.tsx`), fed the immutable published graph
 * and a node-id -> runtime status map the reader already computed. That sameness is the
 * point of the whole migration: an operator authored Session -> stage -> End and watches
 * Session -> stage -> End, rather than authoring one shape and reading a wall of sections
 * headed by node ids.
 *
 * A version whose graph is NOT stage-expressible still renders - on the read-only canvas
 * this surface used before, with the same statuses. Hand-built graphs predate stages and a
 * run of one must not become unwatchable; the canvas is the fallback the plan's adopted
 * decision 2 keeps alive for exactly this.
 */
export function RunPipeline({
  version,
  statuses,
  session,
  end,
  metaFor,
  checkOutcomeFor,
  repair,
  disabledNodeIds,
  disabledChipFor,
  onToggleNodes,
}: {
  version: WorkflowVersion;
  /** Node id -> runtime status, scoped to the round being viewed. */
  statuses: Record<string, string>;
  session: PipelineStatus;
  end: PipelineStatus;
  /** The `runner · model` line for one reviewer, or null when nothing ran yet. */
  metaFor: (nodeId: string) => string | null;
  /**
   * The outcome a check RECORDED, which the attempt state cannot supply.
   *
   * A skipped or unavailable check still finishes as a passing attempt, so without this the
   * chip would report "Passed" for a command that was never spawned. Optional so the canvas
   * fallback and older callers keep compiling; a caller that omits it simply loses the
   * distinction rather than asserting the wrong half of it.
   */
  checkOutcomeFor?: (nodeId: string) => WorkflowCheckStatus | null;
  repair: string | null;
  /**
   * Verdict node ids the operator disabled FOR THIS RUN. Absent reads as none. Drives the
   * row's red treatment, its ⊘ mark and the toggle's direction - the control's CURRENT
   * state - never the member's chip, which stays the viewed round's history.
   */
  disabledNodeIds?: readonly string[];
  /**
   * The Disabled chip for one member, or null when the viewed round's real outcome must
   * show (see `disabledStatusFor`). Owned by the caller because deciding it takes the
   * round's attempts, which this component deliberately never holds.
   */
  disabledChipFor?: (nodeId: string) => PipelineStatus | null;
  /**
   * Toggle the per-run auto-pass on one member (a row click) or a whole stage (a header
   * click). Supplied only while the run can still be affected; when absent the rows are
   * plain and the disabled set renders read-only, which is what a finished run shows.
   */
  onToggleNodes?: (nodeIds: string[], disabled: boolean) => void;
}): React.JSX.Element {
  const graph = version.graph;
  const pipeline = useMemo(() => projectStages(graph), [graph]);
  // Memoised for the reason `WorkflowLibrary` memoises its own: the canvas lists this in the
  // dependency array of the projection it syncs into React Flow's store from an effect, so a
  // fresh closure per render re-runs that sync per render.
  const labelFor = useCallback(
    (node: StageNode): string => nodeLabel(graph, node, []),
    [graph],
  );
  const nodes = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph],
  );
  const disabledSet = useMemo(
    () => new Set(disabledNodeIds ?? []),
    [disabledNodeIds],
  );

  if (!pipeline) {
    return (
      <div className="wf-run-graph">
        <p className="wf-run-graph-note">
          This version was drawn freehand rather than as stages, so the run is shown on its
          graph.
        </p>
        <WorkflowCanvas
          graph={graph}
          personas={[]}
          labelFor={labelFor}
          readOnly
          nodeStatuses={statuses}
        />
      </div>
    );
  }

  const personaNames = graph.nodes.flatMap((node) =>
    node.kind === "persona" && "persona" in node
      ? [{ id: node.persona.sourcePersonaId, name: node.persona.name }]
      : []);

  return (
    <PipelineFrame ariaLabel="Workflow run pipeline" repair={repair}>
      <TerminusCard
        kind="session"
        name="Session"
        subtitle="Submits the work"
        status={session}
      />
      <StageSeam gate="submitted" />
      {pipeline.stages.map((stage, index) => {
        const members = stage.members.map((member) => {
          const node = member.nodeId ? nodes.get(member.nodeId) : undefined;
          const disabled = member.nodeId ? disabledSet.has(member.nodeId) : false;
          return {
            key: member.nodeId
              ?? `${index}:${member.kind === "check" ? member.slot : member.personaId}`,
            nodeId: member.nodeId,
            kind: member.kind,
            disabled,
            // A check's row carries the bare slot and its own chip, the way the editor draws
            // it - `nodeLabel` would supply "Check · test", which the chip would then say
            // again. A Persona keeps the snapshot name the version was published with.
            name: member.kind === "check"
              ? member.slot
              : node ? nodeLabel(graph, node, personaNames) : "Missing persona",
            meta: member.nodeId ? metaFor(member.nodeId) : null,
            // The chip is the viewed round's history: Disabled only when the auto-pass
            // will convert (or synthesized) this node's attempt, never over an outcome the
            // round already reached - a recorded failure painted as Disabled would claim
            // the toggle rewrote it. The row's red treatment carries the control's state.
            status: (member.nodeId ? disabledChipFor?.(member.nodeId) ?? null : null)
              ?? (member.kind === "check"
                ? checkStatus(
                    member.nodeId ? statuses[member.nodeId] : undefined,
                    member.nodeId ? checkOutcomeFor?.(member.nodeId) ?? null : null,
                  )
                : reviewerStatus(member.nodeId ? statuses[member.nodeId] : undefined)),
          };
        });
        const parallel = stage.members.length > 1;
        // The stage toggle needs every member addressable; a projection member without a
        // node id (a compile-time placeholder) leaves the stage header unswitchable.
        const stageNodeIds = members.flatMap((member) => member.nodeId ? [member.nodeId] : []);
        const stageDisabled = members.length > 0 && members.every((member) => member.disabled);
        const stageTitle = stageName(stage, index, personaNames);
        return (
          <div className="wf-pipeline-slot" key={`stage:${index}`}>
            <StageCard
              name={stageTitle}
              subtitle={stageSummary(stage)}
              status={stageStatus(members.map((member) => member.status))}
              disabled={stageDisabled}
              onToggleDisabled={onToggleNodes && stageNodeIds.length === members.length
                ? () => onToggleNodes(stageNodeIds, !stageDisabled)
                : null}
              toggleLabel={stageDisabled
                ? `Enable the ${stageTitle} stage for this run`
                : `Disable the ${stageTitle} stage for this run - every member auto-passes instead of running`}
            >
              <ul className="wf-pipeline-members">
                {members.map((member) => (
                  <ReviewerRow
                    key={member.key}
                    kind={member.kind}
                    name={member.name}
                    meta={member.meta}
                    status={member.status}
                    disabled={member.disabled}
                    onToggleDisabled={onToggleNodes && member.nodeId
                      ? () => onToggleNodes([member.nodeId!], !member.disabled)
                      : null}
                    toggleLabel={member.disabled
                      ? `Enable ${member.name} for this run`
                      : `Disable ${member.name} for this run - it auto-passes instead of running`}
                  />
                ))}
              </ul>
            </StageCard>
            <StageSeam gate={parallel ? "all pass" : "pass"} />
          </div>
        );
      })}
      {pipeline.stages.length === 0 && <StageSeam />}
      <TerminusCard
        kind="end"
        name={pipeline.endOutcome}
        subtitle="Terminal outcome"
        status={end}
      />
    </PipelineFrame>
  );
}
