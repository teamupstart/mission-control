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
import {
  canShowInspectorOnlySkip,
  checkStatus,
  inspectorOnlySkipStatus,
  reviewerStatus,
  stageStatus,
} from "./run-model.ts";

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
  inspectorOnly = false,
  repair,
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
  /** This round bypassed stages that passed before an Inspector-requested repair. */
  inspectorOnly?: boolean;
  repair: string | null;
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
          return {
            key: member.nodeId
              ?? `${index}:${member.kind === "check" ? member.slot : member.personaId}`,
            kind: member.kind,
            // A check's row carries the bare slot and its own chip, the way the editor draws
            // it - `nodeLabel` would supply "Check · test", which the chip would then say
            // again. A Persona keeps the snapshot name the version was published with.
            name: member.kind === "check"
              ? member.slot
              : node ? nodeLabel(graph, node, personaNames) : "Missing persona",
            meta: member.nodeId ? metaFor(member.nodeId) : null,
            status: canShowInspectorOnlySkip(
              inspectorOnly,
              member.nodeId,
              node !== undefined,
              member.nodeId !== null && statuses[member.nodeId] !== undefined,
            )
              ? inspectorOnlySkipStatus()
              : member.kind === "check"
                ? checkStatus(
                    member.nodeId ? statuses[member.nodeId] : undefined,
                    member.nodeId ? checkOutcomeFor?.(member.nodeId) ?? null : null,
                  )
                : reviewerStatus(member.nodeId ? statuses[member.nodeId] : undefined),
          };
        });
        const parallel = stage.members.length > 1;
        return (
          <div className="wf-pipeline-slot" key={`stage:${index}`}>
            <StageCard
              name={stageName(stage, index, personaNames)}
              subtitle={stageSummary(stage)}
              status={inspectorOnly
                && members.length > 0
                && members.every((member) => member.status.skipKind === "inspector_repair")
                ? inspectorOnlySkipStatus()
                : stageStatus(members.map((member) => member.status))}
            >
              <ul className="wf-pipeline-members">
                {members.map((member) => (
                  <ReviewerRow
                    key={member.key}
                    kind={member.kind}
                    name={member.name}
                    meta={member.meta}
                    status={member.status}
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
