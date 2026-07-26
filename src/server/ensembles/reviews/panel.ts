import { createHash } from "node:crypto";
import {
  ensemblePayload,
  type EnsembleEvaluatorGuidance,
  type EnsembleJson,
  type EnsemblePanelJudgeSpec,
  type EnsemblePayloadEnvelope,
} from "@shared/ensemble.ts";
import {
  aggregatePanelVotes,
  panelLensText,
  PANEL_VERDICT_VERSION,
  PanelBallotSchema,
  parsePanelVerdict,
  type PanelBallot,
  type PanelScorecard,
  type PanelVerdict,
} from "@shared/ensemble-strategies/panel-vote.ts";
import { parseModelJson, runStructured, type StructuredAttemptObserver } from "../../llm/structured.ts";
import { assembleEvidence, SUBJECT_LETTERS, validateRanking, type EvidencePacket } from "./evidence.ts";
import { buildPanelBallotPrompt, fenceGuidance } from "./prompt.ts";
import type {
  ReviewDriver,
  ReviewDriverContext,
  ReviewEvaluationRecord,
  ReviewExecution,
  ReviewOutcome,
} from "./types.ts";

/**
 * `panel_review@1`: M independent single-lens judges over ONE anonymous evidence packet, in
 * parallel, each recorded as its own evaluation row and each able to fail alone.
 *
 * Three properties are the whole driver, and every one of them is load-bearing:
 *
 *  1. **One packet, M prompts.** The evidence is assembled once and every judge's prompt is that
 *     packet plus its lens. Judges that saw different bytes would produce a disagreement measure
 *     that says nothing about the submissions, and re-materialising N diffs per judge would make a
 *     five-lens panel five times the Git work for no extra evidence.
 *  2. **A judge fails alone.** A malformed ballot or provider failure settles that judge's opened
 *     evaluation row `failed`; a lens this build no longer has is refused before a row or call is
 *     opened. The panel goes on with the rest. The stage succeeds if the compiled quorum returned
 *     a usable ballot and fails, retryably, if it did not. What must never happen is a
 *     recommendation built from one surviving judge: its disagreement measure is vacuously zero,
 *     which reads on screen as unanimity.
 *  3. **The aggregate is derived, never stored.** Scores live on evaluation rows - one per judge
 *     that produced a ballot - and the ranking is `aggregatePanelVotes` over them, called by this
 *     driver for the stage's label and by the dashboard for the result view. Persisting the
 *     aggregate as well would be a second copy of a pure function's output, free to drift from the
 *     rows it was computed from.
 *
 * Like every review driver its authority is tiny: it reads evidence and returns advice. It never
 * launches, selects, cancels, or deletes.
 */

/** The concurrency ceiling is the daemon's review scheduler, not a number invented here. */
interface JudgeRun {
  judge: EnsemblePanelJudgeSpec;
  record: ReviewEvaluationRecord;
  verdict: PanelVerdict | null;
}

function resolveGuidance(
  guidance: EnsembleEvaluatorGuidance,
): { label: string; text: string; fenced: boolean } | null {
  if (guidance.kind === "builtin") {
    // Only lenses this build actually has can judge. A plan naming an unknown rubric - a snapshot
    // from a newer build, or a lens id that was renamed rather than appended - fails THAT judge
    // rather than quietly substituting a different lens, which would put a ballot on the panel
    // that answers a question nobody asked.
    const lens = panelLensText(guidance.rubricId);
    return lens === null ? null : { label: lens.label, text: lens.text, fenced: false };
  }
  return fenceGuidance(guidance);
}

/** The panel's compact label, derived from the same aggregation the dashboard draws. */
function labelFor(verdicts: readonly PanelVerdict[], subjectArtifactIds: readonly string[]): string {
  const aggregate = aggregatePanelVotes(verdicts);
  const judges = `${aggregate.judgeCount} judge${aggregate.judgeCount === 1 ? "" : "s"}`;
  if (aggregate.tied) return `${judges} split; no clear leader`;
  if (aggregate.recommendedArtifactId === null) return "no usable ballot";
  const index = subjectArtifactIds.indexOf(aggregate.recommendedArtifactId);
  const name = `Submission ${SUBJECT_LETTERS[index] ?? String(index + 1)}`;
  if (aggregate.unanimous) return `${judges} agree on ${name}`;
  return `${judges} rank ${name} first`;
}

