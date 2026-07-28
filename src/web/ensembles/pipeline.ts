import {
  ensembleIsTerminal,
  ensembleStageDriverWord,
  type CompiledEnsemblePlan,
  type EnsembleRun,
  type EnsembleStageAttempt,
  type EnsembleStageSpec,
  type EnsembleSummary,
} from "@shared/ensemble.ts";

export type EnsemblePipelineStepState = "upcoming" | "active" | "complete" | "failed";

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

function stepState(
  run: EnsemblePipelineInput["run"],
  stage: EnsembleStageSpec,
  latest: EnsembleStageAttempt | undefined,
  activeOrdinal: number | null,
): EnsemblePipelineStepState {
  if (run.status === "completed") return "complete";
  if (latest?.status === "succeeded") return "complete";
  if (latest?.status === "failed" || latest?.status === "cancelled") return "failed";
  if (
    run.activeStageId === stage.id ||
    latest?.status === "running" ||
    latest?.status === "waiting"
  ) {
    return "active";
  }
  if (activeOrdinal !== null && stage.ordinal < activeOrdinal) return "complete";
  if (
    run.status !== null &&
    ensembleIsTerminal(run.status) &&
    run.activeStageId === stage.id
  ) {
    return "failed";
  }
  return "upcoming";
}

function activeDetail(
  stage: EnsembleStageSpec,
  latest: EnsembleStageAttempt | undefined,
  counts: {
    maxMembers: number;
    readyArtifacts: number;
    membersNeedingInput: number;
  },
  runStatus: EnsembleRun["status"],
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
    return `attempt ${latest.attempt} of ${stage.maxAttempts}`;
  }
  if (stage.driverKind === "decision" && runStatus === "awaiting_decision") {
    return "waiting on you";
  }
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
    return "waiting on you";
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
      return "waiting on you";
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
        state === "active"
          ? activeDetail(
              stage,
              latest,
              { maxMembers, readyArtifacts, membersNeedingInput },
              input.run.status,
            )
          : null,
    };
  });

  return {
    steps: [launch, ...steps],
    barrier: barrierSentence(input.run, activeStage, readyArtifacts, attempts),
  };
}
