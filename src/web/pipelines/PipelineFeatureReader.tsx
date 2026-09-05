import type { ReactNode } from "react";
import {
  PIPELINE_PROVIDER_INFO,
  pipelineRecoveryIsActive,
  pipelineRunKeyOf,
  type PipelineCommission,
  type PipelineRun,
} from "@shared/pipeline.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { relativeTime, repoLeaf } from "../lib/format.ts";
import { PipelinePhaseMeter } from "./PipelinePhaseMeter.tsx";
import { PipelineRunHeader, PipelineRunView } from "./PipelineRunView.tsx";
import { pipelineCommissionLine } from "./pipeline-run-model.ts";
import type { PipelineRunDetailState } from "./usePipelineRunDetail.ts";

function CommissionHeader({ commission }: { commission: PipelineCommission }): React.JSX.Element {
  return (
    <header className="pipelines-run-head">
      <div className="pipelines-run-identity">
        <p className="pipelines-run-eyebrow">Pipeline commission</p>
        <h3 className="pipelines-run-title">
          {commission.handoff?.planSlug ?? "Engineer planning"}
        </h3>
        <p className="pipelines-run-facts">
          <span>{pipelineCommissionLine(commission)}</span>
          {commission.tier && <span className="pipelines-chip">Tier {commission.tier}</span>}
          {commission.track && <span className="pipelines-chip">{commission.track}</span>}
        </p>
        <small>
          {PIPELINE_PROVIDER_INFO[commission.provider].label} · {repoLeaf(commission.repoRoot)} ·
          updated {relativeTime(commission.updatedAt)}
        </small>
      </div>
    </header>
  );
}

function EngineerAttempts({
  commission,
  expanded,
}: {
  commission: PipelineCommission;
  expanded: boolean;
}): React.JSX.Element {
  return (
    <details
      className="pipelines-section pipelines-disclosure"
      open={expanded}
      aria-label="Engineer attempts"
    >
      {/* Tooltip clones enabled triggers without emitting a wrapper, so summary remains the
          first direct DOM child required by the native details disclosure. */}
      <Tooltip label="Show or hide the Engineer attempt history">
        <summary>
          <h4>Engineer attempts</h4>
          <small>{commission.attempts.length} recorded</small>
        </summary>
      </Tooltip>
      <div className="pipelines-attempt-row">
        {commission.attempts.map((attempt) => (
          <article
            className={`pipelines-attempt${attempt.attempt === commission.activeAttempt ? " is-current" : ""}`}
            aria-current={attempt.attempt === commission.activeAttempt ? "true" : undefined}
            key={attempt.attempt}
          >
            <span className="pipelines-attempt-name">Attempt {attempt.attempt}</span>
            <span className="pipelines-attempt-line">{attempt.state}</span>
            <small>
              {attempt.origin === "provider_reconciled" ? "Reconciled provider attempt" :
                attempt.origin === "mission_control" ? "Mission Control attempt" : "Initial attempt"}
            </small>
            <small>{attempt.engineerRunId ?? "run reservation pending"}</small>
          </article>
        ))}
      </div>
    </details>
  );
}

function SpecificationHandoff({
  commission,
  run,
  expanded,
  onSelectRun,
}: {
  commission: PipelineCommission;
  run: PipelineRun | null;
  expanded: boolean;
  onSelectRun: (run: PipelineRun) => void;
}): React.JSX.Element | null {
  const handoff = commission.handoff;
  if (!handoff) return null;
  const implementationRun =
    run &&
    commission.linkedRun &&
    pipelineRunKeyOf(run) === pipelineRunKeyOf(commission.linkedRun)
      ? run
      : null;

  return (
    <details
      className="pipelines-section pipelines-disclosure"
      open={expanded}
      aria-label="Specification handoff"
    >
      {/* Keep this summary on Tooltip's wrapper-free path for native disclosure semantics. */}
      <Tooltip label="Show or hide the specification handoff">
        <summary>
          <h4>Specification handoff</h4>
          <small>
            {implementationRun ? "implementation active" : handoff.outcome.replaceAll("_", " ")}
          </small>
        </summary>
      </Tooltip>
      <p>
        Branch <code>{handoff.branch}</code>
      </p>
      {handoff.prUrl ? (
        <Tooltip label="Open specification pull request">
          <a href={handoff.prUrl} target="_blank" rel="noreferrer">
            Open specification pull request
          </a>
        </Tooltip>
      ) : (
        <p>Local specification commit - no pull request URL was reported.</p>
      )}
      {implementationRun && (
        <p className="pipelines-handoff-run">
          Implementation run
          <Tooltip label={`Open ${implementationRun.slug} as a directly addressed run`}>
            <button
              type="button"
              className="pipelines-inline-link"
              onClick={() => onSelectRun(implementationRun)}
            >
              Open implementation run {implementationRun.slug}
            </button>
          </Tooltip>
        </p>
      )}
    </details>
  );
}

