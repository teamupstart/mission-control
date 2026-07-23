import type {
  PersonaView,
  WorkflowRunSummary,
  WorkflowSummary,
  WorkflowVersion,
} from "@shared/workflow.ts";
import type { LlmState } from "../useLlm.ts";
import type { WorkflowTab } from "./useWorkflowRoute.ts";
import { PersonaLibrary } from "./PersonaLibrary.tsx";
import { WorkflowLibrary } from "./WorkflowLibrary.tsx";
import { WorkflowRuns } from "./WorkflowRuns.tsx";

export function WorkflowPage({
  tab,
  personas,
  workflowSummaries = [],
  workflowRuns = [],
  selectedRunId = null,
  llm,
  isOverlayOpen,
  onTab,
  onDirtyChange,
  onRun = () => {},
  onBindVersion = () => {},
  onOpenSession = () => {},
}: {
  tab: WorkflowTab;
  personas: PersonaView[];
  workflowSummaries?: WorkflowSummary[];
  workflowRuns?: WorkflowRunSummary[];
  selectedRunId?: string | null;
  llm: LlmState;
  isOverlayOpen: () => boolean;
  onTab: (tab: WorkflowTab) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRun?: (id: string) => void;
  onBindVersion?: (version: WorkflowVersion) => void;
  onOpenSession?: (id: string) => void;
}): React.JSX.Element {
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
          providers={llm.status?.runners ?? []}
          defaults={llm.personaDefaults}
          isOverlayOpen={isOverlayOpen}
          onDirtyChange={onDirtyChange}
        />
      )}
      {tab === "workflows" && (
        <WorkflowLibrary
          summaries={workflowSummaries}
          personas={personas}
          onDirtyChange={onDirtyChange}
          onBindVersion={onBindVersion}
        />
      )}
      {tab === "runs" && (
        <WorkflowRuns
          runs={workflowRuns}
          selectedRunId={selectedRunId}
          onSelectRun={onRun}
          onOpenSession={onOpenSession}
        />
      )}
    </main>
  );
}