/**
 * A stored ballot's label, for the ONE row a generic caller happens to be holding.
 *
 * The interface asks every driver to be able to label a single evaluation's result, and for a
 * panel that is one judge's ballot rather than the panel's conclusion - so it says whose ballot it
 * is and what that judge preferred, and never speaks for the panel. The stage's own label comes
 * from `labelFor` over every ballot.
 */
function resultLabel(input: {
  result: EnsemblePayloadEnvelope;
  subjectArtifactIds: string[];
}): string | null {
  const verdict = parsePanelVerdict(input.result.body);
  if (!verdict) return null;
  const top = verdict.scorecards.find((card) => card.rank === 1) ?? verdict.scorecards[0];
  if (!top) return null;
  const index = input.subjectArtifactIds.indexOf(top.artifactId);
  return `${verdict.judgeLabel} ranks Submission ${SUBJECT_LETTERS[index] ?? String(index + 1)} first`;
}

/** Turn one judge's raw ballot into the stored, de-anonymised verdict, or say why it is refused. */
export function validateBallot(
  ballot: PanelBallot,
  judge: { key: string; label: string },
  labelToArtifact: ReadonlyMap<string, string>,
  evidenceTruncated: boolean,
): { ok: true; verdict: PanelVerdict } | { ok: false; reason: string } {
  const ranking = validateRanking(ballot.subjects, labelToArtifact);
  if (!ranking.ok) return ranking;
  const scorecards: PanelScorecard[] = [...ballot.subjects]
    .sort((a, b) => a.rank - b.rank)
    .map((subject) => ({
      artifactId: labelToArtifact.get(subject.label)!,
      score: subject.score,
      rank: subject.rank,
      strengths: subject.strengths,
      risks: subject.risks,
      rationale: subject.rationale,
      confidence: subject.confidence,
    }));
  return {
    ok: true,
    verdict: {
      version: PANEL_VERDICT_VERSION,
      judgeKey: judge.key,
      judgeLabel: judge.label,
      summary: ballot.summary,
      caveats: ballot.caveats,
      scorecards,
      evidenceTruncated,
    },
  };
}

/**
 * Ask ONE judge, opening and settling its own ledger rows.
 *
 * Every failure path here returns a record rather than throwing, because the panel's contract is
 * that one judge's bad day is one row, not the stage. The only thing it does not decide is whether
 * the panel as a whole succeeded.
 */
