import {
  ensembleIsTerminal,
  ensembleStageDriverWord,
  readReviewAttemptReceipt,
  type CompiledEnsemblePlan,
  type EnsembleRun,
  type EnsembleStageAttempt,
  type EnsembleStageSpec,
  type EnsembleSummary,
} from "@shared/ensemble.ts";

/**
 * `blocked` is not `failed`, because the engine did not fail it.
 *
 * A review whose infrastructure budget is spent PARKS: the run stays non-terminal, every
 * candidate artifact stays ready, and one operator press starts the next attempt. Drawing that
 * in the same red as a run that is over would tell a person their work is gone at the exact
 * moment it is intact and waiting for them.
 */
export type EnsemblePipelineStepState = "upcoming" | "active" | "complete" | "blocked" | "failed";

export interface EnsemblePipelineStep {
  id: string;
  label: string;
  state: EnsemblePipelineStepState;
  /** Counts belong only to the active step; completed history stays visually quiet. */
  detail: string | null;
}

export interface EnsemblePipelineView {
  steps: EnsemblePipelineStep[];
  barrier: string | null;
}

export interface EnsemblePipelineInput {
  run: Pick<EnsembleRun, "status" | "activeStageId" | "plan">;
  summary?: Pick<
    EnsembleSummary,
    | "launchedMembers"
    | "maxMembers"
    | "readyArtifacts"
    | "membersNeedingInput"
  > | null;
  stageAttempts: readonly EnsembleStageAttempt[];
  /** Keeps direct/detail route renders valid when no live SSE summary was supplied. */
  memberCount: number;
}

const WAITING_ON_YOU = "waiting on you";

function latestAttempts(
  attempts: readonly EnsembleStageAttempt[],
): Map<string, EnsembleStageAttempt> {
  const latest = new Map<string, EnsembleStageAttempt>();
  for (const attempt of attempts) {
    const current = latest.get(attempt.stageId);
    if (
      !current ||
      attempt.attempt > current.attempt ||
      (attempt.attempt === current.attempt && attempt.updatedAt > current.updatedAt)
    ) {
      latest.set(attempt.stageId, attempt);
    }
  }
  return latest;
}

/**
 * Where a settled review attempt leaves the stage, when the engine is not done with it.
 *
 * Read from the row rather than from a clock: an `interrupted` attempt always retries, and an
 * infrastructure failure carries the wall clock it is waiting for - which the engine sets to null
 * at exactly the point it stops retrying and starts waiting for a person. So `retrying` and
 * `blocked` are both quoting the receipt, not predicting from elapsed time, and the difference
 * between them is the difference between "wait" and "you are needed".
 */
function reviewPause(
  run: EnsemblePipelineInput["run"],
  stage: EnsembleStageSpec,
  latest: EnsembleStageAttempt | undefined,
): "retrying" | "blocked" | null {
  if (!latest || stage.driverKind !== "review") return null;
  if (run.status === null || ensembleIsTerminal(run.status)) return null;
  if (run.activeStageId !== stage.id) return null;
  if (latest.status === "interrupted") return "retrying";
  if (latest.status !== "failed") return null;
  const receipt = readReviewAttemptReceipt(latest.output);
  if (receipt.charge !== "infrastructure") return null;
  return receipt.retryAt === null ? "blocked" : "retrying";
}

