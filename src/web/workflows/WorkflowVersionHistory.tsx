import { useEffect, useState } from "react";
import type { PersonaView, WorkflowVersion, WorkflowVersionMetadata } from "@shared/workflow.ts";
import { WorkflowCanvas } from "./WorkflowCanvas.tsx";
import { workflowRequest } from "./workflowApi.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  clearRequestedWorkflowVersion,
  readRequestedWorkflowVersion,
} from "./workflowSelection.ts";

export function WorkflowVersionDetail({
  version,
  personas,
  onBindVersion = () => {},
}: {
  version: WorkflowVersion;
  personas: PersonaView[];
  onBindVersion?: (version: WorkflowVersion) => void;
}): React.JSX.Element {
  const live = new Map(personas.map((persona) => [persona.id, persona]));
  return (
    <div className="workflow-version-detail">
      <Tooltip label="Run this published version against a session">
        <button className="btn workflow-version-bind" onClick={() => onBindVersion(version)}>
          Bind this version
        </button>
      </Tooltip>
      <WorkflowCanvas graph={version.graph} personas={personas} readOnly />
      <dl>
        <div><dt>Trigger</dt><dd>{version.bindingDefaults.triggerMode}</dd></div>
        <div><dt>Delivery</dt><dd>{version.bindingDefaults.deliveryMode}</dd></div>
        <div><dt>Maximum repair rounds</dt><dd>{version.bindingDefaults.maxRepairRounds}</dd></div>
        <div><dt>Final gate</dt><dd>{version.completionPolicy.kind}</dd></div>
        {version.completionPolicy.kind === "inspector" && (
          <>
            <div><dt>On findings</dt><dd>{version.completionPolicy.onFindings}</dd></div>
            <div><dt>Missing PR</dt><dd>{version.completionPolicy.missingPrAction}</dd></div>
          </>
        )}
      </dl>
      {version.graph.nodes.filter((node) => node.kind === "persona").map((node) => {
        if (node.kind !== "persona") return null;
        const current = live.get(node.persona.sourcePersonaId);
        const stale = current && current.revision !== node.persona.sourceRevision;
        return (
          <details key={node.id} className="workflow-version-persona">
            <Tooltip label={`Show the guidance ${node.persona.name} was published with`}>
              <summary>
                {node.persona.name} · revision {node.persona.sourceRevision}
                {stale ? " · outdated" : ""}
                {!current || current.archivedAt !== null ? " · archived source" : ""}
              </summary>
            </Tooltip>
            <p>{node.persona.runner ?? "App provider"} · {node.persona.model ?? "Provider default"}</p>
            <pre>{node.persona.guidanceMarkdown}</pre>
          </details>
        );
      })}
    </div>
  );
}

export function WorkflowVersionHistory({
  workflowId,
  versions,
  personas,
  onBindVersion = () => {},
}: {
  workflowId?: string;
  versions: WorkflowVersionMetadata[];
  personas: PersonaView[];
  onBindVersion?: (version: WorkflowVersion) => void;
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkflowVersion | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId || selectedId) return;
    const requested = readRequestedWorkflowVersion(workflowId);
    const metadata = versions.find((version) => version.version === requested);
    if (!metadata) return;
    clearRequestedWorkflowVersion();
    setSelectedId(metadata.id);
  }, [selectedId, versions, workflowId]);

  useEffect(() => {
    const metadata = versions.find((version) => version.id === selectedId);
    if (!metadata) {
      setSelected(null);
      setLoading(false);
      setError(null);
      return;
    }
    let current = true;
    setSelected(null);
    setLoading(true);
    setError(null);
    void workflowRequest<WorkflowVersion>(`/api/workflows/${metadata.workflowId}/versions/${metadata.version}`)
      .then((version) => {
        if (current) setSelected(version);
      })
      .catch((caught) => {
        if (current) setError(caught instanceof Error ? caught.message : "Could not load workflow version");
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => { current = false; };
  }, [selectedId, versions]);

  return (
    <section className="workflow-version-history">
      <h4>Published versions</h4>
      {versions.length === 0 && <p>No published versions yet.</p>}
      <div className="workflow-version-list">
        {versions.map((version) => (
          <Tooltip key={version.id} label={selectedId === version.id ? `Hide version ${version.version}` : `Show what version ${version.version} contains`}>
            <button className={selectedId === version.id ? "active" : ""} onClick={() => setSelectedId(selectedId === version.id ? null : version.id)}>
              <strong>Version {version.version}</strong>
              <span>Draft r{version.sourceDraftRevision} · {new Date(version.publishedAt).toLocaleString()}</span>
            </button>
          </Tooltip>
        ))}
      </div>
      {loading && <p>Loading version…</p>}
      {error && <p className="persona-error" role="alert">{error}</p>}
      {selected && (
        <WorkflowVersionDetail
          version={selected}
          personas={personas}
          onBindVersion={onBindVersion}
        />
      )}
    </section>
  );
}
