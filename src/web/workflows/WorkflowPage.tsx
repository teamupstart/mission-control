import type {
  PersonaView,
  WorkflowRunSummary,
  WorkflowSummary,
  WorkflowVersion,
} from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { LlmState } from "../useLlm.ts";
import type { WorkflowRunFilters, WorkflowTab } from "./useWorkflowRoute.ts";
import { PersonaLibrary } from "./PersonaLibrary.tsx";
import { WorkflowLibrary } from "./WorkflowLibrary.tsx";
import { WorkflowRuns } from "./WorkflowRuns.tsx";
import { EnsembleRuns } from "./EnsembleRuns.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

const WORKFLOW_TABS = [
  ["workflows", "Author the review workflows agents are bound to"],
  ["personas", "Author the reviewer Personas workflow nodes run"],
  ["runs", "Watch workflow runs and their verdicts"],
  ["ensembles", "Watch multi-agent ensembles, their evidence, and decisions"],
] as const;

export function WorkflowPage({
  tab,
  personas,
  workflowSummaries = [],
  workflowRuns = [],
  selectedRunId = null,
  runFilters,
  ensembleSummaries = [],
  selectedEnsembleId = null,
  hasSnapshot = false,
  llm,
  isOverlayOpen,
  onTab,
  onDirtyChange,
  onRun = () => {},
  onRunFilters = () => {},
  onEnsemble = () => {},
  onOpenTask = () => {},
  onBindVersion = () => {},
  onBindWorkflow,
  onOpenSession = () => {},
  onOpenInspectorSettings = () => {},
  onOpenWorkflowSettings = () => {},
}: {
  tab: WorkflowTab;
  personas: PersonaView[];
  workflowSummaries?: WorkflowSummary[];
  workflowRuns?: WorkflowRunSummary[];
  selectedRunId?: string | null;
  runFilters?: WorkflowRunFilters;
  ensembleSummaries?: EnsembleSummary[];
  selectedEnsembleId?: string | null;
  hasSnapshot?: boolean;
  llm: LlmState;
  isOverlayOpen: () => boolean;
  onTab: (tab: WorkflowTab) => void;
  onDirtyChange: (dirty: boolean) => void;
  onRun?: (id: string) => void;
  onRunFilters?: (filters: WorkflowRunFilters | undefined) => void;
  onEnsemble?: (id: string | null) => void;
  onOpenTask?: (id: string) => void;
  onBindVersion?: (version: WorkflowVersion) => void;
  /**
   * Opens the binding dialog with no session pinned. Both the builder's right rail and the
   * Runs empty state reach it, so "there is nothing here yet" carries the action that fixes
   * that rather than a sentence describing it.
   */
  onBindWorkflow?: () => void;
  onOpenSession?: (id: string) => void;
  onOpenInspectorSettings?: () => void;
  /**
   * Opens `#/settings/workflows`. The subsystem's switches used to hang off this header as
   * a drawer, which is why the link stays here: the page is where an operator looks for
   * them, but the settings themselves belong in the rail with every other subsystem's.
   */
  onOpenWorkflowSettings?: () => void;
}): React.JSX.Element {
  return (
    <main className="workflow-page">
      <header className="workflow-page-head">
        <div>
          <p className="workflow-eyebrow">Review automation</p>
          <h2>Workflows</h2>
        </div>
        <nav className="workflow-tabs" aria-label="Workflow sections" role="tablist">
          {WORKFLOW_TABS.map(([id, hint], index) => (
            <Tooltip key={id} label={hint}>
              <button
                id={`workflow-tab-${id}`}
                role="tab"
                className={tab === id ? "active" : ""}
                aria-selected={tab === id}
                aria-controls={`workflow-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                onClick={() => onTab(id)}
                onKeyDown={(event) => {
                  let next = index;
                  if (event.key === "ArrowRight") next = (index + 1) % WORKFLOW_TABS.length;
                  else if (event.key === "ArrowLeft") {
                    next = (index + WORKFLOW_TABS.length - 1) % WORKFLOW_TABS.length;
                  } else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = WORKFLOW_TABS.length - 1;
                  else return;
                  event.preventDefault();
                  const nextId = WORKFLOW_TABS[next]![0];
                  onTab(nextId);
                  window.requestAnimationFrame(() =>
                    document.querySelector<HTMLButtonElement>(`#workflow-tab-${nextId}`)?.focus());
                }}
              >
                {id[0]!.toUpperCase() + id.slice(1)}
              </button>
            </Tooltip>
          ))}
        </nav>
        <Tooltip label="Live delivery, its allowed repositories, retention and health, in Settings">
          <button className="btn btn-ghost wf-settings-link" onClick={onOpenWorkflowSettings}>
            Workflow settings
            <span aria-hidden>→</span>
          </button>
        </Tooltip>
      </header>

      {tab === "personas" && (
        <section
          id="workflow-panel-personas"
          role="tabpanel"
          aria-labelledby="workflow-tab-personas"
        >
          <PersonaLibrary
            personas={personas}
            providers={llm.status?.runners ?? []}
            defaults={llm.personaDefaults}
            isOverlayOpen={isOverlayOpen}
            onDirtyChange={onDirtyChange}
          />
        </section>
      )}
      {tab === "workflows" && (
        <section
          id="workflow-panel-workflows"
          role="tabpanel"
          aria-labelledby="workflow-tab-workflows"
        >
          <WorkflowLibrary
            summaries={workflowSummaries}
            personas={personas}
            hasSnapshot={hasSnapshot}
            onDirtyChange={onDirtyChange}
            onBindVersion={onBindVersion}
            onBindWorkflow={onBindWorkflow}
          />
        </section>
      )}
      {tab === "runs" && (
        <section
          id="workflow-panel-runs"
          role="tabpanel"
          aria-labelledby="workflow-tab-runs"
        >
          <WorkflowRuns
            runs={workflowRuns}
            selectedRunId={selectedRunId}
            filters={runFilters}
            onSelectRun={onRun}
            onFilters={onRunFilters}
            onOpenSession={onOpenSession}
            onOpenInspectorSettings={onOpenInspectorSettings}
            onBindWorkflow={onBindWorkflow}
          />
        </section>
      )}
      {tab === "ensembles" && (
        <section
          id="workflow-panel-ensembles"
          role="tabpanel"
          aria-labelledby="workflow-tab-ensembles"
        >
          <EnsembleRuns
            summaries={ensembleSummaries}
            selectedId={selectedEnsembleId}
            hasSnapshot={hasSnapshot}
            onSelect={onEnsemble}
            onOpenSession={onOpenSession}
            onOpenTask={onOpenTask}
            onOpenWorkflowRun={onRun}
          />
        </section>
      )}
    </main>
  );
}