async function runJudge(
  context: ReviewDriverContext,
  judge: EnsemblePanelJudgeSpec,
  packet: EvidencePacket,
  judgeCount: number,
): Promise<JudgeRun> {
  const { runtime } = context;
  const failedBefore = (detail: string, execution: ReviewExecution | null): JudgeRun => ({
    judge,
    record: { evaluationId: "", execution, status: "failed", result: null, error: detail },
    verdict: null,
  });

  const guidance = resolveGuidance(judge.guidance);
  if (guidance === null) {
    return failedBefore("this build does not have the lens this judge was compiled against", null);
  }

  const execution = runtime.resolveExecution(judge.guidance, { runner: judge.runner, model: judge.model });
  const prompt = buildPanelBallotPrompt({
    guidanceLabel: guidance.label,
    guidanceText: guidance.text,
    guidanceFenced: guidance.fenced,
    judgeLabel: judge.label,
    judgeCount,
    intent: packet.intent,
    baseSha: context.baseSha,
    subjects: packet.subjects,
  });
  // Per-JUDGE fingerprint: the shared evidence plus this judge's lens, so a retry proves this judge
  // was asked the same question about the same bytes, and two judges' rows are distinguishable.
  const inputFingerprint = createHash("sha256").update(prompt).digest("hex");

  if (context.signal.aborted || !context.stillActive()) {
    return failedBefore("the panel stopped before this judge was asked", execution);
  }
  const evaluationId = context.persist.beginEvaluation({
    ordinal: judge.ordinal,
    method: "panel_llm",
    runnerId: execution.runnerId,
    modelId: execution.modelId,
    inputFingerprint,
    subjectArtifactIds: packet.subjectArtifactIds,
  });
  const settle = (
    status: ReviewEvaluationRecord["status"],
    error: string | null,
    result: EnsemblePayloadEnvelope | null,
    verdict: PanelVerdict | null,
  ): JudgeRun => ({
    judge,
    record: { evaluationId, execution, status, result, error },
    verdict,
  });

  const callIds = new Map<number, string>();
  const callStarts = new Map<number, number>();
  const callInputBytes = new Map<number, number>();
  let stopped = false;
  let sawFinish = false;
  let lastError: string | null = null;
  let lastParsed = false;
  const observer: StructuredAttemptObserver = {
    start: (attempt, request) => {
      // The abort seam: a cancel, a withdrawal, or a superseding stage attempt stops a parse retry
      // before it starts new provider work - checked per judge, so an abort mid-panel stops the
      // judges that have not begun rather than only the one that happens to be running.
      if (context.signal.aborted || !context.stillActive()) {
        stopped = true;
        return false;
      }
      const startedAt = runtime.now();
      const inputBytes = Buffer.byteLength(request, "utf8");
      const callId = context.persist.startCall({
        evaluationId,
        purpose: "panel_review",
        attempt,
        runnerId: execution.runnerId,
        modelId: execution.modelId,
        inputBytes,
        startedAt,
      });
      callIds.set(attempt, callId);
      callStarts.set(attempt, startedAt);
      callInputBytes.set(attempt, inputBytes);
    },
    finish: (attempt, callResult) => {
      sawFinish = true;
      lastError = callResult.error;
      lastParsed = callResult.parsed;
      const callId = callIds.get(attempt);
      if (!callId) return;
      const startedAt = callStarts.get(attempt) ?? runtime.now();
      const finishedAt = runtime.now();
      context.persist.finishCall(callId, {
        state: callResult.error ? "failed" : callResult.parsed ? "succeeded" : "failed",
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        inputBytes: callInputBytes.get(attempt) ?? 0,
        outputBytes: callResult.raw ? Buffer.byteLength(callResult.raw, "utf8") : 0,
        costUsd: null,
        errorCode: callResult.error ? "review_infrastructure" : callResult.parsed ? null : "review_parse",
      });
    },
  };

  // Scheduled per judge rather than per panel: the daemon's review scheduler is the one ceiling
  // shared with Workflow review and compaction, and a five-judge panel that took five slots at
  // once would spend a global budget on one stage.
  const result = await runtime.scheduler(() =>
    runStructured(
      (request) => runtime.runModel(execution.runnerId, request, { modelId: execution.modelId, timeoutMs: runtime.timeoutMs }),
      prompt,
      (raw) => parseModelJson(raw, PanelBallotSchema),
      `The ${judge.label} ballot`,
      observer,
    ),
  );

  if (result.kind === "failed") {
    const interrupted = stopped || context.signal.aborted || !context.stillActive();
    const detail = interrupted
      ? result.reason
      : lastError != null
        ? result.reason
        : sawFinish && !lastParsed
          ? `the ballot was not valid JSON of the required shape: ${result.reason}`
          : result.reason;
    return settle(interrupted ? "interrupted" : "failed", detail, null, null);
  }

  const validated = validateBallot(
    result.value,
    { key: judge.key, label: judge.label },
    packet.labelToArtifact,
    packet.evidenceTruncated,
  );
  if (!validated.ok) return settle("failed", validated.reason, null, null);
  return settle(
    "succeeded",
    null,
    ensemblePayload(validated.verdict as unknown as EnsembleJson),
    validated.verdict,
  );
}

