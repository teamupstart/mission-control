import {
  ENSEMBLE_PLAN_VERSION,
  ensembleStrategyKey,
  type CompiledEnsemblePlan,
  type EnsembleJson,
  type EnsembleRoleSpec,
  type EnsembleStageSpec,
} from "@shared/ensemble.ts";
import {
  CONSENSUS_BUILTIN_RUBRIC,
  CONSENSUS_CAPABILITIES,
  CONSENSUS_FORM,
  CONSENSUS_MIN_MEMBERS,
  ConsensusConfigSchema,
  consensusEstimate,
  type ConsensusConfig,
  type ConsensusMember,
} from "@shared/ensemble-strategies/consensus.ts";
import { ENSEMBLE_STRATEGY_INFO } from "@shared/ensemble-strategies.ts";
import { CompiledEnsemblePlanSchema } from "@shared/protocol.ts";
import {
  defineStrategy,
  type StrategyCompileContext,
  type StrategyCompileResult,
  type StrategyPersonaRef,
} from "./types.ts";

/**
 * Consensus version 1, compiled: divergence mining over N independent attempts.
 *
 * The plan is Best-of-N's shape with two stages doing a different job. Members are identical -
 * isolated, one pinned base, one all-required-members barrier - because the raw material for
 * divergence mining is exactly the raw material for a comparison. What changes is the terminal
 * half: the review stage runs `consensus_review@1` instead of a comparative ranking, the decision
 * stage's policy is `answer_divergences` (so its options are rendered from what the evaluator
 * found rather than from a static scorecard), and finalization is `retain_all` - nothing is
 * promoted, nothing is reaped, and the run's product is the operator's recorded answers.
 *
 * Compilation is pure and deterministic, and no runtime id appears in the output: the same config
 * and context compile byte-identically every time, which is what lets a test assert an exact plan
 * and lets recovery execute the snapshot it stored.
 */

const STRATEGY_VERSION = 1;

/** Logical role key for the nth attempt. 1-based, to match what an operator counts. */
function roleKeyFor(ordinal: number): string {
  return `attempt-${ordinal}`;
}

/**
 * The declarative half of a member's prompt appendix.
 *
 * Bounded, and without evidence, fencing or sibling identities: this is what the STRATEGY has to
 * say, and the runtime phase renders the rest around it. The last line is the one that differs
 * from Best-of-N and it is a product rule, not advice: a member that hedges toward what it guesses
 * the others will do destroys the only signal this strategy exists to find. It is still only a
 * nudge - sibling isolation is BEHAVIOURAL, the worktrees share one Git repository, and nothing
 * here or in the UI may promise that members cannot see each other.
 */
function promptFor(ordinal: number, total: number, approach: string | null): string {
  const lines = [
    `You are attempt ${ordinal} of ${total} working on this task independently.`,
    "Start from the commit this checkout is already on and implement and test the complete task.",
    "Do not inspect the other attempts' checkouts, branches or refs, and do not coordinate with them.",
    "Do not push, do not open a pull request, and do not run the shipping gate: this run compares decisions, it does not ship one.",
    "When the work is ready, submit it and say concisely what you did, which checks you actually ran, and - most usefully - which judgement calls you made and what you decided instead.",
    "Do not claim a check you did not run.",
    "Commit to the approach you think is right rather than to the one you expect the others to take. Where the attempts genuinely differ, a person is asked to choose, so a hedged answer removes the choice.",
  ];
  if (approach !== null && approach.trim() !== "") {
    lines.splice(1, 0, `Suggested approach for this attempt: ${approach.trim()}`);
  }
  return lines.join("\n");
}

function roleFor(member: ConsensusMember, ordinal: number, total: number): EnsembleRoleSpec {
  return {
    key: roleKeyFor(ordinal),
    label: `Attempt ${ordinal}`,
    ordinal,
    wave: 1,
    agent: member.agent,
    model: member.model,
    effort: member.effort,
    approach: member.approach,
    promptTemplate: promptFor(ordinal, total, member.approach),
    requiredArtifacts: ["commit"],
    input: { kind: "run_base" },
  };
}

