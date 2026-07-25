import { useMemo, useState } from "react";
import type { EnsembleEvaluation, EnsembleSelectOneSelection } from "@shared/ensemble.ts";
import { parseBestOfNComparison, type BestOfNComparison } from "@shared/ensemble-strategies/best-of-n.ts";
import { Tooltip } from "../../components/Tooltip.tsx";
import type { EnsembleResultContext } from "./index.ts";

/**
 * Best-of-N's result presentation: the anonymous scorecards the comparison produced, and -
 * only while the run awaits a person - the select-one decision panel. Everything strategy
 * specific about the OUTCOME lives here, so the generic detail and engine never branch on
 * `best_of_n`; a future strategy adds its own renderer to the registry beside this one.
 *
 * The evaluator judged blind, but the operator view is not blind: `subjectLabel` reveals which
 * member produced each artifact after the fact, while the scorecard keeps the rank/score the
 * anonymous comparison assigned.
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
  if (!found) {
    return (
      <p className="ensemble-empty">
        No comparison has been recorded yet. It runs once every live member has submitted or
        terminated and at least two produced a snapshot.
      </p>
    );
  }
  const { evaluation, comparison } = found;
  return (
    <div className="ensemble-result">
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
      <ol className="ensemble-scorecards">
        {comparison.scorecards.map((card) => {
          const recommended = card.artifactId === comparison.recommendedArtifactId;
          return (
            <li
              key={card.artifactId}
              className={`ensemble-scorecard${recommended ? " recommended" : ""}`}
            >
              <header>
                <span className="ensemble-rank" aria-label={`Rank ${card.rank}`}>
                  #{card.rank}
                </span>
                <span className="ensemble-subject">{ctx.subjectLabel(card.artifactId)}</span>
                {recommended && <span className="ensemble-recommended-tag">Recommended</span>}
                <span className="ensemble-score">
                  score {card.score}/100 · confidence {Math.round(card.confidence * 100)}%
                </span>
                {ctx.onOpenArtifact && (
                  <Tooltip label="Open this candidate's diff and evidence">
                    <button
                      className="btn btn-ghost ensemble-evidence-btn"
                      onClick={() => ctx.onOpenArtifact?.(card.artifactId)}
                    >
                      Evidence
                    </button>
                  </Tooltip>
                )}
              </header>
              {card.rationale && <p className="ensemble-rationale">{card.rationale}</p>}
              <div className="ensemble-scorecard-cols">
                {card.strengths.length > 0 && (
                  <div>
                    <h6>Strengths</h6>
                    <ul>
                      {card.strengths.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {card.risks.length > 0 && (
                  <div>
                    <h6>Risks</h6>
                    <ul>
                      {card.risks.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {ctx.decision && (
        <BestOfNDecisionPanel
          comparison={comparison}
          subjectLabel={ctx.subjectLabel}
          decision={ctx.decision}
        />
      )}
    </div>
  );
}

function BestOfNDecisionPanel({
  comparison,
  subjectLabel,
  decision,
}: {
  comparison: BestOfNComparison;
  subjectLabel: (artifactId: string) => string;
  decision: NonNullable<EnsembleResultContext["decision"]>;
}): React.JSX.Element {
  const [mode, setMode] = useState<"select" | "no_consensus">("select");
  const [artifactId, setArtifactId] = useState<string>(comparison.recommendedArtifactId);
  const [reason, setReason] = useState("");
  const [rationale, setRationale] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const selection: EnsembleSelectOneSelection =
    mode === "select"
      ? { kind: "selected", artifactId }
      : { kind: "no_consensus", reason: reason.trim() };
  const ready =
    confirmed &&
    !decision.busy &&
    rationale.trim().length > 0 &&
    (mode === "select" ? Boolean(artifactId) : reason.trim().length > 0);
  const nonRecommended = mode === "select" && artifactId !== comparison.recommendedArtifactId;

  return (
    <form
      className="ensemble-decision"
      aria-label="Confirm a winner"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) decision.onDecide(selection, rationale.trim());
      }}
    >
      <h4>Confirm the outcome</h4>
      <p className="ensemble-decision-intro">
        The comparison recommends, it does not promote. Confirming a winner resets that member's
        checkout to its submitted snapshot and reaps every other worktree; the losers' snapshot
        refs are kept.
      </p>
      <fieldset className="ensemble-decision-choices">
        <legend>Outcome</legend>
        {comparison.scorecards.map((card) => (
          <Tooltip key={card.artifactId} label={`Select ${subjectLabel(card.artifactId)} as the winner`}>
            <label className="ensemble-decision-choice">
              <input
                type="radio"
                name="ensemble-decision"
                checked={mode === "select" && artifactId === card.artifactId}
                onChange={() => {
                  setMode("select");
                  setArtifactId(card.artifactId);
                }}
              />
              <span>
                #{card.rank} {subjectLabel(card.artifactId)}
                {card.artifactId === comparison.recommendedArtifactId && " (recommended)"}
              </span>
            </label>
          </Tooltip>
        ))}
        <Tooltip label="Promote none; keep every candidate's snapshot">
          <label className="ensemble-decision-choice">
            <input
              type="radio"
              name="ensemble-decision"
              checked={mode === "no_consensus"}
              onChange={() => setMode("no_consensus")}
            />
            <span>No consensus - keep every snapshot, promote none</span>
          </label>
        </Tooltip>
      </fieldset>
      {mode === "no_consensus" && (
        <label className="ensemble-field">
          <span>Why there is no winner</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            rows={2}
            required
          />
        </label>
      )}
      {nonRecommended && (
        <p className="ensemble-warn" role="note">
          You are overriding the recommendation. That is allowed; the evidence is above.
        </p>
      )}
      <label className="ensemble-field">
        <span>Rationale (required, recorded with the decision)</span>
        <textarea
          value={rationale}
          onChange={(event) => setRationale(event.target.value)}
          rows={2}
          required
        />
      </label>
      <Tooltip label="Confirm you understand the destructive effect before deciding">
        <label className="ensemble-confirm-line">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            {mode === "select"
              ? "I understand the other worktrees will be reaped."
              : "I understand no member is promoted and all snapshots are retained."}
          </span>
        </label>
      </Tooltip>
      {decision.error && (
        <p className="ensemble-error" role="alert">
          {decision.error}
        </p>
      )}
      <Tooltip label="Record this decision and begin finalization">
        <button type="submit" className="btn btn-primary" disabled={!ready}>
          {decision.pending
            ? "Recording…"
            : mode === "select"
              ? "Confirm winner"
              : "Record no consensus"}
        </button>
      </Tooltip>
    </form>
  );
}
