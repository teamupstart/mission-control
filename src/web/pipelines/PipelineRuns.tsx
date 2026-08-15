import { Fragment, useMemo } from "react";
import { pipelineRunKeyOf, type PipelineRun } from "@shared/pipeline.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { repoLeaf } from "../lib/format.ts";
import type { PipelineRunAddress } from "../workflows/useWorkflowRoute.ts";
import { PipelineRunView } from "./PipelineRunView.tsx";
import {
  PIPELINE_DAEMON_LABELS,
  PIPELINE_GROUP_LABELS,
  PIPELINE_GROUP_TONES,
  findPipelineRun,
  pipelineLeadRun,
  pipelineRail,
  pipelineRunLine,
} from "./pipeline-run-model.ts";
import { usePipelineRepos } from "./usePipelineRepos.ts";
import { usePipelineRunDetail } from "./usePipelineRunDetail.ts";

/**
 * The Pipelines surface: a rail of what an external engine is driving, and one run in full.
 *
 * A sibling of `WorkflowRuns`, not an extension of it. The two answer the same question -
 * what is executing - about two different engines, and the approved plan is explicit that
 * the workflow surface is not modified by this work: they share the page frame, the kind tab
 * above them and the fleet's status-tone vocabulary, and nothing else.
 *
 * Runs arrive over the event stream, already grouped and classified by the daemon from the
 * engine's own files. This component derives no state a reader will act on: it groups the
 * projection under the repositories it came from and hands one run to the detail view.
 */
export function PipelineRuns({
  runs,
  selected,
  onSelect,
  onOpenSettings,
}: {
  runs: PipelineRun[];
  /** The run the address bar names, or null for the bare tab. */
  selected: PipelineRunAddress | null;
  onSelect: (run: PipelineRun) => void;
  /** Where the engine itself is configured - the Conductor settings category. */
  onOpenSettings: () => void;
}): React.JSX.Element {
  // Mounted only when the tab is showing, so the poll's `active` is unconditional here: the
  // tab itself is what gates it, and it does not exist for an operator observing nothing.
  const repos = usePipelineRepos(true);
  const sections = useMemo(() => pipelineRail(runs, repos ?? []), [runs, repos]);

  const addressed = findPipelineRun(runs, selected);
  // The tab opens on whatever needs somebody, across every repository rather than within the
  // first one that has anything - see `pipelineLeadRun`. Selecting nothing at all would make
  // the common case (one run in flight) a page with an empty reader beside a rail of one.
  const fallback = pipelineLeadRun(sections);
  const run = addressed ?? (selected === null ? fallback : null);
  const detail = usePipelineRunDetail(
    run?.provider ?? null,
    run?.repoRoot ?? null,
    run?.slug ?? null,
    run?.updatedAt ?? 0,
  );
  // Through the shared helper rather than joined here: a repository root and a slug
  // concatenated with nothing between them are ambiguous, so `("/repo/foo", "1-fix")` and
  // `("/repo/foo1", "-fix")` would produce one key - two different runs sharing one React key
  // and one "active" mark.
  const activeKey = run ? pipelineRunKeyOf(run) : null;

  return (
    <section className="pipelines">
      <aside className="pipelines-rail">
        {repos === null && <p className="pipelines-note">Reading the engine's repositories…</p>}
        {sections.map((section) => (
          <div className="pipelines-repo" key={section.key}>
            <header className="pipelines-repo-head">
              <Tooltip label={section.repoRoot}>
                <strong>{repoLeaf(section.repoRoot)}</strong>
              </Tooltip>
              {/* The daemon chip is the distinction an operator acts on: a run that is
                  waiting and a run that is ready look identical in the engine's state file
                  and differ only by whether anything is alive to advance them. */}
              <span
                className={`workflow-chip workflow-${
                  section.daemon === "running"
                    ? "running"
                    : section.daemon === "paused"
                      ? "waiting"
                      : "stopped"
                }`}
              >
                {PIPELINE_DAEMON_LABELS[section.daemon]}
              </span>
              <small>
                {section.total} {section.total === 1 ? "pipeline" : "pipelines"}
              </small>
            </header>
            {section.error && (
              <p className="pipelines-repo-error" role="alert">
                {section.error}
              </p>
            )}
            {section.total === 0 && (
              <p className="pipelines-note">
                Nothing in flight here. A feature appears when the engine cuts its worktree.
              </p>
            )}
            {section.groups.map((group) => (
              <Fragment key={group.group}>
                <p className="pipelines-group">
                  {PIPELINE_GROUP_LABELS[group.group]} {group.runs.length}
                </p>
                {group.runs.map((entry) => {
                  const key = pipelineRunKeyOf(entry);
                  return (
                    <Tooltip
                      key={key}
                      label={`Open ${entry.slug} - ${PIPELINE_GROUP_LABELS[entry.group].toLowerCase()}`}
                    >
                      <button
                        type="button"
                        className={`pipelines-row${key === activeKey ? " active" : ""}`}
                        aria-current={key === activeKey}
                        onClick={() => onSelect(entry)}
                      >
                        <span className="pipelines-row-head">
                          <strong>{entry.slug}</strong>
                          {entry.tier && (
                            <span className="pipelines-row-tier">{entry.tier}</span>
                          )}
                        </span>
                        <span
                          className={`workflow-chip workflow-${PIPELINE_GROUP_TONES[entry.group]}`}
                        >
                          {PIPELINE_GROUP_LABELS[entry.group]}
                        </span>
                        <span className="pipelines-row-line">{pipelineRunLine(entry)}</span>
                      </button>
                    </Tooltip>
                  );
                })}
              </Fragment>
            ))}
          </div>
        ))}
      </aside>
      <div className="pipelines-reader">
        {run ? (
          <PipelineRunView run={run} detail={detail} />
        ) : (
          <div className="workflow-empty">
            <span className="workflow-empty-mark" aria-hidden>
              ◇
            </span>
            <h3>{selected ? "That pipeline is not being observed" : "No pipelines yet"}</h3>
            <p>
              {selected
                ? "The link names a feature this daemon is not projecting - its repository may have been switched off, or the engine may have torn the worktree down."
                : "Mission Control is watching, and the engine has nothing in flight. A feature appears here as soon as it cuts a worktree."}
            </p>
            <Tooltip label="Which repositories are observed, and whether the engine was found, in Settings">
              <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
                Conductor settings<span aria-hidden>→</span>
              </button>
            </Tooltip>
          </div>
        )}
      </div>
    </section>
  );
}
