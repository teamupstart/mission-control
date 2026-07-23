import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeWorkflowName, type PersonaView, type WorkflowDraftNode, type WorkflowSummary } from "@shared/workflow.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";
import { WorkflowCanvas, type WorkflowSelection } from "./WorkflowCanvas.tsx";
import { WorkflowProperties } from "./WorkflowProperties.tsx";
import { WorkflowVersionHistory } from "./WorkflowVersionHistory.tsx";
import { useWorkflowDraft, workflowPublishBlocked } from "./useWorkflowDraft.ts";
import { workflowRequest } from "./workflowApi.ts";
import { readLastWorkflowId, rememberWorkflowId } from "./workflowSelection.ts";

interface CreateResponse { summary: WorkflowSummary }

export function nextWorkflowName(base: string, summaries: WorkflowSummary[]): string {
  const names = new Set(summaries.map((workflow) => normalizeWorkflowName(workflow.name)));
  let n = 1;
  while (names.has(normalizeWorkflowName(n === 1 ? base : `${base} ${n}`))) n += 1;
  return n === 1 ? base : `${base} ${n}`;
}

export function workflowSelectionRestore(
  initialized: boolean,
  selectedId: string | null,
  active: WorkflowSummary[],
  rememberedId: string | null,
): string | undefined {
  if (initialized || selectedId !== null || active.length === 0) return undefined;
  return active.find((workflow) => workflow.id === rememberedId)?.id ?? active[0]!.id;
}

export function WorkflowLoadError({
  error,
  canRetry,
  onRetry,
}: {
  error: string | null;
  canRetry: boolean;
  onRetry: () => void;
}): React.JSX.Element | null {
  if (!error) return null;
  return (
    <p className="persona-error" role="alert">
      {error}
      {canRetry && <button className="btn btn-ghost" onClick={onRetry}>Retry</button>}
    </p>
  );
}