function ProviderLifecycle({
  commission,
  checking,
  onRecheck,
  canStart,
  starting,
  onStart,
  recoveryBusy,
  onRetry,
  onRefreshSuccessor,
  onAdoptSuccessor,
  onAbandon,
  onCancel,
  implementationActive,
}: {
  commission: PipelineCommission;
  checking: boolean;
  onRecheck: () => void;
  canStart: boolean;
  starting: boolean;
  onStart: () => void;
  recoveryBusy: string | null;
  onRetry: () => void;
  onRefreshSuccessor: () => void;
  onAdoptSuccessor: () => void;
  onAbandon: () => void;
  onCancel: () => void;
  implementationActive: boolean;
}): React.JSX.Element {
  const readiness = commission.readiness ?? null;
  const failure = commission.failure ?? null;
  const retirement = commission.retirement ?? null;
  return (
    <section className="pipelines-section" aria-label="Provider lifecycle">
      <h4>Provider lifecycle</h4>
      <p>
        Ownership {commission.integrationOwner ? "confirmed" : "legacy provider"}
        {commission.integrationOwner && <> · <code>{commission.integrationOwner}</code></>}
      </p>
      {commission.readinessRequired ? readiness ? (
        <div className="pipelines-lifecycle-fact">
          <strong>{readiness.status === "ready" ? "Ready" : readiness.status === "blocked" ? "Launch blocked" : "Readiness inconclusive"}</strong>
          <p>{readiness.summary}</p>
          {readiness.remedy && <p>Remedy: {readiness.remedy}</p>}
          {readiness.diagnostic && (
            <details>
              <Tooltip label="Show provider diagnostic details">
                <summary>Provider diagnostic</summary>
              </Tooltip>
              <pre>{readiness.diagnostic}</pre>
            </details>
          )}
          {!readiness.permitted && readiness.retryable && (
            <Tooltip label="Recheck provider readiness for this attempt">
              <button type="button" className="btn btn-primary" onClick={onRecheck} disabled={checking}>
                {checking ? "Checking…" : "Check again"}
              </button>
            </Tooltip>
          )}
          {readiness.permitted && canStart && (
            <Tooltip label="Start the managed Engineer host for this ready attempt">
              <button type="button" className="btn btn-primary" onClick={onStart} disabled={starting}>
                {starting ? "Starting…" : "Start Engineer"}
              </button>
            </Tooltip>
          )}
        </div>
      ) : <p>Readiness evidence pending.</p> : <p>Legacy provider - no readiness gate advertised.</p>}
      {failure && (
        <div className="pipelines-lifecycle-fact" role="alert">
          <strong>{failure.summary}</strong>
          <p>{failure.class} · {failure.code}{failure.retryable ? " · retryable" : ""}</p>
          {failure.remedy && <p>Remedy: {failure.remedy}</p>}
          {failure.diagnostic && (
            <details>
              <Tooltip label="Show provider failure diagnostic details">
                <summary>Failure diagnostic</summary>
              </Tooltip>
              <pre>{failure.diagnostic}</pre>
            </details>
          )}
          {failure.retryable && !commission.successorCandidate && (
            <Tooltip label="Create the one permitted Engineer retry on a fresh host">
              <button type="button" className="btn btn-primary" onClick={onRetry} disabled={recoveryBusy !== null}>
                {recoveryBusy === "retry" ? "Retrying…" : "Retry Engineer"}
              </button>
            </Tooltip>
          )}
          <Tooltip label="Close this failed commission without changing its attempt history">
            <button type="button" className="btn" onClick={onAbandon} disabled={recoveryBusy !== null}>
              {recoveryBusy === "abandon" ? "Abandoning…" : "Abandon commission"}
            </button>
          </Tooltip>
        </div>
      )}
      {pipelineRecoveryIsActive(commission.recovery) && (
        <div className="pipelines-lifecycle-fact" role="status">
          <strong>Recovery {commission.recovery.state.replaceAll("_", " ")}</strong>
          {commission.recovery.error && <p>{commission.recovery.error}</p>}
        </div>
      )}
      {commission.successorCandidate && (
        <details className="pipelines-lifecycle-fact">
          <Tooltip label="Review the exact external successor without adopting it">
            <summary>Review successor attempt {commission.successorCandidate.attempt}</summary>
          </Tooltip>
          <p>
            Provider run <code>{commission.successorCandidate.engineerRunId}</code> directly
            follows the active attempt and is not part of Mission Control history.
          </p>
          <p>
            {commission.successorCandidate.validation === "valid"
              ? "Identity, lineage, journal, workspace, and handoff evidence match."
              : commission.successorCandidate.validationReason ?? "Refresh this successor before adoption."}
          </p>
          {commission.successorCandidate.validation === "valid" ? (
            <Tooltip label="Adopt this exact provider run and replay its immutable journal">
              <button type="button" className="btn btn-primary" onClick={onAdoptSuccessor} disabled={recoveryBusy !== null}>
                {recoveryBusy === "adopt" ? "Adopting…" : "Adopt exact successor"}
              </button>
            </Tooltip>
          ) : (
            <Tooltip label="Inspect the direct successor again without changing commission history">
              <button type="button" className="btn btn-primary" onClick={onRefreshSuccessor} disabled={recoveryBusy !== null}>
                {recoveryBusy === "refresh" ? "Refreshing…" : "Refresh successor evidence"}
              </button>
            </Tooltip>
          )}
        </details>
      )}
      {!failure && !commission.handoff && commission.lifecycle !== "cancelled" && (
        <Tooltip label="Cancel this active Pipeline commission">
          <button type="button" className="btn" onClick={onCancel} disabled={recoveryBusy !== null}>
            {recoveryBusy === "cancel" ? "Cancelling…" : "Cancel Pipeline"}
          </button>
        </Tooltip>
      )}
      {retirement ? (
        <p>Authoring workspace retired by the provider: {retirement.reason.replaceAll("_", " ")}.</p>
      ) : commission.retention ? (
        <p>Review workspace retained until {commission.retention.retentionDeadline}.</p>
      ) : null}
      {commission.handoff && !implementationActive && (
        <p>Implementation remains gated on specification merge.</p>
      )}
    </section>
  );
}

