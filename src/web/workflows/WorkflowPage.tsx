import type { WorkflowRunSummary } from "@shared/workflow.ts";
import type { EnsembleSummary } from "@shared/ensemble.ts";
import type { ReviewItem, Session } from "@shared/types.ts";
import type { WorkflowRunFilters, WorkflowTab } from "./useWorkflowRoute.ts";
import { WorkflowRuns } from "./WorkflowRuns.tsx";
import { EnsembleRuns } from "./EnsembleRuns.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

/**
 * What is watched here, now that everything AUTHORED moved to the Library.
 *
 * Two tabs is an interim shape, not a destination: both of these become top-level pages hung
 * off the Line, and this page retires with the last of them. It keeps its own tabs until then
 * because a one-tab page pretending to be five is worse than a small honest one.
 */
const WORKFLOW_TABS = [
  ["runs", "Watch workflow runs and their verdicts"],
  ["ensembles", "Watch multi-agent ensembles, their evidence, and decisions"],
] as const;

export function WorkflowPage({
  tab,
  workflowRuns = [],
  selectedRunId = null,
  runFilters,
  ensembleSummaries = [],
  ensembleAttentionCount = 0,
  sessions = [],
  reviews = [],
  selectedEnsembleId = null,
  hasSnapshot = false,
  onTab,
  onRun = () => {},
  onRunFilters = () => {},
  onEnsemble = () => {},
  onOpenTask = () => {},
  onBindWorkflow,
  onOpenSession = () => {},
  onOpenInspectorSettings = () => {},
  onOpenWorkflowSettings = () => {},
}: {
  tab: WorkflowTab;
  workflowRuns?: WorkflowRunSummary[];
  selectedRunId?: string | null;
  runFilters?: WorkflowRunFilters;
  ensembleSummaries?: EnsembleSummary[];
  /**
   * How many runs the DAEMON flagged as needing attention, for the tab's badge.
   *
   * Passed in rather than folded here for the reason the topbar's schedule badge is: the
   * threshold is `ensembleNeedsAttention`, a server derivation, and a page that recomputed it
   * from `summaries` would be a second answer that agrees with the list row's dot by luck.
   */
  ensembleAttentionCount?: number;
  /** Live fleet facts threaded into the selected ensemble's member lanes. */
  sessions?: Session[];
  /** Pending answer surfaces threaded beside those sessions; no new detail wire is needed. */
  reviews?: ReviewItem[];
  selectedEnsembleId?: string | null;
  hasSnapshot?: boolean;
  onTab: (tab: WorkflowTab) => void;
  onRun?: (id: string) => void;
  onRunFilters?: (filters: WorkflowRunFilters | undefined) => void;
  onEnsemble?: (id: string | null) => void;
  onOpenTask?: (id: string) => void;
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
          {/* The eyebrow says what this page still IS after the split, because its title no
              longer does: workflows are authored in the Library, and what is left here is
              the watching. */}
          <p className="workflow-eyebrow">Execution</p>
          <h2>Workflow runs</h2>
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
                {/* The one ambient "a run needs you" indicator in the app until the
                    attention inbox lands. Deliberately on the TAB and not in the topbar:
                    a chip built here would be replaced rather than extended. */}
                {id === "ensembles" && ensembleAttentionCount > 0 && (
                  <span
                    className="workflow-tab-badge"
                    aria-label={`${ensembleAttentionCount} ensemble${
                      ensembleAttentionCount === 1 ? "" : "s"
                    } need attention`}
                  >
                    {ensembleAttentionCount}
                  </span>
                )}
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
            sessions={sessions}
            reviews={reviews}
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
