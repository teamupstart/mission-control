import { useMemo, useState } from "react";
import type { EnsembleEvaluation, EnsembleSelectOneSelection } from "@shared/ensemble.ts";
import {
  aggregatePanelVotes,
  parsePanelVerdict,
  type PanelAggregate,
  type PanelVerdict,
} from "@shared/ensemble-strategies/panel-vote.ts";
import { Tooltip } from "../../components/Tooltip.tsx";
import type { EnsembleResultContext } from "./index.ts";

/**
 * Panel vote's result presentation: the aggregate ranking, how much the judges disagreed, each
 * judge's own ballot, and - only while the run awaits a person - the select-one decision panel.
 *
 * The disagreement is the product, so it is drawn rather than mentioned: every row carries the rank
 * each judge gave it, a contested row says so, and a panel that split on the top pick says that
 * beside the recommendation instead of presenting an average as consensus. The judges scored blind;
 * the operator view is not blind, so `subjectLabel` reveals which member produced each artifact
 * after the fact while the ballots keep the ranks the anonymous panel assigned.
 *
 * The aggregate is COMPUTED here from the evaluation rows, by the same shared function the daemon
 * used to label the stage. Nothing about the panel's conclusion is persisted separately, so this
 * view and the run's own summary cannot drift apart.
 */

/** Every readable ballot on the newest attempt, in judge order. */
function ballots(evaluations: EnsembleEvaluation[]): { verdicts: PanelVerdict[]; rows: EnsembleEvaluation[] } {
  // One stage attempt is one panel: taking the newest attempt's rows keeps a retried panel from
  // being aggregated together with the attempt it replaced, which would double-count its judges.
  const succeeded = evaluations.filter((evaluation) => evaluation.status === "succeeded" && evaluation.result);
  const newest = succeeded.reduce<EnsembleEvaluation | null>(
    (best, evaluation) => (best === null || evaluation.updatedAt > best.updatedAt ? evaluation : best),
    null,
  );
  const rows = succeeded
    .filter((evaluation) => evaluation.stageAttemptId === newest?.stageAttemptId)
    .sort((a, b) => a.attempt - b.attempt);
  const verdicts: PanelVerdict[] = [];
  const kept: EnsembleEvaluation[] = [];
  for (const row of rows) {
    const verdict = parsePanelVerdict(row.result?.body ?? null);
    if (!verdict) continue;
    verdicts.push(verdict);
    kept.push(row);
  }
  return { verdicts, rows: kept };
}

function disagreementWording(aggregate: PanelAggregate): string {
  if (aggregate.judgeCount < 2) return "a single ballot - no agreement to measure";
  if (aggregate.unanimous) return "the judges ranked every submission identically";
  const pct = Math.round(aggregate.disagreement * 100);
  if (pct === 0) return "the judges agreed on every pairwise ordering";
  return `the judges ordered ${pct}% of submission pairs differently`;
}

