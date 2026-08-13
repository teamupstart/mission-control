import type {
  PersonaView,
  SessionAction,
  SessionActionCompletionKind,
  WorkflowCheckSlot,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowDraftGraph,
  WorkflowMissingPrAction,
} from "@shared/workflow.ts";
import {
  WORKFLOW_CHECK_SLOTS,
  personaChoiceLabel,
  personaChoicesForDisplay,
  sessionActionChoiceLabel,
  sessionActionChoicesForDisplay,
  sessionActionCompletionLabel,
} from "@shared/workflow.ts";
import { nodeLabel } from "@shared/workflow-stages.ts";
import { missionRouteHash } from "./useWorkflowRoute.ts";

/**
 * What the rail says about the action a node names: the skill it needs and the proof it
 * waits for. Both are facts the runtime enforces, so the panel states them rather than
 * leaving an operator to open the library to find out what the node will do.
 */
function selectedActionSummary(
  sessionActionId: string,
  sessionActions: readonly SessionAction[],
): string {
  const action = sessionActions.find((candidate) => candidate.id === sessionActionId);
  if (!action) return "This session action no longer exists, so this node cannot be published.";
  return [
    action.requiredSkillId
      ? `Requires the ${action.requiredSkillId} skill.`
      : "Requires no skill.",
    // Derived from the capability table rather than from a ternary over the kind. The kinds
    // are append-only, so a two-armed conditional does not merely go out of date when a third
    // adapter ships - its `else` silently ABSORBS the new kind and states the wrong proof
    // confidently, which is worse than saying nothing.
    `Completes when ${sessionActionCompletionLabel(action.completion).toLocaleLowerCase("en-US")}.`,
    ...(action.archivedAt === null
      ? []
      : ["Its source is archived, so this draft cannot be published until it is replaced."]),
  ].join(" ");
}

/** A module constant, so an omitted prop does not re-render every consumer of this set. */
const EMPTY_COMPLETIONS: ReadonlySet<SessionActionCompletionKind> = new Set();
import type { WorkflowSelection } from "./WorkflowCanvas.tsx";
import type { WorkflowConfirmRequest } from "./WorkflowConfirmModal.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

type WorkflowPatch = Partial<Pick<
  WorkflowDefinition,
  "name" | "description" | "draft" | "completionPolicy" | "bindingDefaults"
>>;

/**
 * The one set of workflow-level fields, shared by both right rails.
 *
 * The trigger, delivery and final-gate options used to be labelled with the plan phase that
 * would implement them ("Live (Phase 4)"). All three shipped; the labels outlived the
 * uncertainty and now read as a warning not to pick a mode that is live and gated
 * server-side. Blurbs say what each option DOES instead.
 */
