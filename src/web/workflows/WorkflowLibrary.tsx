import { useEffect, useMemo, useState } from "react";
import type { PersonaView, WorkflowDraftNode, WorkflowSummary } from "@shared/workflow.ts";
import { validateWorkflowGraph } from "@shared/workflow-graph.ts";
import { WorkflowCanvas, type WorkflowSelection } from "./WorkflowCanvas.tsx";
import { WorkflowProperties } from "./WorkflowProperties.tsx";
import { WorkflowVersionHistory } from "./WorkflowVersionHistory.tsx";
import { useWorkflowDraft, workflowPublishBlocked } from "./useWorkflowDraft.ts";
import { workflowRequest } from "./workflowApi.ts";

interface CreateResponse { summary: WorkflowSummary }

function nextName(summaries: WorkflowSummary[]): string {
  const names = new Set(summaries.map((workflow) => workflow.name));
  let n = 1;
  while (names.has(n === 1 ? "Untitled workflow" : `Untitled workflow ${n}`)) n += 1;
  return n === 1 ? "Untitled workflow" : `Untitled workflow ${n}`;
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
  const [selectedId, setSelectedId] = useState<string | null>(() => active[0]?.id ?? null);
  const [selection, setSelection] = useState<WorkflowSelection>(null);
  const streamed = ordered.find((workflow) => workflow.id === selectedId) ?? null;
  const draft = useWorkflowDraft(selectedId, streamed, onDirtyChange);
  const workflow = draft.workflow;
  const validation = workflow ? validateWorkflowGraph({ graph: workflow.draft, personas, completionPolicy: workflow.completionPolicy }) : null;
  const alreadyPublished = Boolean(workflow && draft.versions.some((version) => version.sourceDraftRevision === workflow.draftRevision));
  const activePersonas = personas.filter((persona) => persona.archivedAt === null);
  const [palettePersona, setPalettePersona] = useState(activePersonas[0]?.id ?? "");
  useEffect(() => {
    if (selectedId === null && active[0]) setSelectedId(active[0].id);
  }, [active, selectedId]);
  useEffect(() => {
    if (!activePersonas.some((persona) => persona.id === palettePersona)) setPalettePersona(activePersonas[0]?.id ?? "");
  }, [activePersonas, palettePersona]);

  const select = async (id: string): Promise<void> => {
    if (id === selectedId) return;
    if ((draft.dirty || draft.saving) && !(await draft.saveNow())) return;
    setSelection(null);
    setSelectedId(id);
  };

  const create = async (): Promise<void> => {
    const response = await workflowRequest<CreateResponse>("/api/workflows", {
      method: "POST",
      body: JSON.stringify({ name: nextName(ordered) }),
    });
    setSelectedId(response.summary.id);
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
        {workflow && (
          <>
            <header className="workflow-builder-toolbar">
              <div><p className="workflow-eyebrow">Draft revision {workflow.draftRevision}</p><h3>{workflow.name}</h3></div>
              <span className={draft.saving ? "is-saving" : draft.dirty ? "is-dirty" : "is-saved"}>{draft.saving ? "Saving…" : draft.dirty ? "Unsaved changes" : "Saved"}</span>
              <button className="btn btn-ghost" onClick={() => void draft.duplicate().then((summary) => summary && setSelectedId(summary.id))}>Duplicate</button>
              <button className="btn btn-danger" disabled={workflow.archivedAt !== null} onClick={async () => {
                if (!window.confirm(`Archive ${workflow.name}? Published versions remain readable.`)) return;
                await workflowRequest(`/api/workflows/${workflow.id}`, { method: "DELETE", body: JSON.stringify({ expectedDraftRevision: workflow.draftRevision }) });
                setSelectedId(active.find((item) => item.id !== workflow.id)?.id ?? null);
              }}>Archive</button>
              <button className="btn" disabled={workflowPublishBlocked({ dirty: draft.dirty, saving: draft.saving, conflicted: Boolean(draft.conflict), valid: Boolean(validation?.valid), alreadyPublished, archived: workflow.archivedAt !== null })} onClick={() => void draft.publish()}>Publish</button>
            </header>
            {draft.conflict && (
              <div className="workflow-conflict" role="alert"><span>A newer draft revision exists. Autosave is paused.</span><button onClick={() => void draft.reload()}>Reload latest</button><button onClick={() => void draft.duplicate().then((summary) => summary && setSelectedId(summary.id))}>Duplicate my draft</button></div>
            )}
            {draft.error && <p className="persona-error" role="alert">{draft.error}</p>}
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
