import type { ReactNode } from "react";
import {
  PIPELINE_PROVIDER_INFO,
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
  onSelectRun,
}: {
  activeCommission: PipelineCommission | null;
  activeRun: PipelineRun | null;
  detail: PipelineRunDetailState;
  actions?: ReactNode;
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
