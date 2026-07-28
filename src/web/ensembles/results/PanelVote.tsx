import { useMemo } from "react";
import {
  ensembleIsTerminal,
  type EnsembleEvaluation,
  type EnsembleStageAttempt,
} from "@shared/ensemble.ts";
import {
  aggregatePanelVotes,
  parsePanelVerdict,
  type PanelAggregate,
  type PanelVerdict,
} from "@shared/ensemble-strategies/panel-vote.ts";
import { Tooltip } from "../../components/Tooltip.tsx";
import type { EnsembleRunDetailResponse } from "../types.ts";
import type { EnsembleResultContext } from "./index.ts";
import { DecisionPanel } from "./DecisionPanel.tsx";
import {
  AtStake,
  CandidateColumn,
  DecisionRecord,
  DissentLines,
  RankMatrix,
  RationaleText,
  recordedDecision,
} from "./dossier.tsx";
import {
  chooseCompareArtifactIds,
  eligibleCompareArtifacts,
} from "../compare.ts";

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

/**
 * Every readable ballot from the LATEST panel attempt, in judge order.
 *
 * Keyed on the newest review STAGE ATTEMPT, not on the newest succeeded evaluation, and the
 * difference is a real run: an attempt that returns one ballot is below quorum and fails, and if
 * its retry returns none, the newest succeeded evaluation still belongs to the attempt that
 * failed. Reading it would render a one-ballot ranking - with a recommendation, and a vacuous 0%
 * disagreement - for a panel that in fact reached no conclusion at all. Selecting the attempt
 * first means the latest panel speaks for itself or nothing does.
 */