/**
 * One feature reader across the provider-owned specification handoff.
 *
 * Commission and implementation records arrive independently, so every region is evidence
 * gated. Once the run exists it owns identity and actions; the commission remains available
 * as collapsed provenance rather than disappearing behind a second reader.
 */
export function PipelineFeatureReader({
  activeCommission,
  activeRun,
  detail,
  actions,
  checkingReadiness = false,
  onRecheckReadiness = () => undefined,
  canStartAfterReadiness = false,
  startingAfterReadiness = false,
  onStartAfterReadiness = () => undefined,
  recoveryBusy = null,
  onRetry = () => undefined,
  onRefreshSuccessor = () => undefined,
  onAdoptSuccessor = () => undefined,
  onAbandon = () => undefined,
  onCancel = () => undefined,
  onSelectRun,
}: {
  activeCommission: PipelineCommission | null;
  activeRun: PipelineRun | null;
  detail: PipelineRunDetailState;
  actions?: ReactNode;
  checkingReadiness?: boolean;
  onRecheckReadiness?: () => void;
  canStartAfterReadiness?: boolean;
  startingAfterReadiness?: boolean;
  onStartAfterReadiness?: () => void;
  recoveryBusy?: string | null;
  onRetry?: () => void;
  onRefreshSuccessor?: () => void;
  onAdoptSuccessor?: () => void;
  onAbandon?: () => void;
  onCancel?: () => void;
  onSelectRun: (run: PipelineRun) => void;
}): React.JSX.Element {
  const commissionError = activeCommission?.error?.trim() || null;
  const runHalt = activeRun?.halt?.reason.trim() || null;

  return (
    <section
      className="pipelines-feature"
      aria-label={activeCommission ? "Pipeline commission detail" : "Pipeline run detail"}
    >
      {activeRun ? (
        <PipelineRunHeader run={activeRun} actions={actions} />
      ) : activeCommission ? (
        <CommissionHeader commission={activeCommission} />
      ) : null}

      <PipelinePhaseMeter run={activeRun} commission={activeCommission} />

      {activeCommission && (
        <ProviderLifecycle
          commission={activeCommission}
          checking={checkingReadiness}
          onRecheck={onRecheckReadiness}
          canStart={canStartAfterReadiness}
          starting={startingAfterReadiness}
          onStart={onStartAfterReadiness}
          recoveryBusy={recoveryBusy}
          onRetry={onRetry}
          onRefreshSuccessor={onRefreshSuccessor}
          onAdoptSuccessor={onAdoptSuccessor}
          onAbandon={onAbandon}
          onCancel={onCancel}
          implementationActive={activeRun !== null}
        />
      )}
      {activeCommission && (
        <EngineerAttempts
          key={`engineer-attempts:${activeCommission.id}`}
          commission={activeCommission}
          expanded={activeRun === null}
        />
      )}
      {activeCommission && (
        <SpecificationHandoff
          key={`specification-handoff:${activeCommission.id}`}
          commission={activeCommission}
          run={activeRun}
          expanded={activeRun === null}
          onSelectRun={onSelectRun}
        />
      )}

      {activeRun && (
        <PipelineRunView run={activeRun} detail={detail} showHeader={false} />
      )}

      {commissionError && commissionError !== runHalt && (
        <p className="pipelines-repo-error" role="alert">
          {commissionError}
        </p>
      )}
    </section>
  );
}