export function PanelVoteResult(ctx: EnsembleResultContext): React.JSX.Element | null {
  const { verdicts, rows } = useMemo(() => ballots(ctx.detail.evaluations), [ctx.detail.evaluations]);
  const aggregate = useMemo(() => aggregatePanelVotes(verdicts), [verdicts]);

  if (verdicts.length === 0) {
    return (
      <p className="ensemble-empty">
        No ballot has been recorded yet. The panel convenes once every live member has submitted or
        terminated and at least two produced a snapshot.
      </p>
    );
  }

  return (
    <div className="ensemble-result">
      <header className="ensemble-result-head">
        <h4>Panel</h4>
        <small>
          {aggregate.judgeCount} judge{aggregate.judgeCount === 1 ? "" : "s"} ·{" "}
          {verdicts.map((verdict) => verdict.judgeLabel).join(", ")}
        </small>
      </header>

      <Tooltip label="How far apart the judges' orderings were: 0% is identical rankings, 100% is exactly reversed">
        <p
          className={`ensemble-panel-disagreement${aggregate.unanimous ? " unanimous" : ""}`}
          role="note"
        >
          <span className="ensemble-panel-disagreement-figure">
            {Math.round(aggregate.disagreement * 100)}% disagreement
          </span>{" "}
          - {disagreementWording(aggregate)}.
        </p>
      </Tooltip>
      {aggregate.tied && (
        <p className="ensemble-warn" role="note">
          The top two submissions could not be separated by the panel. The order below is a
          deterministic tie-break, not a preference - this is a choice the panel could not make for
          you.
        </p>
      )}
      {aggregate.evidenceTruncated && (
        <p className="ensemble-warn" role="note">
          Some candidate diffs were truncated for the judges. Trust the ranking less.
        </p>
      )}

      <ol className="ensemble-scorecards">
        {aggregate.entries.map((entry) => {
          const recommended = !aggregate.tied && entry.artifactId === aggregate.recommendedArtifactId;
          return (
            <li
              key={entry.artifactId}
              className={`ensemble-scorecard${recommended ? " recommended" : ""}${entry.contested ? " contested" : ""}`}
            >
              <header>
                <span className="ensemble-rank" aria-label={`Rank ${entry.rank}`}>
                  #{entry.rank}
                </span>
                <span className="ensemble-subject">{ctx.subjectLabel(entry.artifactId)}</span>
                {recommended && <span className="ensemble-recommended-tag">Recommended</span>}
                {entry.contested && (
                  <Tooltip label={`The judges placed this between rank ${Math.min(...entry.ranks.map((r) => r.rank))} and rank ${Math.max(...entry.ranks.map((r) => r.rank))}`}>
                    <span className="ensemble-contested-tag">Contested</span>
                  </Tooltip>
                )}
                <span className="ensemble-score">
                  {entry.points} point{entry.points === 1 ? "" : "s"} · mean score{" "}
                  {Math.round(entry.meanScore)}/100
                </span>
                {ctx.onOpenArtifact && (
                  <Tooltip label="Open this candidate's diff and evidence">
                    <button
                      className="btn btn-ghost ensemble-evidence-btn"
                      onClick={() => ctx.onOpenArtifact?.(entry.artifactId)}
                    >
                      Evidence
                    </button>
                  </Tooltip>
                )}
              </header>
              <ul className="ensemble-judge-ranks">
                {entry.ranks.map((rank) => (
                  <li key={rank.judgeKey}>
                    <span className="ensemble-judge-name">{rank.judgeLabel}</span>
                    <span className="ensemble-judge-rank">#{rank.rank}</span>
                    <span className="ensemble-muted">{rank.score}/100</span>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>

      <div className="ensemble-ballots">
        <h5>Ballots</h5>
        {verdicts.map((verdict, index) => {
          const row = rows[index];
          return (
            <details key={verdict.judgeKey} className="ensemble-ballot">
              <Tooltip label={`Show the ${verdict.judgeLabel} judge's full ballot and its rationale for each submission`}>
                <summary>
                  {verdict.judgeLabel}
                  <span className="ensemble-muted">
                    {" "}
                    ranked {ctx.subjectLabel(verdict.scorecards[0]?.artifactId ?? "")} first
                    {row ? ` · ${row.runnerId ?? "runner"} · ${row.modelId ?? "model"}` : ""}
                  </span>
                </summary>
              </Tooltip>
              {verdict.summary && <p className="ensemble-result-summary">{verdict.summary}</p>}
              {verdict.caveats.length > 0 && (
                <div className="ensemble-caveats">
                  <h6>Caveats</h6>
                  <ul>
                    {verdict.caveats.map((caveat, i) => (
                      <li key={i}>{caveat}</li>
                    ))}
                  </ul>
                </div>
              )}
              <ol className="ensemble-ballot-cards">
                {verdict.scorecards.map((card) => (
                  <li key={card.artifactId}>
                    <span className="ensemble-rank">#{card.rank}</span>{" "}
                    <span className="ensemble-subject">{ctx.subjectLabel(card.artifactId)}</span>{" "}
                    <span className="ensemble-muted">
                      score {card.score}/100 · confidence {Math.round(card.confidence * 100)}%
                    </span>
                    {card.rationale && <p className="ensemble-rationale">{card.rationale}</p>}
                  </li>
                ))}
              </ol>
            </details>
          );
        })}
      </div>

      {ctx.decision && (
        <PanelDecisionPanel aggregate={aggregate} subjectLabel={ctx.subjectLabel} decision={ctx.decision} />
      )}
    </div>
  );
}

function PanelDecisionPanel({
  aggregate,
  subjectLabel,
  decision,
}: {
  aggregate: PanelAggregate;
  subjectLabel: (artifactId: string) => string;
  decision: NonNullable<EnsembleResultContext["decision"]>;
}): React.JSX.Element {
  const [mode, setMode] = useState<"select" | "no_consensus">("select");
  const [artifactId, setArtifactId] = useState<string>(
    aggregate.tied ? "" : (aggregate.recommendedArtifactId ?? ""),
  );
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
  const nonRecommended =
    !aggregate.tied &&
    mode === "select" &&
    Boolean(artifactId) &&
    artifactId !== aggregate.recommendedArtifactId;

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
        The panel recommends, it does not promote - and where the judges disagreed is above,
        deliberately, because that is the part only you can settle. Confirming a winner resets that
        member's checkout to its submitted snapshot and reaps every other worktree; the losers'
        snapshot refs are kept.
      </p>
      <fieldset className="ensemble-decision-choices">
        <legend>Outcome</legend>
        {aggregate.entries.map((entry) => (
          <Tooltip key={entry.artifactId} label={`Select ${subjectLabel(entry.artifactId)} as the winner`}>
            <label className="ensemble-decision-choice">
              <input
                type="radio"
                name="ensemble-decision"
                checked={mode === "select" && artifactId === entry.artifactId}
                onChange={() => {
                  setMode("select");
                  setArtifactId(entry.artifactId);
                }}
              />
              <span>
                #{entry.rank} {subjectLabel(entry.artifactId)}
                {!aggregate.tied && entry.artifactId === aggregate.recommendedArtifactId && " (recommended)"}
                {entry.contested && " - contested"}
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
          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} required />
        </label>
      )}
      {nonRecommended && (
        <p className="ensemble-warn" role="note">
          You are overriding the panel's aggregate. That is allowed, and a split panel is a good
          reason to; the ballots are above.
        </p>
      )}
      <label className="ensemble-field">
        <span>Rationale (required, recorded with the decision)</span>
        <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={2} required />
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
          {decision.pending ? "Recording…" : mode === "select" ? "Confirm winner" : "Record no consensus"}
        </button>
      </Tooltip>
    </form>
  );
}
