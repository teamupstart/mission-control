import type {
  PersonaView,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowDraftGraph,
} from "@shared/workflow.ts";
import type { WorkflowSelection } from "./WorkflowCanvas.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

export function WorkflowProperties({
  workflow,
  personas,
  diagnostics,
  selection,
  readOnly,
  onUpdate,
}: {
  workflow: WorkflowDefinition;
  personas: PersonaView[];
  diagnostics: WorkflowDiagnostic[];
  selection: WorkflowSelection;
  readOnly: boolean;
  onUpdate: (patch: Partial<Pick<WorkflowDefinition, "name" | "description" | "draft" | "completionPolicy" | "bindingDefaults">>) => void;
}): React.JSX.Element {
  const selectedNode = selection?.kind === "node" ? workflow.draft.nodes.find((node) => node.id === selection.id) : null;
  const selectedEdge = selection?.kind === "edge" ? workflow.draft.edges.find((edge) => edge.id === selection.id) : null;
  const scoped = diagnostics.filter((item) =>
    (!selection && !item.nodeId && !item.edgeId) ||
    (selection?.kind === "node" && item.nodeId === selection.id) ||
    (selection?.kind === "edge" && item.edgeId === selection.id),
  );
  const replaceNode = (next: WorkflowDraftGraph["nodes"][number]): void => onUpdate({
    draft: { ...workflow.draft, nodes: workflow.draft.nodes.map((node) => node.id === next.id ? next : node) },
  });
  const removeSelection = (): void => {
    if (!selection) return;
    if (selection.kind === "edge") {
      onUpdate({ draft: { ...workflow.draft, edges: workflow.draft.edges.filter((edge) => edge.id !== selection.id) } });
      return;
    }
    const node = workflow.draft.nodes.find((candidate) => candidate.id === selection.id);
    if (!node || node.kind === "session") return;
    onUpdate({
      draft: {
        nodes: workflow.draft.nodes.filter((candidate) => candidate.id !== selection.id),
        edges: workflow.draft.edges.filter((edge) => edge.source !== selection.id && edge.target !== selection.id),
      },
    });
  };

  return (
    <aside className="workflow-properties" aria-label="Workflow properties and validation">
      {selectedNode ? (
        <section>
          <p className="workflow-eyebrow">Selected node</p>
          <h3>{selectedNode.kind === "all_pass" ? "All-pass Join" : selectedNode.kind}</h3>
          {selectedNode.kind === "persona" && (
            <label>Persona
              <Tooltip label="Which reviewer Persona this node runs">
                <select disabled={readOnly} value={selectedNode.personaId} onChange={(event) => replaceNode({ ...selectedNode, personaId: event.target.value })}>
                  {personas.filter((persona) => persona.archivedAt === null).map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
                </select>
              </Tooltip>
            </label>
          )}
          {selectedNode.kind === "end" && (
            <label>Outcome
              <input disabled={readOnly} value={selectedNode.outcome} onChange={(event) => replaceNode({ ...selectedNode, outcome: event.target.value })} />
            </label>
          )}
          {selectedNode.kind === "session" && <p>Session is the one submission and repair boundary. It cannot be deleted.</p>}
          {selectedNode.kind === "all_pass" && <p>Waits for one pass/fail receipt from every predecessor.</p>}
          {!readOnly && selectedNode.kind !== "session" && (
            <Tooltip label="Remove this node and every edge touching it">
              <button className="btn btn-danger" onClick={removeSelection}>Delete node</button>
            </Tooltip>
          )}
        </section>
      ) : selectedEdge ? (
        <section>
          <p className="workflow-eyebrow">Selected edge</p>
          <h3>{selectedEdge.sourcePort} → {selectedEdge.targetPort}</h3>
          <p>{selectedEdge.source} to {selectedEdge.target}</p>
          {!readOnly && (
            <Tooltip label="Remove this connection between the two nodes">
              <button className="btn btn-danger" onClick={removeSelection}>Delete edge</button>
            </Tooltip>
          )}
        </section>
      ) : (
        <section className="workflow-policy-fields">
          <p className="workflow-eyebrow">Workflow settings</p>
          <label>Name<input disabled={readOnly} value={workflow.name} onChange={(event) => onUpdate({ name: event.target.value })} /></label>
          <label>Description<textarea disabled={readOnly} value={workflow.description} onChange={(event) => onUpdate({ description: event.target.value })} /></label>
          <label>Default trigger
            <Tooltip label="What starts a run of this workflow once it is bound to a session">
              <select disabled={readOnly} value={workflow.bindingDefaults.triggerMode} onChange={(event) => onUpdate({ bindingDefaults: { ...workflow.bindingDefaults, triggerMode: event.target.value as "manual" | "foreman_complete" } })}>
                <option value="manual">Manual</option><option value="foreman_complete">Foreman complete (Phase 4)</option>
              </select>
            </Tooltip>
          </label>
          <label>Default delivery
            <Tooltip label="Whether a run only reports its verdict, or writes back into the session">
              <select disabled={readOnly} value={workflow.bindingDefaults.deliveryMode} onChange={(event) => onUpdate({ bindingDefaults: { ...workflow.bindingDefaults, deliveryMode: event.target.value as "preview" | "live" } })}>
                <option value="preview">Preview</option><option value="live">Live (Phase 4)</option>
              </select>
            </Tooltip>
          </label>
          <label>Maximum repair rounds
            <input disabled={readOnly} type="number" min={1} max={20} value={workflow.bindingDefaults.maxRepairRounds} onChange={(event) => onUpdate({ bindingDefaults: { ...workflow.bindingDefaults, maxRepairRounds: Number(event.target.value) } })} />
          </label>
          <label>Final gate
            <Tooltip label="An extra approval this workflow must clear before it completes">
              <select disabled={readOnly} value={workflow.completionPolicy.kind} onChange={(event) => onUpdate({ completionPolicy: event.target.value === "none" ? { kind: "none" } : { kind: "inspector", onFindings: "restart_workflow", missingPrAction: "wait" } })}>
                <option value="none">None</option><option value="inspector">Inspector approval (Phase 5)</option>
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
                  <select disabled={readOnly} value={workflow.completionPolicy.missingPrAction} onChange={(event) => workflow.completionPolicy.kind === "inspector" && onUpdate({ completionPolicy: { ...workflow.completionPolicy, missingPrAction: event.target.value as "wait" | "offer_prepare_pr" } })}>
                    <option value="wait">Wait</option><option value="offer_prepare_pr">Offer Prepare PR</option>
                  </select>
                </Tooltip>
              </label>
            </>
          )}
        </section>
      )}
      <section className="workflow-validation">
        <h4>Validation · {diagnostics.filter((item) => item.severity === "error").length} errors</h4>
        {diagnostics.length === 0 ? <p className="workflow-valid">Ready to publish.</p> : (
          <ul>{(scoped.length ? scoped : diagnostics).map((item, index) => <li key={`${item.code}-${item.nodeId ?? item.edgeId ?? index}`}><code>{item.code}</code>{item.message}</li>)}</ul>
        )}
      </section>
    </aside>
  );
}
