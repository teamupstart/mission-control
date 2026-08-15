import { Tooltip } from "../components/Tooltip.tsx";

/**
 * The Runs page's two surfaces: Mission Control's own workflow runs, and the pipelines an
 * external SDLC engine is driving.
 *
 * A page-level tab rather than a second top-level destination, because both answer one
 * question - what is executing - and an operator who has to remember which of two pages a
 * piece of work landed on is being asked to know something about our architecture.
 */
export type RunsKind = "workflows" | "pipelines";

/**
 * The strip above both surfaces.
 *
 * It renders ONLY when a pipeline provider is actually observing something. With nothing
 * enabled - which is every fleet until somebody consents to a repository in Settings - the
 * caller does not mount this at all and the page is the one that shipped before this
 * feature, tab strip included: a lone "Workflows" tab is a control that changes nothing,
 * and a page that grows chrome to say a feature exists is exactly what "everything ships
 * off" is supposed to prevent.
 *
 * Counts are plain text rather than the badge `.workflow-tab-badge` offers, because that
 * badge is amber and amber on this surface means somebody is needed. How many runs exist is
 * not an attention fact.
 */
export function RunsKindTabs({
  kind,
  workflowRuns,
  pipelineRuns,
  onKind,
}: {
  kind: RunsKind;
  workflowRuns: number;
  pipelineRuns: number;
  onKind: (kind: RunsKind) => void;
}): React.JSX.Element {
  const tabs: { id: RunsKind; label: string; count: number; hint: string }[] = [
    {
      id: "workflows",
      label: "Workflows",
      count: workflowRuns,
      hint: "Reviews Mission Control's own workflows have run over a session's work",
    },
    {
      id: "pipelines",
      label: "Pipelines",
      count: pipelineRuns,
      hint: "Features an external SDLC engine is driving, in the repositories you observe",
    },
  ];
  return (
    <div className="workflow-tabs" role="tablist" aria-label="Runs">
      {tabs.map((tab) => (
        <Tooltip key={tab.id} label={tab.hint}>
          <button
            type="button"
            role="tab"
            aria-selected={kind === tab.id}
            className={kind === tab.id ? "active" : ""}
            // Re-clicking the tab you are already on does NOTHING, and the guard lives here
            // rather than in the caller so no later caller has to remember it. A tab is a
            // statement about which surface is showing, not a reset button: without this,
            // clicking "Workflows" while a run is open navigates to the bare `#/runs` the
            // caller builds for a genuine switch, and the reader silently drops the run - the
            // same for a pipeline run and `#/runs/pipeline`. The route-level same-hash guard
            // cannot catch it, because those two hashes really are different.
            onClick={() => {
              if (kind === tab.id) return;
              onKind(tab.id);
            }}
          >
            {tab.label} {tab.count}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}
