import {
  aggregateEnsembleAgentCost,
  readArtifactAgentCost,
  type EnsembleArtifact,
  type EnsembleDecision,
} from "@shared/ensemble.ts";
import type { PanelAggregate, PanelVerdict } from "@shared/ensemble-strategies/panel-vote.ts";
import { fmtUsd } from "../../lib/format.ts";
import { Tooltip } from "../../components/Tooltip.tsx";
import type { EnsembleRunDetailResponse } from "../types.ts";
import { detectRationalePaths } from "../compare.ts";
import { agentCostSummary, fmtElapsed, shortSha } from "../format.ts";

/**
 * The decision dossier's shared pieces: what was at stake, one column per candidate, and - where
 * several judges ranked the same work - the matrix and the dissent that say why they disagreed.
 *
 * The material to decide from was never missing; it was SCATTERED. Member claims and observed
 * diffstats lived in the Members section, scores and rationale in Result, diffs in Artifacts, so
 * comparing two candidates meant scrolling among three sections and holding the difference in
 * your head. These pieces compose one column per candidate out of exactly those facts, and they
 * live here rather than in either strategy's view because a comparison is a comparison: only the
 * SCORE line is a strategy's own vocabulary, and that is the one thing the caller passes in.
 *
 * They read the fetched detail and nothing else - no new wire, no new route. Everything a column
 * shows is already on the artifact the member submitted, which is what makes it survive that
 * member's session exiting.
 */

/** What one candidate's judgement was, in the ranking strategy's own words. */
export interface CandidateVerdict {
  rank: number;
  /** "score 90/100 · confidence 80%", or Panel vote's points and mean score. */
  scoreLine: string;
  rationale: string;
  strengths: string[];
  risks: string[];
  recommended: boolean;
  /** Panel vote only: the judges did not place this candidate identically. */
  contested?: boolean;
  /** What "contested" meant here - the span of ranks the judges gave it. */
  contestedTip?: string;
}

