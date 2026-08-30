import { Fragment, useMemo } from "react";
import {
  PIPELINE_DAEMON_ACTIONS,
  pipelineGrantAllowed,
  pipelineRepoKey,
  pipelineRunKeyOf,
  type PipelineAction,
  type PipelineConsole,
  type PipelineRun,
  type PipelineCommission,
} from "@shared/pipeline.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { repoLeaf } from "../lib/format.ts";
import type { PipelineRunAddress } from "../workflows/useWorkflowRoute.ts";
import { PipelineActions } from "./PipelineActions.tsx";
import { PipelineRunView } from "./PipelineRunView.tsx";
import {
  PIPELINE_DAEMON_LABELS,
  PIPELINE_GROUP_LABELS,
  PIPELINE_GROUP_TONES,
  findPipelineRun,
  pipelineLeadRun,
  pipelineRail,
  pipelineRunLine,
  pipelineCommissionLine,
} from "./pipeline-run-model.ts";
import { PipelinePhaseMeter } from "./PipelinePhaseMeter.tsx";
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
  commissions,
  selectedCommissionId,
  onSelectCommission,
  selected,
  onSelect,
  onOpenSettings,
}: {
  runs: PipelineRun[];
  commissions: PipelineCommission[];
  selectedCommissionId: string | null;
  onSelectCommission: (commissionId: string) => void;
  /** The run the address bar names, or null for the bare tab. */
  selected: PipelineRunAddress | null;
  onSelect: (run: PipelineRun) => void;
  /** Where the engine itself is configured - the Conductor settings category. */
  onOpenSettings: () => void;
}): React.JSX.Element {
  // Mounted only when the tab is showing, so the poll's `active` is unconditional here: the
  // tab itself is what gates it, and it does not exist for an operator observing nothing.
  const { repos, refresh } = usePipelineRepos(true);
  const sections = useMemo(() => pipelineRail(runs, repos ?? []), [runs, repos]);

  const addressed = findPipelineRun(runs, selected);
  // The tab opens on whatever needs somebody, across every repository rather than within the
  // first one that has anything - see `pipelineLeadRun`. Selecting nothing at all would make
  // the common case (one run in flight) a page with an empty reader beside a rail of one.
  const fallback = pipelineLeadRun(sections);
  const run = addressed ?? (selected === null ? fallback : null);
  const commission =
    commissions.find((entry) => entry.id === selectedCommissionId) ??
    (selected === null && !run ? commissions[0] ?? null : null);
  const linkedCommissionRun = commission?.linkedRun ?? null;
  const commissionRun =
    linkedCommissionRun
      ? (runs.find(
          (candidate) => pipelineRunKeyOf(candidate) === pipelineRunKeyOf(linkedCommissionRun),
        ) ?? null)
      : null;
  const detail = usePipelineRunDetail(
    run?.provider ?? null,
    run?.repoRoot ?? null,
    run?.slug ?? null,
    run?.updatedAt ?? 0,
  );
  // The daemon verbs on offer follow the daemon this run's own repository reports, which is
  // the rail's chip: three of the four are no-ops at any moment, and offering the one that
  // does nothing is what teaches an operator to stop trusting the row. `unknown` when the
  // rail has not answered yet, which offers both ends rather than guessing.
  const daemon =
    run && repos
      ? (repos.find((repo) => pipelineRepoKey(repo.provider, repo.repoRoot) === pipelineRepoKey(run.provider, run.repoRoot))
          ?.daemon ?? "unknown")
      : "unknown";
  // A FINISHED feature offers no feature verbs, by the same rule: the engine would accept a
  // park or a grant on a slug it has already processed and print a success line for it, and a
  // verb whose only effect is that sentence is one an operator learns to distrust. The daemon
  // verbs stay, because they are about the repository rather than about this run.
  //
  // Park and unpark apply to any live feature - parking is how an operator takes one out of
  // the engine's hands, halted or not. A GRANT does not: it is the answer to a refusal, and
  // `pipelineGrantAllowed` reads that off the same halt-class table the attention inbox draws
  // its verbs from, so the two surfaces cannot come to different conclusions about when a
  // DECIDE re-entry is a thing to offer.
  const runVerbs: PipelineAction[] =
    !run || run.group === "processed"
      ? []
      : [
          run.group === "parked" ? "unpark" : "park",
          ...(pipelineGrantAllowed(run.halt) ? (["grant"] as const) : []),
        ];
  const runActions: PipelineAction[] = run
    ? [...PIPELINE_DAEMON_ACTIONS[daemon], ...runVerbs]
    : [];
  // The reseal ceremony is offered where it applies rather than always: it is the way out of
  // one halt class, and a permanent button for breaking a seal invites breaking one.
  const runConsoles: PipelineConsole[] =
    run?.halt?.class === "protected-artifact" ? ["daemon", "reseal"] : ["daemon"];

  // Through the shared helper rather than joined here: a repository root and a slug
  // concatenated with nothing between them are ambiguous, so `("/repo/foo", "1-fix")` and
  // `("/repo/foo1", "-fix")` would produce one key - two different runs sharing one React key
  // and one "active" mark.
  const activeKey = run ? pipelineRunKeyOf(run) : null;

  return (
    <section className="pipelines">
      <aside className="pipelines-rail">
        {commissions.length > 0 && (
          <div className="pipelines-repo">
            <header className="pipelines-repo-head">
              <strong>Planning</strong>
              <small>{commissions.length} commissioned</small>
            </header>
            {commissions.map((entry) => {
              const linked = entry.linkedRun
                ? (runs.find((candidate) => pipelineRunKeyOf(candidate) === pipelineRunKeyOf(entry.linkedRun!)) ?? null)
                : null;
              return (
                <Tooltip
                  key={entry.id}
                  label={`Open ${entry.handoff?.planSlug ?? `commission ${entry.id.slice(0, 8)}`}`}
                >
                  <button
                    type="button"
                    className={`pipelines-row${entry.id === commission?.id ? " active" : ""}`}
                    aria-current={entry.id === commission?.id}
                    onClick={() => onSelectCommission(entry.id)}
                  >
                    <span className="pipelines-row-head">
                      <strong>{entry.handoff?.planSlug ?? `Commission ${entry.id.slice(0, 8)}`}</strong>
                      {entry.tier && <span className="pipelines-row-tier">{entry.tier}</span>}
                    </span>
                    <span className="pipelines-row-line">{pipelineCommissionLine(entry, linked)}</span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
        )}
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
        {commission ? (
          <section className="pipeline-run" aria-label="Pipeline commission detail">
            <header className="pipeline-run-head">
              <div>
                <span className="workflow-eyebrow">Pipeline commission</span>
                <h2>{commission.handoff?.planSlug ?? "Engineer planning"}</h2>
                <p>{pipelineCommissionLine(commission, commissionRun)}</p>
              </div>
            </header>
            <PipelinePhaseMeter run={commissionRun} commission={commission} />
            <section className="pipelines-section" aria-label="Engineer attempts">
              <h4>Engineer attempts</h4>
              <div className="pipelines-attempt-row">
                {commission.attempts.map((attempt) => (
                  <article
                    className={`pipelines-attempt${attempt.attempt === commission.activeAttempt ? " is-current" : ""}`}
                    aria-current={attempt.attempt === commission.activeAttempt ? "true" : undefined}
                    key={attempt.attempt}
                  >
                    <span className="pipelines-attempt-name">Attempt {attempt.attempt}</span>
                    <span className="pipelines-attempt-line">{attempt.state}</span>
                    <small>{attempt.engineerRunId ?? "run reservation pending"}</small>
                  </article>
                ))}
              </div>
            </section>
            {commission.handoff && (
              <section className="pipelines-section" aria-label="Specification handoff">
                <h4>Specification handoff</h4>
                <p>Branch <code>{commission.handoff.branch}</code></p>
                {commission.handoff.prUrl ? (
                  <Tooltip label="Open specification pull request">
                    <a href={commission.handoff.prUrl} target="_blank" rel="noreferrer">Open specification pull request</a>
                  </Tooltip>
                ) : (
                  <p>Local specification commit - no pull request URL was reported.</p>
                )}
              </section>
            )}
            {commission.linkedRun && (
              <section className="pipelines-section" aria-label="Implementation run">
                <h4>Implementation run</h4>
                <p>{commission.linkedRun.slug}</p>
              </section>
            )}
            {commission.error && <p className="pipelines-repo-error" role="alert">{commission.error}</p>}
          </section>
        ) : run ? (
          <PipelineRunView
            run={run}
            detail={detail}
            actions={
              <PipelineActions
                run={run}
                actions={runActions}
                consoles={runConsoles}
                onRefresh={refresh}
              />
            }
          />
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