export function WorkflowSettingsFields({
  workflow,
  readOnly,
  onUpdate,
}: {
  workflow: WorkflowDefinition;
  readOnly: boolean;
  onUpdate: (patch: WorkflowPatch) => void;
}): React.JSX.Element {
  return (
    <section className="workflow-policy-fields">
      <p className="workflow-eyebrow">Workflow settings</p>
      <label>Name<input disabled={readOnly} value={workflow.name} onChange={(event) => onUpdate({ name: event.target.value })} /></label>
      <label>Description<textarea disabled={readOnly} value={workflow.description} onChange={(event) => onUpdate({ description: event.target.value })} /></label>
      <label>Default trigger
        <Tooltip label="What starts a run of this workflow once it is bound to a session">
          <select disabled={readOnly} value={workflow.bindingDefaults.triggerMode} onChange={(event) => onUpdate({ bindingDefaults: { ...workflow.bindingDefaults, triggerMode: event.target.value as "manual" | "foreman_complete" } })}>
            <option value="manual">Manual</option><option value="foreman_complete">When Foreman calls the work complete</option>
          </select>
        </Tooltip>
      </label>
      <label>Default delivery
        <Tooltip label="Preview only reports the verdict. Live writes findings back into the session, and has to be enabled in Workflow settings first.">
          <select disabled={readOnly} value={workflow.bindingDefaults.deliveryMode} onChange={(event) => onUpdate({ bindingDefaults: { ...workflow.bindingDefaults, deliveryMode: event.target.value as "preview" | "live" } })}>
            <option value="preview">Preview</option><option value="live">Live</option>
          </select>
        </Tooltip>
      </label>
      <label>Maximum repair rounds
        <input disabled={readOnly} type="number" min={1} max={20} value={workflow.bindingDefaults.maxRepairRounds} onChange={(event) => onUpdate({ bindingDefaults: { ...workflow.bindingDefaults, maxRepairRounds: Number(event.target.value) } })} />
      </label>
      <label>Final gate
        <Tooltip label="An extra approval this workflow must clear before it completes">
          <select disabled={readOnly} value={workflow.completionPolicy.kind} onChange={(event) => onUpdate({ completionPolicy: event.target.value === "none" ? { kind: "none" } : { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" } })}>
            <option value="none">None</option><option value="inspector">Inspector approval</option>
          </select>
        </Tooltip>
      </label>
      {workflow.completionPolicy.kind === "inspector" && (
        <>
          <label>After findings
            <Tooltip label="What re-runs when the Inspector reports findings">
              <select disabled={readOnly} value={workflow.completionPolicy.onFindings} onChange={(event) => workflow.completionPolicy.kind === "inspector" && onUpdate({ completionPolicy: { ...workflow.completionPolicy, onFindings: event.target.value as "restart_workflow" | "inspector_only" } })}>
                <option value="restart_workflow">Restart all Personas</option><option value="inspector_only">Repush and recheck Inspector only</option>
              </select>
            </Tooltip>
          </label>
          <label>Missing PR
            <Tooltip label="What to do when the gate needs a pull request and none exists yet">
              <select disabled={readOnly} value={workflow.completionPolicy.missingPrAction} onChange={(event) => workflow.completionPolicy.kind === "inspector" && onUpdate({ completionPolicy: { ...workflow.completionPolicy, missingPrAction: event.target.value as WorkflowMissingPrAction } })}>
                <option value="wait">Wait</option><option value="offer_prepare_pr">Offer Prepare PR</option><option value="prepare_pr">Prepare PR automatically</option>
              </select>
            </Tooltip>
          </label>
        </>
      )}
    </section>
  );
}

/**
 * Diagnostics as sentences, not codes.
 *
 * A pipeline cannot be structurally wrong - `compileStages` emits the joins, fail routes and
 * return edges - so the only errors reachable from the Pipeline view are about the Personas
 * themselves. The one exception is the fresh draft, which is legitimately invalid until it
 * has a reviewer; it gets ONE sentence naming the next action rather than the three
 * structural codes the validator emits for a graph nobody has finished drawing yet.
 */
export function pipelineValidationSentences(
  diagnostics: readonly WorkflowDiagnostic[],
  stageCount: number,
): string[] {
  const errors = diagnostics.filter((item) => item.severity === "error");
  if (errors.length === 0) return [];
  if (stageCount === 0) return ["Add a reviewer to route the submission."];
  return [...new Set(errors.map((item) => item.message))];
}

/**
 * The sentence a clean draft gets.
 *
 * A built-in cannot be published - it already was, by the build - so the usual "Ready to
 * publish" would name an action beside a Publish button that is deliberately off, which reads
 * as a broken control rather than as a shipped workflow.
 */
export function workflowValidSentence(builtin: boolean): string {
  return builtin ? "Published with this build." : "Ready to publish.";
}

function DiagnosticList({
  diagnostics,
}: {
  diagnostics: readonly WorkflowDiagnostic[];
}): React.JSX.Element {
  return (
    <ul>
      {diagnostics.map((item, index) => (
        <li key={`${item.code}-${item.nodeId ?? item.edgeId ?? index}`}>
          <span className="workflow-diagnostic-message">{item.message}</span>
          <Tooltip label="The validator's own name for this rule - quote it in a bug report">
            <code className="workflow-diagnostic-code">{item.code}</code>
          </Tooltip>
        </li>
      ))}
    </ul>
  );
}

/**
 * The Pipeline view's right rail: settings, sentence-first validation, and nothing about
 * nodes or edges - a pipeline author never selects one.
 */
export function WorkflowPipelineProperties({
  workflow,
  diagnostics,
  stageCount,
  readOnly,
  onUpdate,
}: {
  workflow: WorkflowDefinition;
  diagnostics: WorkflowDiagnostic[];
  stageCount: number;
  readOnly: boolean;
  onUpdate: (patch: WorkflowPatch) => void;
}): React.JSX.Element {
  const sentences = pipelineValidationSentences(diagnostics, stageCount);
  return (
    <aside className="workflow-properties" aria-label="Workflow settings and validation">
      <WorkflowSettingsFields workflow={workflow} readOnly={readOnly} onUpdate={onUpdate} />
      <section className="workflow-validation">
        <h4>Validation</h4>
        {sentences.length === 0
          ? <p className="workflow-valid">{workflowValidSentence(workflow.builtin)}</p>
          : <ul>{sentences.map((sentence) => <li key={sentence}>{sentence}</li>)}</ul>}
      </section>
    </aside>
  );
}

/**
 * The Graph view's right rail. It still speaks nodes and edges, because that view still
 * edits them - but it names them the way every other surface does, through `nodeLabel`.
 */
export function WorkflowProperties({
  workflow,
  personas,
  sessionActions = [],
  availableCompletions = EMPTY_COMPLETIONS,
  diagnostics,
  selection,
  readOnly,
  onUpdate,
  onConfirm,
}: {
  workflow: WorkflowDefinition;
  personas: PersonaView[];
  /** Names a selected action node and populates its picker, archived rows included. */
  sessionActions?: SessionAction[];
  /** Adapters this daemon can run. Narrows the picker; never narrows what can be NAMED. */
  availableCompletions?: ReadonlySet<SessionActionCompletionKind>;
  diagnostics: WorkflowDiagnostic[];
  selection: WorkflowSelection;
  readOnly: boolean;
  onUpdate: (patch: WorkflowPatch) => void;
  onConfirm: (request: WorkflowConfirmRequest) => void;
}): React.JSX.Element {
  const selectedNode = selection?.kind === "node" ? workflow.draft.nodes.find((node) => node.id === selection.id) : null;
  const selectedEdge = selection?.kind === "edge" ? workflow.draft.edges.find((edge) => edge.id === selection.id) : null;
  const scoped = diagnostics.filter((item) =>
    (!selection && !item.nodeId && !item.edgeId) ||
    (selection?.kind === "node" && item.nodeId === selection.id) ||
    (selection?.kind === "edge" && item.edgeId === selection.id),
  );
  const labelOf = (id: string): string => {
    const node = workflow.draft.nodes.find((candidate) => candidate.id === id);
    return node
      ? nodeLabel(workflow.draft, node, personas, sessionActions)
      : "a node that no longer exists";
  };
  const replaceNode = (next: WorkflowDraftGraph["nodes"][number]): void => onUpdate({
    draft: { ...workflow.draft, nodes: workflow.draft.nodes.map((node) => node.id === next.id ? next : node) },
  });
  const removeEdge = (edgeId: string): void => {
    const edge = workflow.draft.edges.find((candidate) => candidate.id === edgeId);
    if (!edge) return;
    onConfirm({
      title: "Remove connection",
      body: `Remove the ${edge.sourcePort} route from ${labelOf(edge.source)} to ${labelOf(edge.target)}?`,
      confirmLabel: "Remove connection",
      confirmHint: "Removes just this route - both nodes stay",
      danger: true,
      onConfirm: () => onUpdate({
        draft: {
          ...workflow.draft,
          edges: workflow.draft.edges.filter((candidate) => candidate.id !== edgeId),
        },
      }),
    });
  };
  const removeSelection = (): void => {
    if (!selection) return;
    if (selection.kind === "edge") {
      removeEdge(selection.id);
      return;
    }
    if (selection.kind === "multi") return;
    const node = workflow.draft.nodes.find((candidate) => candidate.id === selection.id);
    // Session is the one node a graph must keep. Refused at the model layer too, not only by
    // hiding the button: the canvas delete key routes here as well, and an affordance
    // withheld in one place and left open in the other is the same affordance.
    if (!node || node.kind === "session") return;
    const edgeCount = workflow.draft.edges.filter((edge) =>
      edge.source === selection.id || edge.target === selection.id).length;
    onConfirm({
      title: "Remove node",
      body: `Remove ${labelOf(selection.id)} and ${edgeCount} connected route${edgeCount === 1 ? "" : "s"}?`,
      confirmLabel: "Remove node",
      confirmHint: "Removes the node and every route touching it",
      danger: true,
      onConfirm: () => onUpdate({
        draft: {
          nodes: workflow.draft.nodes.filter((candidate) => candidate.id !== selection.id),
          edges: workflow.draft.edges.filter((edge) => edge.source !== selection.id && edge.target !== selection.id),
        },
      }),
    });
  };

  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const selectedPersonaId = selectedNode?.kind === "persona" ? selectedNode.personaId : null;
  const personaChoices = personaChoicesForDisplay(
    personas,
    selectedPersonaId === null ? [] : [selectedPersonaId],
  );
  const selectedPersonaAvailable = selectedPersonaId === null
    || personaChoices.some(({ persona }) => persona.id === selectedPersonaId);
  const selectedActionId = selectedNode?.kind === "session_action"
    ? selectedNode.sessionActionId
    : null;
  const actionChoices = sessionActionChoicesForDisplay(
    sessionActions,
    selectedActionId === null ? [] : [selectedActionId],
    availableCompletions,
  );
  const selectedActionListed = selectedActionId === null
    || actionChoices.some(({ action }) => action.id === selectedActionId);

  return (
    <aside className="workflow-properties" aria-label="Workflow properties and validation">
      {selectedNode ? (
        <section>
          <p className="workflow-eyebrow">Selected node</p>
          <h3>{nodeLabel(workflow.draft, selectedNode, personas, sessionActions)}</h3>
          {selectedNode.kind === "persona" && (
            <label>Persona
              <Tooltip label="Which reviewer Persona this node runs">
                <select disabled={readOnly} value={selectedNode.personaId} onChange={(event) => replaceNode({ ...selectedNode, personaId: event.target.value })}>
                  {!selectedPersonaAvailable && (
                    <option value={selectedNode.personaId}>Unavailable: {selectedNode.personaId}</option>
                  )}
                  {personaChoices.map(({ persona, retained }) => (
                    <option key={persona.id} value={persona.id}>
                      {personaChoiceLabel(persona, retained)}
                    </option>
                  ))}
                </select>
              </Tooltip>
            </label>
          )}
          {selectedNode.kind === "end" && (
            <label>Outcome
              <input disabled={readOnly} value={selectedNode.outcome} onChange={(event) => replaceNode({ ...selectedNode, outcome: event.target.value })} />
            </label>
          )}
          {selectedNode.kind === "check" && (
            <>
              <label>Command
                <Tooltip label="Which deterministic gate this node runs">
                  <select disabled={readOnly} value={selectedNode.slot} onChange={(event) => replaceNode({ ...selectedNode, slot: event.target.value as WorkflowCheckSlot })}>
                    {WORKFLOW_CHECK_SLOTS.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
                  </select>
                </Tooltip>
              </label>
              {/* The node names the slot; the machine names the command. Said here because
                  this is the panel where an operator would otherwise go looking for a field
                  to type `npm test` into - and the link is where that field actually is. */}
              <p>
                This node names the <code>{selectedNode.slot}</code> Command, never an argv, so
                this workflow travels between repositories. What runs is what{" "}
                <Tooltip label={`Set what the ${selectedNode.slot} Command runs on this machine`}>
                  <a href={missionRouteHash({ page: "library", shelf: "commands", assetId: selectedNode.slot })}>
                    Library › Commands
                  </a>
                </Tooltip>{" "}
                configures for that slot here. An unconfigured or unauthorized Command, or one
                this build cannot run, passes with a note saying which.
              </p>
            </>
          )}
          {selectedNode.kind === "session" && <p>Session is the one submission and repair boundary. It cannot be deleted.</p>}
          {selectedNode.kind === "all_pass" && <p>Waits for one pass/fail receipt from every predecessor.</p>}
          {selectedNode.kind === "session_action" && (
            <>
              <label>Session action
                <Tooltip label="Which authored instruction this node sends to the bound session">
                  <select
                    disabled={readOnly}
                    value={selectedNode.sessionActionId}
                    onChange={(event) => replaceNode({
                      ...selectedNode,
                      sessionActionId: event.target.value,
                    })}
                  >
                    {/* A source that left the catalog entirely still needs an option, or the
                        select would paint a different action as chosen and the next change
                        would rewrite a node nobody meant to edit. */}
                    {!selectedActionListed && (
                      <option value={selectedNode.sessionActionId}>
                        Unavailable: {selectedNode.sessionActionId}
                      </option>
                    )}
                    {actionChoices.map(({ action, retained }) => (
                      <option key={action.id} value={action.id}>
                        {sessionActionChoiceLabel(action, retained, availableCompletions)}
                      </option>
                    ))}
                  </select>
                </Tooltip>
              </label>
              <p>
                Sends this action's exact instruction to the bound session and waits for it to
                finish. Every stage after it reviews evidence captured once it has.
              </p>
              <p>
                {selectedActionSummary(selectedNode.sessionActionId, sessionActions)}
              </p>
            </>
          )}
          {/* Session is excluded because a graph has exactly one of it. Every other kind,
              a session action included, is removable now that it is authorable - an add
              control without a matching remove is half an authoring loop. */}
          {!readOnly && selectedNode.kind !== "session" && (
            <Tooltip label="Remove this node and every route touching it">
              <button className="btn btn-danger" onClick={removeSelection}>Delete node</button>
            </Tooltip>
          )}
        </section>
      ) : selectedEdge ? (
        <section>
          <p className="workflow-eyebrow">Selected connection</p>
          <h3>{selectedEdge.sourcePort} → {selectedEdge.targetPort}</h3>
          <p>{labelOf(selectedEdge.source)} to {labelOf(selectedEdge.target)}</p>
          {!readOnly && (
            <Tooltip label="Remove this connection between the two nodes">
              <button className="btn btn-danger" onClick={removeSelection}>Delete edge</button>
            </Tooltip>
          )}
        </section>
      ) : selection?.kind === "multi" ? (
        <section>
          <p className="workflow-eyebrow">Multiple selection</p>
          <h3>{selection.nodeIds.length} nodes · {selection.edgeIds.length} connections</h3>
          <p>Use Delete from the canvas to remove this selection with one confirmation.</p>
        </section>
      ) : (
        <WorkflowSettingsFields workflow={workflow} readOnly={readOnly} onUpdate={onUpdate} />
      )}
      <section className="workflow-edge-list" aria-label="Workflow connections">
        <h4>Connections · {workflow.draft.edges.length}</h4>
        {workflow.draft.edges.length === 0 ? <p>No connections yet.</p> : (
          <ul>
            {workflow.draft.edges.map((edge) => (
              <li key={edge.id}>
                <span tabIndex={0}>
                  {labelOf(edge.source)} ({edge.sourcePort}) → {labelOf(edge.target)} ({edge.targetPort})
                </span>
                {!readOnly && (
                  <Tooltip label={`Remove the ${edge.sourcePort} connection from ${labelOf(edge.source)} to ${labelOf(edge.target)}`}>
                    <button
                      className="btn btn-ghost"
                      aria-label={`Remove ${edge.sourcePort} connection from ${labelOf(edge.source)} to ${labelOf(edge.target)}`}
                      onClick={() => removeEdge(edge.id)}
                    >
                      Remove
                    </button>
                  </Tooltip>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="workflow-validation">
        <h4>Validation · {errorCount} error{errorCount === 1 ? "" : "s"}</h4>
        {diagnostics.length === 0
          ? <p className="workflow-valid">{workflowValidSentence(workflow.builtin)}</p>
          : <DiagnosticList diagnostics={scoped.length ? scoped : diagnostics} />}
      </section>
    </aside>
  );
}
