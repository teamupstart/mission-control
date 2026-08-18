import type {
  PersonaId,
  SessionActionId,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@shared/workflow.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { missionRouteHash } from "../workflows/useWorkflowRoute.ts";

export type LibraryUsageAsset =
  | { kind: "persona"; id: PersonaId }
  | { kind: "session_action"; id: SessionActionId };

export interface LibraryAssetUsageRow {
  workflow: WorkflowSummary;
  draft: boolean;
  published: boolean;
  liveRuns: WorkflowRunSummary[];
}

export interface LibraryAssetUsageView {
  rows: LibraryAssetUsageRow[];
  unresolvedWorkflowCount: number;
}

function referencesAsset(
  workflow: WorkflowSummary,
  asset: LibraryUsageAsset,
  graph: "draft" | "published",
): boolean {
  const references = workflow.assetReferences?.[graph];
  if (!references) return false;
  return asset.kind === "persona"
    ? references.personaIds.includes(asset.id)
    : references.sessionActionIds.includes(asset.id);
}

/**
 * The one browser-side join behind both Library footers.
 *
 * Current draft/published use comes from `WorkflowSummary`; live use comes from exact ids on
 * run summaries because a run can be pinned to a historical version the workflow summary no
 * longer describes. A live run whose workflow is absent from the catalog is counted but never
 * named from its denormalized string: omission is honest, a guessed link is not.
 */
export function libraryAssetUsageView(
  asset: LibraryUsageAsset,
  workflows: readonly WorkflowSummary[],
  runs: readonly WorkflowRunSummary[],
): LibraryAssetUsageView {
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const rows = new Map<string, LibraryAssetUsageRow>();

  for (const workflow of workflows) {
    const draft = referencesAsset(workflow, asset, "draft");
    const published = referencesAsset(workflow, asset, "published");
    if (draft || published) rows.set(workflow.id, { workflow, draft, published, liveRuns: [] });
  }

  const unresolvedWorkflowIds = new Set<string>();
  for (const run of runs) {
    const active = asset.kind === "persona"
      ? (run.activePersonaIds ?? []).includes(asset.id)
      : run.status === "waiting_for_action"
        && (run.activeSessionActionIds ?? []).includes(asset.id);
    if (!active) continue;
    const workflow = workflowsById.get(run.workflowId);
    if (!workflow) {
      unresolvedWorkflowIds.add(run.workflowId);
      continue;
    }
    const row = rows.get(workflow.id) ?? {
      workflow,
      draft: false,
      published: false,
      liveRuns: [],
    };
    row.liveRuns.push(run);
    rows.set(workflow.id, row);
  }

  return {
    rows: [...rows.values()].sort((left, right) =>
      left.workflow.name.localeCompare(right.workflow.name, "en-US")
      || left.workflow.id.localeCompare(right.workflow.id)),
    unresolvedWorkflowCount: unresolvedWorkflowIds.size,
  };
}

function runLink(row: LibraryAssetUsageRow): string {
  if (row.liveRuns.length === 1) {
    return missionRouteHash({ page: "runs", runId: row.liveRuns[0]!.id });
  }
  return missionRouteHash({
    page: "runs",
    filters: { workflowId: row.workflow.id },
  });
}

/** The shared Persona and Action footer that answers both durable and live usage. */
export function LibraryAssetUsage({
  asset,
  assetLabel,
  workflows,
  runs,
  hasSnapshot,
}: {
  asset: LibraryUsageAsset;
  assetLabel: "Persona" | "Action";
  workflows: readonly WorkflowSummary[];
  runs: readonly WorkflowRunSummary[];
  hasSnapshot: boolean;
}): React.JSX.Element | null {
  // An older daemon sends no reference field. Silence is the compatibility answer: drawing
  // the empty state would turn "this build cannot know" into "nothing uses this".
  if (!hasSnapshot || !workflows.some((workflow) => workflow.assetReferences !== undefined)) {
    return null;
  }

  const view = libraryAssetUsageView(asset, workflows, runs);
  const liveCount = view.rows.reduce((count, row) => count + row.liveRuns.length, 0);
  const unresolved = view.unresolvedWorkflowCount;
  return (
    <footer className={`lib-asset-usage${liveCount > 0 ? " is-live" : ""}`}>
      <div className="lib-asset-usage-head">
        <div>
          <h3>Used by</h3>
          <p>Workflow references to this {assetLabel}, kept separate by graph.</p>
        </div>
        {liveCount > 0 && (
          <span className="lib-asset-usage-live" role="status">
            <span aria-hidden="true" />
            {liveCount} {liveCount === 1 ? "run is" : "runs are"} gating now
          </span>
        )}
      </div>

      {view.rows.length === 0 ? (
        <p className="lib-asset-usage-empty">
          {unresolved > 0
            ? `No resolved workflows can be shown for this ${assetLabel}.`
            : `No workflows use this ${assetLabel}.`}
        </p>
      ) : (
        <ul className="lib-asset-usage-list">
          {view.rows.map((row) => (
            <li key={row.workflow.id}>
              <Tooltip label={`Open ${row.workflow.name} workflow`}>
                <a
                  className="lib-asset-usage-workflow"
                  href={missionRouteHash({
                    page: "library",
                    shelf: "workflows",
                    assetId: row.workflow.id,
                  })}
                >
                  {row.workflow.name}
                </a>
              </Tooltip>
              <span className="lib-asset-usage-scopes" aria-label="Reference graphs">
                {row.draft && <span>Draft</span>}
                {row.published && (
                  <span>Published v{row.workflow.publishedVersion ?? "?"}</span>
                )}
                {!row.draft && !row.published && <span>Pinned run</span>}
                {row.workflow.archivedAt !== null && <span>Archived</span>}
              </span>
              {row.liveRuns.length > 0 && (
                <Tooltip label={`Open ${row.workflow.name} live ${row.liveRuns.length === 1 ? "run" : "runs"}`}>
                  <a className="lib-asset-usage-run" href={runLink(row)}>
                    {row.liveRuns.length} {row.liveRuns.length === 1 ? "run" : "runs"} gating now
                  </a>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}

      {unresolved > 0 && (
        <p className="lib-asset-usage-unresolved">
          {unresolved} live {unresolved === 1 ? "workflow is" : "workflows are"} unavailable in
          this catalog and {unresolved === 1 ? "is" : "are"} omitted.
        </p>
      )}
    </footer>
  );
}
