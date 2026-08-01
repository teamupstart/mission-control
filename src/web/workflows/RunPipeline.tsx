import { useCallback, useMemo } from "react";
import type {
  SessionActionWaitReason,
  WorkflowCheckStatus,
  WorkflowVersion,
} from "@shared/workflow.ts";
import {
  nodeLabel,
  projectStages,
  stageMemberKey,
  stageMembers,
  stageName,
  stageSeamGate,
  stageSummary,
  type StageNode,
} from "@shared/workflow-stages.ts";
import {
  InspectorFooter,
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
  sessionActionStatus,
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
  actionWaitFor,
  inspectorDetail = null,
  inspectorStatus = null,
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
  /** This round bypassed stages that passed before an Inspector-requested repair. */
  inspectorOnly?: boolean;
  /**
   * What a session action node is waiting FOR, when it is waiting.
   *
   * Read off the durable attempt by the caller rather than derived here, because it is the
   * runtime's own answer: the difference between "sent" and "the session read it" is a
   * transcript byte offset the daemon recorded, and nothing in a node status map can
   * reconstruct it.
   */
  actionWaitFor?: (nodeId: string) => SessionActionWaitReason | null;
  /** The Inspector wait sentence for the fixed footer, or null when there is no gate. */
  inspectorDetail?: string | null;
  /** The gate's chip for the footer. Absent draws the footer without one. */
  inspectorStatus?: PipelineStatus | null;
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
  // A published action node carries its snapshot, so this list is always complete for a
  // version - no live catalog is consulted, and a library edit cannot rename a stage in a
  // run that already happened.
  const actionNames = graph.nodes.flatMap((node) =>
    node.kind === "session_action" && "action" in node
      ? [{ id: node.action.sourceSessionActionId, name: node.action.name }]
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
        const members = stageMembers(stage).map((member) => {
          const node = member.nodeId ? nodes.get(member.nodeId) : undefined;
          const name = member.kind === "check"
            // A check's row carries the bare slot and its own chip, the way the editor draws
            // it - `nodeLabel` would supply "Check · test", which the chip would then say
            // again. A Persona keeps the snapshot name the version was published with.
            ? member.slot
            : node
              ? nodeLabel(graph, node, personaNames, actionNames)
              : member.kind === "session_action" ? "Missing session action" : "Missing persona";
          // A session action is never disable-able. The per-run auto-pass converts an
          // attempt into a PASS, and `WorkflowManager` scopes the whole feature to
          // `isVerdictNode` - so offering the toggle here would send a request the server
          // refuses, on a node that has no verdict to force in the first place.
          const togglable = member.kind !== "session_action";
          const disabled = togglable && member.nodeId ? disabledSet.has(member.nodeId) : false;
          return {
            key: member.nodeId ?? `${index}:${stageMemberKey(member)}`,
            nodeId: member.nodeId,
            kind: member.kind,
            name,
            togglable,
            disabled,
            meta: member.nodeId ? metaFor(member.nodeId) : null,
            status: canShowInspectorOnlySkip(
              inspectorOnly,
              member.nodeId,
              node !== undefined,
              member.nodeId !== null && statuses[member.nodeId] !== undefined,
            )
              ? inspectorOnlySkipStatus()
              // The chip is the viewed round's history: Disabled only when the auto-pass
              // will convert (or synthesized) this node's attempt, never over an outcome the
              // round already reached - a recorded failure painted as Disabled would claim
              // the toggle rewrote it. The row's red treatment carries the control's state.
              //
              // An action reports LIFECYCLE, never a verdict, and gets its OWN status table
              // rather than borrowing either evaluator's. A "Passed" chip on a node that judged
              // nothing is the failure this third branch avoids, and routing it through
              // `reviewerStatus` would also flatten every stage of a waiting turn into the one
              // word "Waiting".
              : (togglable && member.nodeId ? disabledChipFor?.(member.nodeId) ?? null : null)
                ?? (member.kind === "session_action"
                  ? sessionActionStatus(
                      member.nodeId ? statuses[member.nodeId] : undefined,
                      member.nodeId ? actionWaitFor?.(member.nodeId) ?? null : null,
                    )
                  : member.kind === "check"
                    ? checkStatus(
                        member.nodeId ? statuses[member.nodeId] : undefined,
                        member.nodeId ? checkOutcomeFor?.(member.nodeId) ?? null : null,
                      )
                    : reviewerStatus(member.nodeId ? statuses[member.nodeId] : undefined)),
          };
        });
        // The stage toggle needs every member addressable AND switchable; a projection member
        // without a node id (a compile-time placeholder), or a session action, leaves the
        // stage header unswitchable rather than half-switching it.
        const stageNodeIds = members.flatMap((member) =>
          member.togglable && member.nodeId ? [member.nodeId] : []);
        const stageDisabled = members.length > 0 && members.every((member) => member.disabled);
        const stageTitle = stageName(stage, index, personaNames, actionNames);
        return (
          <div className="wf-pipeline-slot" key={`stage:${index}`}>
            <StageCard
              name={stageTitle}
              subtitle={stageSummary(stage)}
              status={inspectorOnly
                && members.length > 0
                && members.every((member) => member.status.skipKind === "inspector_repair")
                ? inspectorOnlySkipStatus()
                : stageStatus(members.map((member) => member.status), stage.kind)}
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
                    onToggleDisabled={onToggleNodes && member.togglable && member.nodeId
                      ? () => onToggleNodes([member.nodeId!], !member.disabled)
                      : null}
                    toggleLabel={member.disabled
                      ? `Enable ${member.name} for this run`
                      : `Disable ${member.name} for this run - it auto-passes instead of running`}
                  />
                ))}
              </ul>
            </StageCard>
            <StageSeam gate={stageSeamGate(stage)} />
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
      {/* The same footer the author saw, now carrying the run's own gate state. Drawn from
          the VERSION's policy rather than the workflow's, so a run pinned to an older version
          shows the gate that version was published with. */}
      <InspectorFooter
        policy={version.completionPolicy}
        status={inspectorStatus}
        detail={inspectorDetail}
      />
    </PipelineFrame>
  );
}
