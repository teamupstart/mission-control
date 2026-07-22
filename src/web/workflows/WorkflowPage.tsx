import { useEffect, useState } from "react";
import type { LlmStatus } from "@shared/types.ts";
import type { PersonaDefaultsView, PersonaView } from "@shared/workflow.ts";
import { fetchLlmStatus, fetchPersonaDefaults } from "../lib/api.ts";
import type { WorkflowTab } from "./useWorkflowRoute.ts";
import { PersonaLibrary } from "./PersonaLibrary.tsx";

export function WorkflowPage({
  tab,
  personas,
  connected,
  isOverlayOpen,
  onTab,
  onDirtyChange,
}: {
  tab: WorkflowTab;
  personas: PersonaView[];
  connected: boolean;
  isOverlayOpen: () => boolean;
  onTab: (tab: WorkflowTab) => void;
  onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [personaDefaults, setPersonaDefaults] = useState<PersonaDefaultsView | null>(null);

  useEffect(() => {
    if (!connected) return;
    let live = true;
    void Promise.all([fetchLlmStatus(), fetchPersonaDefaults()]).then(([status, defaults]) => {
      if (!live) return;
      if (status) setLlmStatus(status);
      if (defaults) setPersonaDefaults(defaults);
    });
    return () => {
      live = false;
    };
  }, [connected]);

  return (
    <main className="workflow-page">
      <header className="workflow-page-head">
        <div>
          <p className="workflow-eyebrow">Review automation</p>
          <h2>Workflows</h2>
        </div>
        <nav className="workflow-tabs" aria-label="Workflow sections">
          {(["workflows", "personas", "runs"] as const).map((id) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => onTab(id)}
            >
              {id[0]!.toUpperCase() + id.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      {tab === "personas" && (
        <PersonaLibrary
          personas={personas}
          providers={llmStatus?.runners ?? []}
          defaults={personaDefaults}
          isOverlayOpen={isOverlayOpen}
          onDirtyChange={onDirtyChange}
        />
      )}
      {tab === "workflows" && (
        <section className="workflow-empty">
          <span className="workflow-empty-mark" aria-hidden>◇</span>
          <h3>Workflow builder arrives in Phase 2</h3>
          <p>
            Phase 1 establishes the durable contracts and Persona library. Graph editing and
            publishing are intentionally not active yet.
          </p>
        </section>
      )}
      {tab === "runs" && (
        <section className="workflow-empty">
          <span className="workflow-empty-mark" aria-hidden>↻</span>
          <h3>No workflow runs yet</h3>
          <p>Manual preview execution and durable run history arrive in Phase 3.</p>
        </section>
      )}
    </main>
  );
}