function ballots(detail: EnsembleRunDetailResponse): { verdicts: PanelVerdict[]; rows: EnsembleEvaluation[] } {
  const latest = detail.stageAttempts
    .filter((attempt) => attempt.driverKind === "review")
    .reduce<EnsembleStageAttempt | null>(
      (best, attempt) =>
        best === null || attempt.attempt > best.attempt || attempt.createdAt > best.createdAt ? attempt : best,
      null,
    );
  const rows = detail.evaluations
    .filter(
      (evaluation) =>
        evaluation.status === "succeeded" &&
        evaluation.result &&
        evaluation.stageAttemptId === latest?.id,
    )
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
  const { verdicts, rows } = useMemo(() => ballots(ctx.detail), [ctx.detail]);
  const aggregate = useMemo(() => aggregatePanelVotes(verdicts), [verdicts]);
  const record = useMemo(() => recordedDecision(ctx.detail.decisions), [ctx.detail.decisions]);
  const artifactById = useMemo(
    () => new Map(ctx.detail.artifacts.map((artifact) => [artifact.id, artifact])),
    [ctx.detail.artifacts],
  );
  const status = ctx.detail.run.status;
  // See the same gate in `BestOfN.tsx`: the settled record is a TERMINAL run's, so a
  // finalization in flight is never presented as the last word.
  const settled = status !== null && ensembleIsTerminal(status) && record !== null;
  const dossier = ctx.decision !== null || settled;
  const restorable = settled && record!.readable && Boolean(ctx.onRestoreArtifact);
  const eligibleIds = eligibleCompareArtifacts(ctx.detail).map((artifact) => artifact.id);
  const rankedIds = aggregate.entries.map((entry) => entry.artifactId);
  const recommendedArtifactId = aggregate.tied ? null : aggregate.recommendedArtifactId;

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
      {/* Above the Panel header, for the reason `BestOfN.tsx` gives. */}
      {dossier && <AtStake detail={ctx.detail} />}
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

      <ol className="ensemble-scorecards dossier-cols">
        {aggregate.entries.map((entry) => {
          const recommended = !aggregate.tied && entry.artifactId === aggregate.recommendedArtifactId;
          return (
            <CandidateColumn
              key={entry.artifactId}
              artifact={artifactById.get(entry.artifactId) ?? null}
              subjectLabel={ctx.subjectLabel(entry.artifactId)}
              verdict={{
                rank: entry.rank,
                scoreLine: `${entry.points} point${entry.points === 1 ? "" : "s"} · mean score ${Math.round(entry.meanScore)}/100`,
                // The panel has no single rationale - each judge wrote one, and they are the
                // ballots below. The per-judge ranks stay ON the column, which is the strip
                // this view has always carried.
                rationale: "",
                strengths: [],
                risks: [],
                recommended,
                contested: entry.contested,
                contestedTip: entry.contested
                  ? `The judges placed this between rank ${Math.min(...entry.ranks.map((r) => r.rank))} and rank ${Math.max(...entry.ranks.map((r) => r.rank))}`
                  : undefined,
              }}
              onOpenArtifact={
                ctx.onOpenArtifact ? () => ctx.onOpenArtifact?.(entry.artifactId) : undefined
              }
              onRestore={
                restorable && entry.artifactId !== record!.selectedArtifactId
                  ? () => ctx.onRestoreArtifact?.(entry.artifactId)
                  : undefined
              }
              restorePending={ctx.restorePendingArtifactId === entry.artifactId}
            >
              <ul className="ensemble-judge-ranks">
                {entry.ranks.map((rank) => (
                  <li key={rank.judgeKey}>
                    <span className="ensemble-judge-name">{rank.judgeLabel}</span>
                    <span className="ensemble-judge-rank">#{rank.rank}</span>
                    <span className="ensemble-muted">{rank.score}/100</span>
                  </li>
                ))}
              </ul>
            </CandidateColumn>
          );
        })}
      </ol>

      {/* Judges down the side, candidates across - where the panel SPLIT, which the per-column
          strips above cannot show, and the dissenting ballot in the dissenter's own words. */}
      <RankMatrix aggregate={aggregate} subjectLabel={ctx.subjectLabel} />
      <DissentLines aggregate={aggregate} verdicts={verdicts} subjectLabel={ctx.subjectLabel} />

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
                {verdict.scorecards.map((card) => {
                  const compareArtifactIds = chooseCompareArtifactIds({
                    scoredArtifactId: card.artifactId,
                    currentSelection: [],
                    recommendedArtifactId,
                    rankedArtifactIds: rankedIds,
                    eligibleArtifactIds: eligibleIds,
                  });
                  return (
                    <li key={card.artifactId}>
                      <span className="ensemble-rank">#{card.rank}</span>{" "}
                      <span className="ensemble-subject">{ctx.subjectLabel(card.artifactId)}</span>{" "}
                      <span className="ensemble-muted">
                        score {card.score}/100 · confidence {Math.round(card.confidence * 100)}%
                      </span>
                      {card.rationale && (
                        <RationaleText
                          rationale={card.rationale}
                          artifactIds={compareArtifactIds}
                          onOpenCompare={ctx.onOpenCompare}
                        />
                      )}
                    </li>
                  );
                })}
              </ol>
            </details>
          );
        })}
      </div>

      {ctx.decision ? (
        <DecisionPanel
          choices={aggregate.entries.map((entry) => ({
            artifactId: entry.artifactId,
            label: `#${entry.rank} ${ctx.subjectLabel(entry.artifactId)}${
              !aggregate.tied && entry.artifactId === aggregate.recommendedArtifactId
                ? " (recommended)"
                : ""
            }${entry.contested ? " - contested" : ""}`,
            tip: `Select ${ctx.subjectLabel(entry.artifactId)} as the winner`,
          }))}
          // A tie recommends NOTHING, and that is the whole point of the state: the panel
          // could not separate its top two, so nothing is preselected and no override warning
          // fires against a recommendation that does not exist.
          recommendedArtifactId={aggregate.tied ? null : aggregate.recommendedArtifactId}
          intro="The panel recommends, it does not promote - and where the judges disagreed is above, deliberately, because that is the part only you can settle. Confirming a winner resets that member's checkout to its submitted snapshot and reaps every other worktree; the losers' snapshot refs are kept."
          overrideWarning="You are overriding the panel's aggregate. That is allowed, and a split panel is a good reason to; the ballots are above."
          decision={ctx.decision}
        />
      ) : settled ? (
        <DecisionRecord record={record!} subjectLabel={ctx.subjectLabel} restorable={restorable} />
      ) : null}
    </div>
  );
}