async function run(context: ReviewDriverContext): Promise<ReviewOutcome> {
  if (context.policy.kind !== "panel_llm") {
    return {
      ok: false,
      kind: "infrastructure",
      detail: "this stage was compiled for a different kind of evaluator",
      evaluations: [],
    };
  }
  const policy = context.policy;

  // The packet is budgeted against the LARGEST judge's guidance, so no judge's prompt can overrun
  // what the budget promised - the alternative, budgeting per judge, would give the judges
  // different diffs and make their disagreement uninterpretable.
  const guidanceBytes = Math.max(
    ...policy.judges.map((judge) => {
      const resolved = resolveGuidance(judge.guidance);
      return resolved === null ? 0 : Buffer.byteLength(resolved.text, "utf8");
    }),
    0,
  );
  const assembled = await assembleEvidence(context, {
    materialBudgetBytes: policy.materialBudgetBytes,
    guidanceBytes,
  });
  if (!assembled.ok) {
    return { ok: false, kind: assembled.failure.kind, detail: assembled.failure.detail, evaluations: [] };
  }
  const packet = assembled.packet;

  if (context.signal.aborted || !context.stillActive()) {
    return {
      ok: false,
      kind: "interrupted",
      detail: "the panel stopped before any judge was asked",
      evaluations: [],
    };
  }

  // Every judge is asked at once. `allSettled` is not needed - `runJudge` returns its failures as
  // records - but a judge that throws for a reason nobody anticipated must still not take the
  // panel down, so an unexpected rejection becomes that judge's failed record too.
  const runs = await Promise.all(
    policy.judges.map((judge) =>
      runJudge(context, judge, packet, policy.judges.length).catch(
        (error: unknown): JudgeRun => ({
          judge,
          record: {
            evaluationId: "",
            execution: null,
            status: "failed",
            result: null,
            error: error instanceof Error ? error.message : String(error),
          },
          verdict: null,
        }),
      ),
    ),
  );

  // A judge that failed before its row existed has nothing durable to settle; its failure is still
  // counted against the quorum and reported in the stage error.
  const evaluations = runs.map((run) => run.record).filter((record) => record.evaluationId !== "");
  const verdicts = runs.map((run) => run.verdict).filter((verdict): verdict is PanelVerdict => verdict !== null);

  if (verdicts.length < policy.minSuccessfulJudges) {
    // Below quorum the stage FAILS - retryably, against the same immutable subjects - rather than
    // recommending from what came back. An interruption is distinguished from a bad answer so the
    // engine can tell a daemon that exited from a panel that genuinely could not judge.
    const interrupted =
      context.signal.aborted ||
      !context.stillActive() ||
      runs.every((run) => run.record.status !== "failed");
    const detail =
      `${verdicts.length} of ${policy.judges.length} judges returned a usable ballot; ` +
      `this panel needs ${policy.minSuccessfulJudges}. ` +
      runs
        .filter((run) => run.record.error !== null)
        .map((run) => `${run.judge.label}: ${run.record.error}`)
        .join("; ");
    return { ok: false, kind: interrupted ? "interrupted" : "invalid_output", detail, evaluations };
  }

  return {
    ok: true,
    evaluations,
    resultLabel: labelFor(verdicts, packet.subjectArtifactIds),
  };
}

export const panelReviewDriver: ReviewDriver = {
  driverKey: "panel_review@1",
  llmPurpose: "panel_review",
  resultLabel,
  /**
   * A panel's rows are all written in one pass under the run lock, so a crash mid-panel leaves
   * every row `running` and this returns null - the generic interrupt-and-retry path re-runs the
   * whole panel against the same immutable evidence. The one case worth keeping is a crash between
   * that pass and the stage receipt: the ballots are durable, and if the quorum is among them,
   * completing the stage from those rows beats spending M model calls again.
   *
   * A row still `running` is not a ballot and not a refusal, so a partially-settled attempt is
   * treated as unfinished - which is the fail-closed answer, since the alternative would complete a
   * panel from a subset while another judge's reply was still on its way.
   */
  recover({ policy, evaluations }) {
    if (policy.kind !== "panel_llm") return null;
    if (evaluations.some((evaluation) => evaluation.status === "running")) return null;
    const verdicts: PanelVerdict[] = [];
    const ids: string[] = [];
    for (const evaluation of evaluations) {
      if (evaluation.status !== "succeeded" || !evaluation.result) continue;
      const verdict = parsePanelVerdict(evaluation.result.body);
      if (!verdict) continue;
      verdicts.push(verdict);
      ids.push(evaluation.id);
    }
    if (verdicts.length < policy.minSuccessfulJudges) return null;
    const subjects = evaluations.find((evaluation) => ids.includes(evaluation.id))?.subjectArtifactIds ?? [];
    return { evaluationIds: ids, resultLabel: labelFor(verdicts, subjects) };
  },
  run,
};