function section(metadata: unknown, key: string): Record<string, unknown> | null {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>)[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * What the run set out to do, what it cost, and how long it took.
 *
 * The run's INTENT leads, and it is the fact this page never showed anywhere: the operator is
 * about to pick between five answers to a question that was asked hours ago, in a tab that has
 * been open since. The three figures beside it are the ones that qualify the choice - which
 * commit every candidate started from (they are only comparable because it is one commit), how
 * long the fleet has been at it, and what it has cost so far.
 */
export function AtStake({ detail }: { detail: EnsembleRunDetailResponse }): React.JSX.Element {
  const { run } = detail;
  const cost = agentCostSummary(
    aggregateEnsembleAgentCost(detail.attempts, detail.artifacts),
    fmtUsd,
  );
  return (
    <section className="dossier-at-stake" aria-label="At stake">
      <h5>At stake</h5>
      <p className="dossier-intent">{run.intent}</p>
      <dl className="dossier-facts">
        <div>
          <dt>Every candidate started at</dt>
          <dd>
            {run.baseSha ? (
              <code>{shortSha(run.baseSha)}</code>
            ) : (
              <span className="ensemble-muted">not pinned</span>
            )}
            {run.baseBranch ? ` (${run.baseBranch})` : ""}
          </dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{fmtElapsed(run.createdAt, run.completedAt)}</dd>
        </div>
        <div>
          <dt>Candidate spend</dt>
          <dd>
            {cost.reported ? cost.label : <span className="ensemble-muted">{cost.label}</span>}
          </dd>
        </div>
      </dl>
    </section>
  );
}

/**
 * One candidate, whole: what it claims, what we measured, what it cost, and how it was ranked.
 *
 * The claims and the observation stay two columns with two headings, the same split the Members
 * section makes and for the same reason - a member's "tests pass" is a claim by the thing being
 * judged, and printing it beside a diffstat we computed ourselves, in one voice, would make the
 * reader's job harder rather than easier.
 *
 * Restore is offered on the LOSING columns of a decided run, and only there. That the losers'
 * snapshot refs survive a finalization is the single least discoverable fact in the feature -
 * it was reachable only by knowing what Reset checkout did in a different section - and beside
 * the column it belongs to it is self-explanatory.
 */
export function CandidateColumn({
  artifact,
  subjectLabel,
  verdict,
  onOpenArtifact,
  compareArtifactIds,
  onOpenCompare,
  onRestore,
  restorePending,
  children,
}: {
  artifact: EnsembleArtifact | null;
  /** The de-anonymised identity of this candidate: "Candidate 2 (claude · opus)". */
  subjectLabel: string;
  verdict: CandidateVerdict;
  onOpenArtifact?: () => void;
  /** Activation-safe target chosen by the strategy renderer for this scorecard's rationale. */
  compareArtifactIds?: string[] | null;
  onOpenCompare?: (artifactIds: string[], path: string) => void;
  /** Present only on a losing column of a decided run - see the note above. */
  onRestore?: () => void;
  restorePending?: boolean;
  /** Anything the strategy adds under the score line - Panel vote's per-judge rank strip. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const reported = section(artifact?.metadata, "reported");
  const observed = section(artifact?.metadata, "observed");
  const checks = Array.isArray(reported?.checks)
    ? (reported.checks as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  const cost = artifact ? readArtifactAgentCost(artifact.metadata) : null;

  return (
    <li
      className={`ensemble-scorecard dossier-col${verdict.recommended ? " recommended" : ""}${
        verdict.contested ? " contested" : ""
      }`}
    >
      <header>
        <span className="ensemble-rank" aria-label={`Rank ${verdict.rank}`}>
          #{verdict.rank}
        </span>
        <span className="ensemble-subject">{subjectLabel}</span>
        {verdict.recommended && <span className="ensemble-recommended-tag">Recommended</span>}
        {verdict.contested &&
          (verdict.contestedTip ? (
            <Tooltip label={verdict.contestedTip}>
              <span className="ensemble-contested-tag">Contested</span>
            </Tooltip>
          ) : (
            <span className="ensemble-contested-tag">Contested</span>
          ))}
      </header>
      <p className="ensemble-score">{verdict.scoreLine}</p>
      {children}

      <div className="dossier-claims">
        <div className="ensemble-reported">
          <h6>Reported by this candidate</h6>
          {typeof reported?.summary === "string" && reported.summary ? (
            <p>{reported.summary}</p>
          ) : (
            <p className="ensemble-muted">No summary.</p>
          )}
          {checks.length > 0 && (
            <ul className="ensemble-checks">
              {checks.map((check, i) => (
                <li key={i}>{check}</li>
              ))}
            </ul>
          )}
          <p className="ensemble-claim-note">Claims, not verified by Mission Control.</p>
        </div>
        <div className="ensemble-observed">
          <h6>Observed by Mission Control</h6>
          {observed ? (
            <p>
              {String(observed.filesChanged ?? 0)} files · +{String(observed.insertions ?? 0)} / -
              {String(observed.deletions ?? 0)}
            </p>
          ) : (
            <p className="ensemble-muted">No snapshot observed.</p>
          )}
          <p className="dossier-cost">
            {cost === null ? (
              <span className="ensemble-muted">cost not reported</span>
            ) : (
              `cost ${fmtUsd(cost)}`
            )}
          </p>
        </div>
      </div>

      {verdict.rationale && (
        <RationaleText
          rationale={verdict.rationale}
          artifactIds={compareArtifactIds}
          onOpenCompare={onOpenCompare}
        />
      )}
      {/* Both wrappers are drawn only when they have something in them: they are margined
          boxes, and an empty one is an artifact the reader has to account for. Panel vote's
          columns carry neither - a panel has no single rationale, and its judges' strengths
          are per-ballot. */}
      {(verdict.strengths.length > 0 || verdict.risks.length > 0) && (
        <div className="ensemble-scorecard-cols">
          {verdict.strengths.length > 0 && (
            <div>
              <h6>Strengths</h6>
              <ul>
                {verdict.strengths.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ul>
            </div>
          )}
          {verdict.risks.length > 0 && (
            <div>
              <h6>Risks</h6>
              <ul>
                {verdict.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {(onOpenArtifact || onRestore) && (
        <div className="dossier-col-actions">
          {onOpenArtifact && (
            <Tooltip label="Open this candidate's diff and evidence">
              <button className="btn btn-ghost ensemble-evidence-btn" onClick={onOpenArtifact}>
                Evidence
              </button>
            </Tooltip>
          )}
          {onRestore && (
            <Tooltip label="Reset a checkout to this candidate's snapshot - its work was kept, not deleted">
              <button className="btn btn-ghost" disabled={restorePending} onClick={onRestore}>
                {restorePending ? "Restoring…" : "Restore"}
              </button>
            </Tooltip>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Rationale paths are buttons only when a compare controller and a distinct pair both exist.
 * Detection never waits for the file union; Compare validates the path after activation.
 */
export function RationaleText({
  rationale,
  artifactIds,
  onOpenCompare,
}: {
  rationale: string;
  artifactIds?: string[] | null;
  onOpenCompare?: (artifactIds: string[], path: string) => void;
}): React.JSX.Element {
  const paths = detectRationalePaths(rationale);
  if (!onOpenCompare || !artifactIds || artifactIds.length < 2 || paths.length === 0) {
    return <p className="ensemble-rationale">{rationale}</p>;
  }
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const token of paths) {
    if (token.start > cursor) parts.push(rationale.slice(cursor, token.start));
    parts.push(
      <Tooltip label={`Compare ${token.path}`} key={`${token.start}:${token.path}`}>
        <button
          type="button"
          className="ensemble-rationale-path"
          onClick={() => onOpenCompare(artifactIds, token.path)}
        >
          {token.path}
        </button>
      </Tooltip>,
    );
    cursor = token.end;
  }
  if (cursor < rationale.length) parts.push(rationale.slice(cursor));
  return <p className="ensemble-rationale">{parts}</p>;
}

/**
 * Judges down the side, candidates across: the disagreement as a shape rather than a sentence.
 *
 * Panel vote already carried every judge's rank on the candidate's own row, which answers "who
 * ranked THIS one where" and not "where did the panel split". A cell that differs from the
 * panel's aggregate rank is marked, so a judge who broke with the panel on one candidate is one
 * glance rather than five expansions of five ballots.
 *
 * A re-projection of `entry.ranks`, which the aggregate already computes - no new wire, and no
 * second opinion about who won.
 */
export function RankMatrix({
  aggregate,
  subjectLabel,
}: {
  aggregate: PanelAggregate;
  subjectLabel: (artifactId: string) => string;
}): React.JSX.Element | null {
  const judges: { key: string; label: string }[] = [];
  for (const entry of aggregate.entries) {
    for (const rank of entry.ranks) {
      if (!judges.some((j) => j.key === rank.judgeKey)) {
        judges.push({ key: rank.judgeKey, label: rank.judgeLabel });
      }
    }
  }
  if (judges.length < 2) return null;

  return (
    <table className="dossier-matrix" aria-label="Judge rankings">
      <thead>
        <tr>
          <th scope="col">Judge</th>
          {aggregate.entries.map((entry) => (
            <th key={entry.artifactId} scope="col">
              {subjectLabel(entry.artifactId)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {judges.map((judge) => (
          <tr key={judge.key}>
            <th scope="row">{judge.label}</th>
            {aggregate.entries.map((entry) => {
              const cell = entry.ranks.find((rank) => rank.judgeKey === judge.key);
              if (!cell) {
                // An absence of judgement, NOT the worst rank: a judge that did not rank a
                // submission contributes nothing to it, and drawing a number here would put
                // a verdict on screen that no judge gave.
                return (
                  <td key={entry.artifactId} className="dossier-cell is-absent">
                    <Tooltip label="This judge did not rank this submission">
                      <span className="ensemble-muted">-</span>
                    </Tooltip>
                  </td>
                );
              }
              // Marked against the PANEL's own rank, not against the row beside it: the
              // question a matrix answers is where a judge broke with the conclusion.
              const broke = cell.rank !== entry.rank;
              return (
                <td key={entry.artifactId} className={`dossier-cell${broke ? " is-split" : ""}`}>
                  #{cell.rank}
                </td>
              );
            })}
          </tr>
        ))}
        <tr className="dossier-matrix-aggregate">
          <th scope="row">Panel</th>
          {aggregate.entries.map((entry) => (
            <td key={entry.artifactId} className="dossier-cell">
              #{entry.rank}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

/**
 * The judges who liked the winner LEAST, in their own words.
 *
 * A disagreement figure says how much the panel split; it cannot say what the dissenter saw. The
 * one objection worth putting in front of someone about to promote a winner is the ballot that
 * ranked that winner worst, so this quotes exactly those - the judges at the winner's worst
 * rank - and nothing when they all had it first, because then there is no dissent to surface and
 * an empty band would only imply there was.
 */
export function DissentLines({
  aggregate,
  verdicts,
  subjectLabel,
}: {
  aggregate: PanelAggregate;
  verdicts: readonly PanelVerdict[];
  subjectLabel: (artifactId: string) => string;
}): React.JSX.Element | null {
  const winnerId = aggregate.recommendedArtifactId;
  if (!winnerId || aggregate.tied) return null;
  const winner = aggregate.entries.find((entry) => entry.artifactId === winnerId);
  if (!winner || winner.ranks.length < 2) return null;
  const worst = Math.max(...winner.ranks.map((rank) => rank.rank));
  if (worst <= 1) return null;

  const dissenters = winner.ranks
    .filter((rank) => rank.rank === worst)
    .map((rank) => {
      const ballot = verdicts.find((verdict) => verdict.judgeKey === rank.judgeKey);
      const card = ballot?.scorecards.find((c) => c.artifactId === winnerId);
      return { judgeLabel: rank.judgeLabel, rank: rank.rank, rationale: card?.rationale ?? "" };
    });
  if (dissenters.length === 0) return null;

  return (
    <div className="dossier-dissent">
      <h5>Dissent on the recommendation</h5>
      {dissenters.map((dissent) => (
        <p key={dissent.judgeLabel} className="dossier-dissent-line">
          <span className="ensemble-judge-name">{dissent.judgeLabel}</span> ranked{" "}
          {subjectLabel(winnerId)} #{dissent.rank}
          {dissent.rationale ? `: "${dissent.rationale}"` : ", giving no reason."}
        </p>
      ))}
    </div>
  );
}

/** The select-one decision as it was recorded, read back defensively. */
export interface RecordedDecision {
  decision: EnsembleDecision;
  /** The promoted artifact, or null for a no-consensus (or unreadable) selection. */
  selectedArtifactId: string | null;
  noConsensusReason: string | null;
  /** False when the stored selection is not one this build can read - see the note below. */
  readable: boolean;
}

/**
 * The decision this run is living with, or null while none has been made.
 *
 * The newest non-superseded one by version: a decision SUPERSEDES rather than overwrites, so the
 * row set is a history and the last word is what the dossier records. The selection is read
 * defensively because it is stored in the finalization policy's vocabulary, which is not this
 * build's to assume - an unreadable one still says a decision was made, and simply offers no
 * Restore, rather than guessing which column lost.
 */
export function recordedDecision(decisions: readonly EnsembleDecision[]): RecordedDecision | null {
  const live = decisions
    .filter((d) => d.status !== "superseded")
    .sort((a, b) => b.version - a.version);
  const decision = live[0] ?? null;
  if (!decision) return null;
  const body = decision.selection?.body;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const kind = (body as Record<string, unknown>).kind;
    const artifactId = (body as Record<string, unknown>).artifactId;
    const reason = (body as Record<string, unknown>).reason;
    if (kind === "selected" && typeof artifactId === "string") {
      return { decision, selectedArtifactId: artifactId, noConsensusReason: null, readable: true };
    }
    if (kind === "no_consensus") {
      return {
        decision,
        selectedArtifactId: null,
        noConsensusReason: typeof reason === "string" ? reason : "",
        readable: true,
      };
    }
  }
  return { decision, selectedArtifactId: null, noConsensusReason: null, readable: false };
}

/**
 * The decision, after the fact: what was chosen, why, and that it is not revisable.
 *
 * This is the durable "why we picked B" record the feature had only implicitly - the scorecards
 * persisted, but the operator's own reasoning was reachable nowhere on the page. It restates the
 * one-shot rule where the question "can I change this?" is actually asked, and points at the
 * Restore beside each losing column as the answer that does exist.
 */
export function DecisionRecord({
  record,
  subjectLabel,
  restorable,
}: {
  record: RecordedDecision;
  subjectLabel: (artifactId: string) => string;
  /** Whether losing columns are offering Restore, so the copy does not promise a button. */
  restorable: boolean;
}): React.JSX.Element {
  return (
    <section className="dossier-record" aria-label="Recorded decision">
      <h4>The decision</h4>
      <p className="dossier-record-line">
        {record.selectedArtifactId ? (
          <>
            Promoted <strong>{subjectLabel(record.selectedArtifactId)}</strong>.
          </>
        ) : record.noConsensusReason !== null ? (
          <>
            No consensus - every snapshot was kept and none was promoted.
            {record.noConsensusReason ? ` ${record.noConsensusReason}` : ""}
          </>
        ) : (
          <>A decision was recorded in a vocabulary this build cannot read.</>
        )}
      </p>
      {record.decision.rationale && (
        <blockquote className="dossier-record-rationale">{record.decision.rationale}</blockquote>
      )}
      <p className="dossier-record-note">
        Decisions are recorded once and are not revisable - a second one is refused rather than
        applied.
        {restorable
          ? " The losing candidates' snapshots were kept: Restore beside a column resets a checkout to that candidate's work."
          : ""}
      </p>
    </section>
  );
}
