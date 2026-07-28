import { useMemo } from "react";
import { ensembleIsTerminal, type EnsembleEvaluation } from "@shared/ensemble.ts";
import { parseBestOfNComparison, type BestOfNComparison } from "@shared/ensemble-strategies/best-of-n.ts";
import type { EnsembleResultContext } from "./index.ts";
import { DecisionPanel } from "./DecisionPanel.tsx";
import {
  AtStake,
  CandidateColumn,
  DecisionRecord,
  recordedDecision,
} from "./dossier.tsx";
import {
  chooseCompareArtifactIds,
  eligibleCompareArtifacts,
} from "../compare.ts";

/**
 * Best-of-N's result presentation: the anonymous comparison, one column per candidate, and -
 * only while the run awaits a person - the select-one decision panel. Everything strategy
 * specific about the OUTCOME lives here, so the generic detail and engine never branch on
 * `best_of_n`; a future strategy adds its own renderer to the registry beside this one.
 *
 * The evaluator judged blind, but the operator view is not blind: `subjectLabel` reveals which
 * member produced each artifact after the fact, while the column keeps the rank/score the
 * anonymous comparison assigned.
 *
 * At the decision - and afterwards, as the durable record of it - this becomes a DOSSIER: what
 * was at stake leads, each column composes that candidate's claims, observed diffstat and cost
 * with its score, and the decision sits at the bottom where the evidence has already been read.
 * The pieces are shared (`dossier.tsx`) and only the score line is this strategy's own words.
 */

/** The newest succeeded comparison, parsed into a renderable, de-anonymised scorecard set. */
function latestComparison(
  evaluations: EnsembleEvaluation[],
): { evaluation: EnsembleEvaluation; comparison: BestOfNComparison } | null {
  const succeeded = evaluations
    .filter((e) => e.status === "succeeded" && e.result)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const evaluation of succeeded) {
    const comparison = parseBestOfNComparison(evaluation.result?.body ?? null);
    if (comparison) return { evaluation, comparison };
  }
  return null;
}

export function BestOfNResult(ctx: EnsembleResultContext): React.JSX.Element | null {
  const found = useMemo(() => latestComparison(ctx.detail.evaluations), [ctx.detail.evaluations]);
  const record = useMemo(() => recordedDecision(ctx.detail.decisions), [ctx.detail.decisions]);
  const artifactById = useMemo(
    () => new Map(ctx.detail.artifacts.map((artifact) => [artifact.id, artifact])),
    [ctx.detail.artifacts],
  );
  if (!found) {
    return (
      <p className="ensemble-empty">
        No comparison has been recorded yet. It runs once every live member has submitted or
        terminated and at least two produced a snapshot.
      </p>
    );
  }
  const { evaluation, comparison } = found;
  const status = ctx.detail.run.status;
  // The read-only half of the dossier is gated on a TERMINAL run with a recorded decision, not
  // on the decision row alone: while a run is finalizing the operator's answer is in flight, and
  // presenting it as the settled record - with Restore beside the losers - would offer to reset a
  // checkout the finalizer is at that moment resetting itself.
  const settled = status !== null && ensembleIsTerminal(status) && record !== null;
  const dossier = ctx.decision !== null || settled;
  const restorable = settled && record!.readable && Boolean(ctx.onRestoreArtifact);
  const eligibleIds = eligibleCompareArtifacts(ctx.detail).map((artifact) => artifact.id);
  const rankedIds = comparison.scorecards.map((card) => card.artifactId);

  return (
    <div className="ensemble-result">
      {/* Above the Comparison header, not under it: the dossier is read top-down and the first
          question is what this run was for, not which model ranked it. */}
      {dossier && <AtStake detail={ctx.detail} />}
      <header className="ensemble-result-head">
        <h4>Comparison</h4>
        <small>
          {evaluation.runnerId ?? "runner"} · {evaluation.modelId ?? "model"} · attempt{" "}
          {evaluation.attempt}
        </small>
      </header>
      {comparison.evidenceTruncated && (
        <p className="ensemble-warn" role="note">
          Some candidate diffs were truncated for the evaluator. Trust the ranking less.
        </p>
      )}
      {comparison.comparison && <p className="ensemble-result-summary">{comparison.comparison}</p>}
      {comparison.caveats.length > 0 && (
        <div className="ensemble-caveats">
          <h5>Caveats</h5>
          <ul>
            {comparison.caveats.map((caveat, i) => (
              <li key={i}>{caveat}</li>
            ))}
          </ul>
        </div>
      )}
      <ol className="ensemble-scorecards dossier-cols">
        {comparison.scorecards.map((card) => {
          const compareArtifactIds = chooseCompareArtifactIds({
            scoredArtifactId: card.artifactId,
            currentSelection: [],
            recommendedArtifactId: comparison.recommendedArtifactId,
            rankedArtifactIds: rankedIds,
            eligibleArtifactIds: eligibleIds,
          });
          return (
            <CandidateColumn
              key={card.artifactId}
              artifact={artifactById.get(card.artifactId) ?? null}
              subjectLabel={ctx.subjectLabel(card.artifactId)}
              verdict={{
                rank: card.rank,
                scoreLine: `score ${card.score}/100 · confidence ${Math.round(card.confidence * 100)}%`,
                rationale: card.rationale,
                strengths: card.strengths,
                risks: card.risks,
                recommended: card.artifactId === comparison.recommendedArtifactId,
              }}
              onOpenArtifact={
                ctx.onOpenArtifact ? () => ctx.onOpenArtifact?.(card.artifactId) : undefined
              }
              compareArtifactIds={compareArtifactIds}
              onOpenCompare={ctx.onOpenCompare}
              onRestore={
                restorable && card.artifactId !== record!.selectedArtifactId
                  ? () => ctx.onRestoreArtifact?.(card.artifactId)
                  : undefined
              }
              restorePending={ctx.restorePendingArtifactId === card.artifactId}
            />
          );
        })}
      </ol>
      {ctx.decision ? (
        <DecisionPanel
          choices={comparison.scorecards.map((card) => ({
            artifactId: card.artifactId,
            label: `#${card.rank} ${ctx.subjectLabel(card.artifactId)}${
              card.artifactId === comparison.recommendedArtifactId ? " (recommended)" : ""
            }`,
            tip: `Select ${ctx.subjectLabel(card.artifactId)} as the winner`,
          }))}
          recommendedArtifactId={comparison.recommendedArtifactId}
          intro="The comparison recommends, it does not promote. Confirming a winner resets that member's checkout to its submitted snapshot and reaps every other worktree; the losers' snapshot refs are kept."
          overrideWarning="You are overriding the recommendation. That is allowed; the evidence is above."
          decision={ctx.decision}
        />
      ) : settled ? (
        <DecisionRecord record={record!} subjectLabel={ctx.subjectLabel} restorable={restorable} />
      ) : null}
    </div>
  );
}
