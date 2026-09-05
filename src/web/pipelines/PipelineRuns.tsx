import { Fragment, useMemo, useState } from "react";
import type { Task } from "@shared/types.ts";
import {
  PIPELINE_DAEMON_ACTIONS,
  pipelineAdoptionRecoveryIsResumable,
  pipelineGrantAllowed,
  pipelineRecoveryIsActive,
  pipelineRecoveryPredecessorGuard,
  pipelineRepoKey,
  pipelineRetryRecoveryIsResumable,
  pipelineRunKeyOf,
  type PipelineAction,
  type PipelineConsole,
  type PipelineRun,
  type PipelineCommission,
  type PipelineRecoveryOperation,
} from "@shared/pipeline.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { repoLeaf } from "../lib/format.ts";
import { api } from "../lib/api.ts";
import type { PipelineRunAddress } from "../workflows/useWorkflowRoute.ts";
import { PipelineActions } from "./PipelineActions.tsx";
import { PipelineFeatureReader } from "./PipelineFeatureReader.tsx";
import {
  featureRecordForRun,
  resolvePipelineFeatureSelection,
} from "./pipeline-feature-selection.ts";
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
  tasks = [],
  selectedCommissionId,
  onSelectCommission,
  selected,
  onSelect,
  onOpenSettings,
}: {
  runs: PipelineRun[];
  commissions: PipelineCommission[];
  tasks?: Task[];
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
  const [checkingCommissionId, setCheckingCommissionId] = useState<string | null>(null);
  const [startingCommissionId, setStartingCommissionId] = useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = useState<PipelineRecoveryOperation | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const sections = useMemo(() => pipelineRail(runs, repos ?? []), [runs, repos]);

  const addressed = findPipelineRun(runs, selected);
  // The tab opens on whatever needs somebody, across every repository rather than within the
  // first one that has anything - see `pipelineLeadRun`. Selecting nothing at all would make
  // the common case (one run in flight) a page with an empty reader beside a rail of one.
  const fallback = pipelineLeadRun(sections);
  // The two provider records describe one feature on opposite sides of specification handoff.
  // Resolve both directions so selection changes address, not which evidence the reader hides.
  const { activeRun, activeCommission } = resolvePipelineFeatureSelection({
    runs,
    commissions,
    addressedRun: addressed,
    fallbackRun: fallback,
    hasSelectedRunAddress: selected !== null,
    selectedCommissionId,
  });
  const detail = usePipelineRunDetail(
    activeRun?.provider ?? null,
    activeRun?.repoRoot ?? null,
    activeRun?.slug ?? null,
    activeRun?.updatedAt ?? 0,
  );
  const activeTask = activeCommission
    ? tasks.find((task) => task.id === activeCommission.taskId) ?? null
    : null;
  // The daemon verbs on offer follow the daemon this run's own repository reports, which is
  // the rail's chip: three of the four are no-ops at any moment, and offering the one that
  // does nothing is what teaches an operator to stop trusting the row. `unknown` when the
  // rail has not answered yet, which offers both ends rather than guessing.
  const daemon =
    activeRun && repos
      ? (repos.find((repo) => pipelineRepoKey(repo.provider, repo.repoRoot) === pipelineRepoKey(activeRun.provider, activeRun.repoRoot))
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
    !activeRun || activeRun.group === "processed"
      ? []
      : [
          activeRun.group === "parked" ? "unpark" : "park",
          ...(pipelineGrantAllowed(activeRun.halt) ? (["grant"] as const) : []),
        ];
  const runActions: PipelineAction[] = activeRun
    ? [...PIPELINE_DAEMON_ACTIONS[daemon], ...runVerbs]
    : [];
  // The reseal ceremony is offered where it applies rather than always: it is the way out of
  // one halt class, and a permanent button for breaking a seal invites breaking one.
  const runConsoles: PipelineConsole[] =
    activeRun?.halt?.class === "protected-artifact" ? ["daemon", "reseal"] : ["daemon"];

  // Through the shared helper rather than joined here: a repository root and a slug
  // concatenated with nothing between them are ambiguous, so `("/repo/foo", "1-fix")` and
  // `("/repo/foo1", "-fix")` would produce one key - two different runs sharing one React key
  // and one "active" mark.
  const activeKey = activeRun ? pipelineRunKeyOf(activeRun) : null;
  const recheckReadiness = async (): Promise<void> => {
    if (!activeCommission || checkingCommissionId) return;
    setCheckingCommissionId(activeCommission.id);
    setReadinessError(null);
    const result = await api.recheckPipelineReadiness(activeCommission.taskId);
    if (!result.ok) setReadinessError(result.error ?? "Readiness could not be checked");
    setCheckingCommissionId(null);
  };
  const startAfterReadiness = async (): Promise<void> => {
    if (!activeCommission || startingCommissionId) return;
    setStartingCommissionId(activeCommission.id);
    setReadinessError(null);
    const result = await api.startPipelineAfterReadiness(activeCommission.taskId);
    if (!result.ok) setReadinessError(result.error ?? "Engineer could not be started");
    setStartingCommissionId(null);
  };
  const canStartAfterReadiness = activeCommission?.readiness?.permitted === true &&
    checkingCommissionId === null &&
    activeCommission.lifecycle === "created" &&
    !pipelineRecoveryIsActive(activeCommission.recovery) &&
    activeTask?.status === "running" &&
    !activeTask.sessionId;
  const activeAttempt = activeCommission?.attempts.find(
    (attempt) => attempt.attempt === activeCommission.activeAttempt,
  ) ?? null;
  const recoveryGuard = activeCommission && activeAttempt?.engineerRunId &&
    activeAttempt.providerRevision > 0
    ? {
        commissionId: activeCommission.id,
        activeAttempt: activeAttempt.attempt,
        engineerRunId: activeAttempt.engineerRunId,
        providerRevision: activeAttempt.providerRevision,
      }
    : null;
  const predecessorGuard = activeCommission
    ? pipelineRecoveryPredecessorGuard(activeCommission)
    : null;
  const retryGuard = activeCommission && pipelineRetryRecoveryIsResumable(activeCommission.recovery)
    ? predecessorGuard
    : recoveryGuard;
  const adoptionGuard = activeCommission &&
    pipelineAdoptionRecoveryIsResumable(activeCommission.recovery)
    ? predecessorGuard
    : recoveryGuard;
  const recover = async (
    action: "retry" | "refresh" | "adopt" | "abandon" | "cancel",
  ): Promise<void> => {
    const actionGuard = action === "retry"
      ? retryGuard
      : action === "adopt" ? adoptionGuard : recoveryGuard;
    if (!activeCommission || !actionGuard || recoveryBusy) return;
    setRecoveryBusy(action);
    setReadinessError(null);
    const candidate = activeCommission.successorCandidate;
    let result: Awaited<ReturnType<typeof api.retryPipelineAttempt>>;
    switch (action) {
      case "retry":
        result = await api.retryPipelineAttempt(activeCommission.taskId, { guard: actionGuard });
        break;
      case "refresh":
        result = await api.refreshPipelineSuccessor(activeCommission.taskId, { guard: actionGuard });
        break;
      case "adopt":
        if (!candidate?.fingerprint) {
          setReadinessError("The exact successor fingerprint is unavailable. Refresh before adopting.");
          setRecoveryBusy(null);
          return;
        }
        result = await api.adoptPipelineSuccessor(activeCommission.taskId, {
          guard: actionGuard,
          candidateEngineerRunId: candidate.engineerRunId,
          candidateRevision: candidate.providerRevision,
          candidateFingerprint: candidate.fingerprint,
        });
        break;
      case "abandon":
        result = await api.abandonPipelineCommission(activeCommission.taskId, { guard: actionGuard });
        break;
      case "cancel":
        result = await api.cancelPipelineCommission(activeCommission.taskId, { guard: actionGuard });
        break;
    }
    if (!result.ok) setReadinessError(result.error ?? "Pipeline recovery could not be completed");
    setRecoveryBusy(null);
  };

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
              const linked = featureRecordForRun(runs, (candidate) => candidate, entry.linkedRun);
              const label = entry.handoff?.planSlug ?? `commission ${entry.id.slice(0, 8)}`;
              return (
                <div className="pipelines-row-pair" key={entry.id}>
                  <Tooltip label={`Open ${label}`}>
                    <button
                      type="button"
                      className={`pipelines-row${entry.id === activeCommission?.id ? " active" : ""}`}
                      aria-current={entry.id === activeCommission?.id}
                      onClick={() => onSelectCommission(entry.id)}
                    >
                      <span className="pipelines-row-head">
                        <strong>{entry.handoff?.planSlug ?? `Commission ${entry.id.slice(0, 8)}`}</strong>
                        {entry.tier && <span className="pipelines-row-tier">{entry.tier}</span>}
                      </span>
                      <span className="pipelines-row-line">{pipelineCommissionLine(entry, linked)}</span>
                    </button>
                  </Tooltip>
                  {linked && (
                    <Tooltip label={`Open implementation run ${linked.slug}`}>
                      <button
                        type="button"
                        className="pipelines-row-run"
                        aria-label={`Open implementation run ${linked.slug}`}
                        onClick={() => onSelect(linked)}
                      >
                        <span aria-hidden>↗</span>
                      </button>
                    </Tooltip>
                  )}
                </div>
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
        {activeRun || activeCommission ? (
          <PipelineFeatureReader
            activeRun={activeRun}
            activeCommission={activeCommission}
            detail={detail}
            actions={
              activeRun ? <PipelineActions
                run={activeRun}
                actions={runActions}
                consoles={runConsoles}
                onRefresh={refresh}
              /> : null
            }
            checkingReadiness={checkingCommissionId === activeCommission?.id}
            onRecheckReadiness={() => { void recheckReadiness(); }}
            canStartAfterReadiness={canStartAfterReadiness}
            startingAfterReadiness={startingCommissionId === activeCommission?.id}
            onStartAfterReadiness={() => { void startAfterReadiness(); }}
            recoveryBusy={recoveryBusy}
            onRetry={() => { void recover("retry"); }}
            onRefreshSuccessor={() => { void recover("refresh"); }}
            onAdoptSuccessor={() => { void recover("adopt"); }}
            onAbandon={() => { void recover("abandon"); }}
            onCancel={() => { void recover("cancel"); }}
            canSettleCommission={recoveryGuard !== null}
            onSelectRun={onSelect}
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
        {readinessError && <p className="pipelines-repo-error" role="alert">{readinessError}</p>}
      </div>
    </section>
  );
}