function stepState(
  run: EnsemblePipelineInput["run"],
  stage: EnsembleStageSpec,
  latest: EnsembleStageAttempt | undefined,
  activeOrdinal: number | null,
): EnsemblePipelineStepState {
  if (run.status === "completed") return "complete";
  if (latest?.status === "succeeded") return "complete";
  // A stage between attempts is still working, and a stage waiting for a person is stopped but
  // not over. Only an attempt nothing will follow is a failure: an interruption cost the budget
  // nothing, and an infrastructure error owed a backoff rather than a verdict, so drawing either
  // as a dead stage would report a run that is still going as one that ended.
  const pause = reviewPause(run, stage, latest);
  if (pause === "retrying") return "active";
  if (pause === "blocked") return "blocked";
  if (latest?.status === "failed" || latest?.status === "cancelled") return "failed";
  if (run.status !== null && ensembleIsTerminal(run.status)) {
    if (run.activeStageId === stage.id) return "failed";
    if (activeOrdinal !== null && stage.ordinal < activeOrdinal) return "complete";
    return "upcoming";
  }
  if (
    run.activeStageId === stage.id ||
    latest?.status === "running" ||
    latest?.status === "waiting"
  ) {
    return "active";
  }
  if (activeOrdinal !== null && stage.ordinal < activeOrdinal) return "complete";
  return "upcoming";
}

/**
 * The review counter, in the unit its denominator is written in.
 *
 * `stage.maxAttempts` is a budget over MODEL answers, so the numerator counts the attempts that
 * spent it and not the attempt NUMBER, which is a monotonic row identity that also counts
 * restarts and provider blips. Rendering the row number against this budget is how an operator
 * ends up reading "attempt 4 of 2".
 */
function reviewAttemptDetail(
  stage: EnsembleStageSpec,
  stageAttempts: readonly EnsembleStageAttempt[],
  latest: EnsembleStageAttempt,
): string {
  let consumed = 0;
  let infrastructure = 0;
  for (const attempt of stageAttempts) {
    if (attempt.stageId !== stage.id || attempt.status !== "failed") continue;
    if (readReviewAttemptReceipt(attempt.output).charge === "model") consumed += 1;
    else infrastructure += 1;
  }
  const live =
    latest.status === "running" || latest.status === "waiting" || latest.status === "queued";
  const shown = Math.min(Math.max(consumed + (live ? 1 : 0), 1), stage.maxAttempts);
  const label = `attempt ${shown} of ${stage.maxAttempts}`;
  if (live) return label;
  const receipt = readReviewAttemptReceipt(latest.output);
  if (latest.status === "failed" && receipt.charge === "infrastructure") {
    // The stage said which of the two it is; say it in the operator's words rather than leaving
    // a bare counter that reads the same whether the next attempt is seconds away or never.
    //
    // Kept to one clause because this column is a 10.5px glance surface roughly 25 characters
    // wide: an extra sentence of advice here wraps to four lines and makes one step twice the
    // height of its neighbours. The count is the part that cannot be read anywhere else at a
    // glance - it says the daemon tried and kept trying - and the next move is already on
    // screen as the Retry stage button. The provider's own error text is on the attempt row.
    return receipt.retryAt === null
      ? `${label} · paused after ${infrastructure} infrastructure errors`
      : `${label} · retrying after an infrastructure error`;
  }
  return label;
}

function activeDetail(
  stage: EnsembleStageSpec,
  latest: EnsembleStageAttempt | undefined,
  counts: {
    maxMembers: number;
    readyArtifacts: number;
    membersNeedingInput: number;
    stageAttempts: readonly EnsembleStageAttempt[];
  },
  barrier: string | null,
): string | null {
  if (stage.driverKind === "member") {
    const parts = [
      `${counts.readyArtifacts}/${counts.maxMembers} submitted`,
      counts.membersNeedingInput > 0
        ? `${counts.membersNeedingInput} blocked`
        : null,
    ].filter((part): part is string => part !== null);
    return parts.join(" · ");
  }
  if (stage.driverKind === "review" && latest) {
    return reviewAttemptDetail(stage, counts.stageAttempts, latest);
  }
  if (stage.driverKind === "decision") return barrier;
  return null;
}