export function WorkflowLibrary({
  summaries,
  personas,
  onDirtyChange,
}: {
  summaries: WorkflowSummary[];
  personas: PersonaView[];
  onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const ordered = useMemo(() => [...summaries].sort((a, b) => a.name.localeCompare(b.name)), [summaries]);
  const active = ordered.filter((workflow) => workflow.archivedAt === null);
  const [showArchived, setShowArchived] = useState(false);
  const listed = showArchived ? ordered : active;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectionInitialized = useRef(false);
  const [selection, setSelection] = useState<WorkflowSelection>(null);
  const streamed = ordered.find((workflow) => workflow.id === selectedId) ?? null;
  const draft = useWorkflowDraft(selectedId, streamed, onDirtyChange);
  const workflow = draft.workflow;
  const validation = workflow ? validateWorkflowGraph({ graph: workflow.draft, personas, completionPolicy: workflow.completionPolicy }) : null;
  const alreadyPublished = Boolean(workflow && draft.versions.some((version) => version.sourceDraftRevision === workflow.draftRevision));
  const activePersonas = personas.filter((persona) => persona.archivedAt === null);
  const [palettePersona, setPalettePersona] = useState(activePersonas[0]?.id ?? "");
  useEffect(() => {
    const next = workflowSelectionRestore(
      selectionInitialized.current,
      selectedId,
      active,
      readLastWorkflowId(),
    );
    if (next === undefined) return;
    selectionInitialized.current = true;
    rememberWorkflowId(next);
    setSelectedId(next);
  }, [active, selectedId]);
  useEffect(() => {
    if (!activePersonas.some((persona) => persona.id === palettePersona)) setPalettePersona(activePersonas[0]?.id ?? "");
  }, [activePersonas, palettePersona]);

  const openWorkflow = (id: string | null): void => {
    selectionInitialized.current = true;
    rememberWorkflowId(id);
    setSelection(null);
    setSelectedId(id);
  };

  const select = async (id: string): Promise<void> => {
    if (id === selectedId) return;
    if (!(await draft.saveNow())) return;
    openWorkflow(id);
  };

  const create = async (): Promise<void> => {
    if (!(await draft.saveNow())) return;
    const response = await workflowRequest<CreateResponse>("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: nextWorkflowName("Untitled workflow", ordered) }),
    });
    openWorkflow(response.summary.id);
  };

  const duplicate = async (): Promise<void> => {
    if (!workflow) return;
    const summary = await draft.duplicate(nextWorkflowName(`${workflow.name} copy`, ordered));
    if (summary) openWorkflow(summary.id);
  };

  const addNode = (kind: "persona" | "all_pass" | "end", personaId = palettePersona, at?: { x: number; y: number }): void => {
    if (!workflow || workflow.archivedAt !== null) return;
    if (kind === "persona" && !personaId) return;
    const offset = workflow.draft.nodes.length * 26;
    const id = crypto.randomUUID();
    const position = at ?? { x: 220 + offset, y: 100 + offset };
    const node: WorkflowDraftNode = kind === "persona"
      ? { id, kind, personaId, position }
      : kind === "all_pass" ? { id, kind, position } : { id, kind, outcome: "Complete", position };
    draft.update({ draft: { ...workflow.draft, nodes: [...workflow.draft.nodes, node] } });
    setSelection({ kind: "node", id });
  };

  return (
    <section className="workflow-builder">
      <aside className="workflow-library-sidebar" aria-label="Workflow library and node palette">
        <header><div><h3>Workflows</h3><p>Drafts and published versions</p></div><button className="btn" onClick={() => void create()}>New</button></header>
        <div className="workflow-library-list">
          {listed.length === 0 && <p>No workflow drafts yet.</p>}
          {listed.map((summary) => (
            <button key={summary.id} className={selectedId === summary.id ? "active" : ""} onClick={() => void select(summary.id)}>
              <strong>{summary.name}</strong>
              <span>{summary.archivedAt !== null ? "Archived" : summary.errorCount ? `${summary.errorCount} errors` : "Draft valid"}{summary.publishedVersion ? ` · v${summary.publishedVersion}` : ""}</span>
            </button>
          ))}
          {ordered.some((summary) => summary.archivedAt !== null) && <label className="workflow-show-archived"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>}
        </div>
        {workflow && workflow.archivedAt === null && (
          <section className="workflow-palette">
            <h4>Node palette</h4>
            <p>Session is fixed. Add review and terminal nodes.</p>
            <select aria-label="Persona for new node" value={palettePersona} onChange={(event) => setPalettePersona(event.target.value)}>
              <option value="">Choose a Persona</option>
              {activePersonas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
            </select>
            <button disabled={!palettePersona} draggable={Boolean(palettePersona)} onDragStart={(event) => event.dataTransfer.setData("application/mission-workflow-node", JSON.stringify({ kind: "persona", personaId: palettePersona }))} onClick={() => addNode("persona")}>＋ Persona</button>
            <button draggable onDragStart={(event) => event.dataTransfer.setData("application/mission-workflow-node", JSON.stringify({ kind: "all_pass" }))} onClick={() => addNode("all_pass")}>＋ All-pass Join</button>
            <button draggable onDragStart={(event) => event.dataTransfer.setData("application/mission-workflow-node", JSON.stringify({ kind: "end" }))} onClick={() => addNode("end")}>＋ End</button>
            <small>No checkpoint node · Inspector is a final-gate setting.</small>
          </section>
        )}
      </aside>

      <div className="workflow-builder-main">
        {!selectedId && (
          <section className="workflow-empty"><span className="workflow-empty-mark">◇</span><h3>Build a review workflow</h3><p>Create a draft, then connect Session, Personas, joins, and End outcomes.</p><button className="btn" onClick={() => void create()}>New workflow</button></section>
        )}
        {draft.loading && <section className="workflow-empty"><p>Loading workflow…</p></section>}
        <WorkflowLoadError error={draft.error} canRetry={Boolean(selectedId && !workflow && !draft.loading)} onRetry={() => void draft.reload()} />
        {workflow && (
          <>
            <header className="workflow-builder-toolbar">
              <div><p className="workflow-eyebrow">Draft revision {workflow.draftRevision}</p><h3>{workflow.name}</h3></div>
              <span className={draft.saving ? "is-saving" : draft.dirty ? "is-dirty" : "is-saved"}>{draft.saving ? "Saving…" : draft.dirty ? "Unsaved changes" : "Saved"}</span>
              <button className="btn btn-ghost" onClick={() => void duplicate()}>Duplicate</button>
              <button className="btn btn-danger" disabled={workflow.archivedAt !== null} onClick={async () => {
                if (!window.confirm(`Archive ${workflow.name}? Published versions remain readable.`)) return;
                if (!(await draft.saveNow())) return;
                const current = draft.current();
                if (!current) return;
                await workflowRequest(`/api/workflows/${current.id}`, { method: "DELETE", body: JSON.stringify({ expectedDraftRevision: current.draftRevision }) });
                openWorkflow(active.find((item) => item.id !== current.id)?.id ?? null);
              }}>Archive</button>
              <button className="btn" disabled={workflowPublishBlocked({ dirty: draft.dirty, saving: draft.saving, conflicted: Boolean(draft.conflict), valid: Boolean(validation?.valid), alreadyPublished, archived: workflow.archivedAt !== null })} onClick={() => void draft.publish()}>Publish</button>
            </header>
            {draft.conflict && (
              <div className="workflow-conflict" role="alert"><span>A newer draft revision exists. Autosave is paused.</span><button onClick={() => void draft.reload()}>Reload latest</button><button onClick={() => void duplicate()}>Duplicate my draft</button></div>
            )}
            <WorkflowCanvas graph={workflow.draft} personas={personas} readOnly={workflow.archivedAt !== null} onChange={(graph) => draft.update({ draft: graph })} onSelection={setSelection} onDropNode={(kind, personaId, position) => addNode(kind, personaId ?? "", position)} />
          </>
        )}
      </div>

      {workflow && validation && (
        <div className="workflow-builder-right">
          <WorkflowProperties workflow={workflow} personas={personas} diagnostics={validation.diagnostics} selection={selection} readOnly={workflow.archivedAt !== null} onUpdate={draft.update} />
          <WorkflowVersionHistory versions={draft.versions} personas={personas} />
        </div>
      )}
    </section>
  );
}
