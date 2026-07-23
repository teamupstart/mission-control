import { useState } from "react";
import type { PersonaView, WorkflowVersion } from "@shared/workflow.ts";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";

export function WorkflowVersionHistory({ versions, personas }: { versions: WorkflowVersion[]; personas: PersonaView[] }): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = versions.find((version) => version.id === selectedId) ?? null;
  const live = new Map(personas.map((persona) => [persona.id, persona]));
  return (
    <section className="workflow-version-history">
      <h4>Published versions</h4>
      {versions.length === 0 && <p>No published versions yet.</p>}
      <div className="workflow-version-list">
        {versions.map((version) => (
          <button key={version.id} className={selectedId === version.id ? "active" : ""} onClick={() => setSelectedId(selectedId === version.id ? null : version.id)}>
            <strong>Version {version.version}</strong>
            <span>Draft r{version.sourceDraftRevision} · {new Date(version.publishedAt).toLocaleString()}</span>
          </button>
        ))}
      </div>
      {selected && (
        <div className="workflow-version-detail">
          <WorkflowCanvas graph={selected.graph} personas={personas} readOnly />
          <dl>
            <div><dt>Trigger</dt><dd>{selected.bindingDefaults.triggerMode}</dd></div>
            <div><dt>Delivery</dt><dd>{selected.bindingDefaults.deliveryMode}</dd></div>
            <div><dt>Final gate</dt><dd>{selected.completionPolicy.kind}</dd></div>
          </dl>
          {selected.graph.nodes.filter((node) => node.kind === "persona").map((node) => {
            if (node.kind !== "persona") return null;
            const current = live.get(node.persona.sourcePersonaId);
            const stale = current && current.revision !== node.persona.sourceRevision;
            return (
              <details key={node.id} className="workflow-version-persona">
                <summary>
                  {node.persona.name} · revision {node.persona.sourceRevision}
                  {stale ? " · outdated" : ""}
                  {!current || current.archivedAt !== null ? " · archived source" : ""}
                </summary>
                <p>{node.persona.runner ?? "App provider"} · {node.persona.model ?? "Provider default"}</p>
                <pre>{node.persona.guidanceMarkdown}</pre>
              </details>
            );
          })}
        </div>
      )}
    </section>
  );
}