function compile(config: ConsensusConfig, context: StrategyCompileContext): StrategyCompileResult {
  // Guidance is resolved by the caller, never here: `compile` may not read SQLite. A config that
  // named a Persona and a context that could not resolve it is a REFUSAL - falling back to the
  // built-in guidance would mine divergences against criteria the operator did not choose, and
  // the only sign would be a rubric id nobody reads.
  const persona =
    config.evaluator.personaId === null ? null : context.personas.get(config.evaluator.personaId) ?? null;
  if (config.evaluator.personaId !== null && persona === null) {
    return {
      ok: false,
      issues: [
        {
          path: "evaluator.personaId",
          message: "the Persona chosen to guide this consensus pass could not be resolved",
        },
      ],
    };
  }
  if (context.personas.size > 0 && config.evaluator.personaId === null) {
    return {
      ok: false,
      issues: [
        {
          path: "evaluator.personaId",
          message: "a Persona was resolved for a consensus pass that did not ask for one",
        },
      ],
    };
  }

  const total = config.members.length;
  const roles = config.members.map((member, index) => roleFor(member, index + 1, total));
  const roleKeys = roles.map((role) => role.key);

  const attempts: EnsembleStageSpec = {
    id: "stage-1-attempts",
    ordinal: 1,
    label: "Attempts",
    driverKind: "member",
    driverKey: "member_wave@1",
    dependsOn: [],
    barrier: { kind: "none" },
    maxAttempts: 1,
    wave: 1,
    roleKeys,
  };

  const mining: EnsembleStageSpec = {
    id: "stage-2-consensus",
    ordinal: 2,
    label: "Divergences",
    driverKind: "review",
    driverKey: "consensus_review@1",
    dependsOn: [attempts.id],
    // Three, not two. A two-artifact barrier would let a run whose third member failed proceed
    // into a pass that can only report "these two differ", which is the difference between a
    // divergence and a disagreement - and the operator would be answering questions the fleet
    // never actually split on.
    barrier: {
      kind: "members_settled",
      roleKeys,
      minEligible: CONSENSUS_MIN_MEMBERS,
      requiredArtifacts: ["commit"],
    },
    maxAttempts: config.evaluator.maxAttempts,
    evaluator: {
      kind: "consensus_llm",
      guidance:
        persona === null
          ? { kind: "builtin", rubricId: CONSENSUS_BUILTIN_RUBRIC }
          : {
              kind: "persona",
              personaId: persona.id,
              revision: persona.revision,
              name: persona.name,
              guidanceMarkdown: persona.guidanceMarkdown,
              runner: persona.runner,
              model: persona.model,
            },
      runner: config.evaluator.runner,
      model: config.evaluator.model,
      // Always true: the packet is unconditionally anonymous, so the plan says so rather than
      // carrying a preference nothing reads.
      anonymizeSubjects: true,
      materialBudgetBytes: config.evaluator.materialBudgetBytes,
    },
    subjects: {
      kind: "ready_artifacts",
      artifactKind: "commit",
      minSubjects: CONSENSUS_MIN_MEMBERS,
      maxSubjects: total,
    },
  };

  const decision: EnsembleStageSpec = {
    id: "stage-3-answers",
    ordinal: 3,
    label: "Your answers",
    driverKind: "decision",
    driverKey: "divergence_decision@1",
    dependsOn: [mining.id],
    barrier: { kind: "stages_succeeded", stageIds: [mining.id] },
    maxAttempts: 1,
    decision: {
      kind: "answer_divergences",
      eligibleArtifactKind: "commit",
      minEligibleSubjects: CONSENSUS_MIN_MEMBERS,
    },
  };

  const finalize: EnsembleStageSpec = {
    id: "stage-4-retain",
    ordinal: 4,
    label: "Retention",
    driverKind: "finalize",
    driverKey: "retain_all_finalize@1",
    dependsOn: [decision.id],
    // Waits on a PERSON even though nothing destructive follows. The answers ARE the outcome, so a
    // barrier a model could satisfy would let the run terminate with the questions unanswered.
    barrier: { kind: "human_decision" },
    maxAttempts: config.evaluator.maxAttempts,
    finalization: {
      kind: "retain_all",
      requiresHumanDecision: true,
      loserPolicy: "retain",
    },
  };

  const plan: CompiledEnsemblePlan = {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey: ensembleStrategyKey("consensus", STRATEGY_VERSION),
    budget: {
      maxMembers: total,
      maxConcurrentMembers: Math.min(config.maxConcurrentMembers, total),
      maxWaves: 1,
      maxStageAttempts: config.evaluator.maxAttempts,
      deadlineMs: config.deadlineMs,
    },
    information: { kind: "isolated" },
    roles,
    stages: [attempts, mining, decision, finalize],
  };

  // Validated against the durable schema HERE rather than only when the store writes it: a plan
  // that cannot round-trip is a bug in this file, and finding that out at persistence time would
  // name the store as the culprit and leave a half-created run behind.
  const checked = CompiledEnsemblePlanSchema.safeParse(plan);
  if (!checked.success) {
    return {
      ok: false,
      issues: checked.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    };
  }

  return { ok: true, plan: checked.data as CompiledEnsemblePlan, config: config as EnsembleJson };
}

/** The optional Persona this config can name, read defensively before schema validation. */
function personaRefs(raw: unknown): StrategyPersonaRef[] {
  const root = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
  const evaluator =
    root?.evaluator && typeof root.evaluator === "object" && !Array.isArray(root.evaluator)
      ? (root.evaluator as Record<string, unknown>)
      : null;
  if (!evaluator) return [];
  const personaId =
    typeof evaluator.personaId === "string" && evaluator.personaId !== ""
      ? evaluator.personaId
      : null;
  if (personaId === null) return [];
  const revision = evaluator.personaRevision;
  return [
    {
      path: "evaluator.personaId",
      personaId,
      revision:
        typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : null,
    },
  ];
}

export const consensusStrategy = defineStrategy<ConsensusConfig>({
  ...ENSEMBLE_STRATEGY_INFO.consensus,
  // Re-stated from the shared half only where the type demands the narrower `C`; everything an
  // operator reads comes from the spread above, so the panel and the daemon cannot describe this
  // strategy differently.
  configSchema: ConsensusConfigSchema,
  capabilities: CONSENSUS_CAPABILITIES,
  form: CONSENSUS_FORM,
  estimate: consensusEstimate,
  compilesVersion: STRATEGY_VERSION,
  compile,
  personaRefs,
});