function barrierSentence(
  run: EnsemblePipelineInput["run"],
  stage: EnsembleStageSpec | undefined,
  readyArtifacts: number,
  attempts: ReadonlyMap<string, EnsembleStageAttempt>,
): string | null {
  if (!stage) return null;
  if (run.status === "awaiting_decision" && stage.driverKind === "decision") {
    return WAITING_ON_YOU;
  }
  if (run.status !== "waiting") return null;

  switch (stage.barrier.kind) {
    case "members_settled": {
      const remaining = Math.max(0, stage.barrier.minEligible - readyArtifacts);
      if (remaining > 0) {
        return `waiting for ${remaining} more submission${remaining === 1 ? "" : "s"}`;
      }
      return "waiting for the remaining members to settle";
    }
    case "stages_succeeded": {
      const remaining = stage.barrier.stageIds.filter(
        (stageId) => attempts.get(stageId)?.status !== "succeeded",
      ).length;
      if (remaining === 0) return "waiting for completed stages to advance";
      return `waiting for ${remaining} prior stage${remaining === 1 ? "" : "s"}`;
    }
    case "human_decision":
      return WAITING_ON_YOU;
    case "none":
      return "waiting to continue";
  }
}

/**
 * Turn a durable compiled plan into the operator's live pipeline.
 *
 * What is at stake is the run explaining itself without leaking `stage-2-review` or driver
 * keys into the glance path. It deliberately consumes the live summary counts when present:
 * `readyArtifacts` is the barrier's truth, and `membersNeedingInput` is the daemon's joined
 * answer rather than a browser re-derivation.
 */
export function projectEnsemblePipeline(input: EnsemblePipelineInput): EnsemblePipelineView {
  // A null status is a future-build value this client cannot interpret. The detail page already
  // explains that state explicitly; projecting any live step from the remaining persisted fields
  // would turn stale evidence into a claim that work is active.
  if (input.run.status === null) return { steps: [], barrier: null };

  const plan: CompiledEnsemblePlan | null = input.run.plan;
  if (!plan) return { steps: [], barrier: null };

  const stages = [...plan.stages].sort((a, b) => a.ordinal - b.ordinal);
  const attempts = latestAttempts(input.stageAttempts);
  const activeStage = stages.find((stage) => stage.id === input.run.activeStageId);
  const activeOrdinal = activeStage?.ordinal ?? null;
  const maxMembers = input.summary?.maxMembers ?? plan.budget.maxMembers ?? input.memberCount;
  const launchedMembers = input.summary?.launchedMembers ?? 0;
  const readyArtifacts = input.summary?.readyArtifacts ?? 0;
  const membersNeedingInput = input.summary?.membersNeedingInput ?? 0;
  const barrier = barrierSentence(input.run, activeStage, readyArtifacts, attempts);

  const launchState: EnsemblePipelineStepState =
    input.run.status === "completed" ||
    launchedMembers >= maxMembers ||
    (activeOrdinal !== null && activeOrdinal > 1)
      ? "complete"
      : input.run.status === "failed" || input.run.status === "cancelled"
        ? "failed"
        : "active";
  const launch: EnsemblePipelineStep = {
    id: "launch",
    label: "Launch",
    state: launchState,
    detail:
      launchState === "active" ? `${launchedMembers}/${maxMembers} launched` : null,
  };

  const steps = stages.map((stage): EnsemblePipelineStep => {
    const latest = attempts.get(stage.id);
    const state = stepState(input.run, stage, latest, activeOrdinal);
    return {
      id: stage.id,
      label: ensembleStageDriverWord(stage.driverKind),
      state,
      detail:
        // A blocked step carries its detail for the same reason an active one does, and a
        // stronger one: it is the line that tells a person the run is waiting for them rather
        // than over. Completed history stays quiet.
        state === "active" || state === "blocked"
          ? activeDetail(
              stage,
              latest,
              {
                maxMembers,
                readyArtifacts,
                membersNeedingInput,
                stageAttempts: input.stageAttempts,
              },
              barrier,
            )
          : null,
    };
  });

  return {
    steps: [launch, ...steps],
    barrier,
  };
}
