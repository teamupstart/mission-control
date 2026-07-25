import {
  ENSEMBLE_PLAN_VERSION,
  ensembleStrategyKey,
  type CompiledEnsemblePlan,
  type EnsembleJson,
  type EnsembleRoleSpec,
  type EnsembleStageSpec,
} from "@shared/ensemble.ts";
import {
  BEST_OF_N_BUILTIN_RUBRIC,
  BEST_OF_N_CAPABILITIES,
  BEST_OF_N_FORM,
  BestOfNConfigSchema,
  bestOfNEstimate,
  type BestOfNConfig,
  type BestOfNMember,
} from "@shared/ensemble-strategies/best-of-n.ts";
import { ENSEMBLE_STRATEGY_INFO } from "@shared/ensemble-strategies.ts";
import { CompiledEnsemblePlanSchema } from "@shared/protocol.ts";
import {
  defineStrategy,
  type StrategyCompileContext,
  type StrategyCompileResult,
} from "./types.ts";

/**
 * Best-of-N version 1, compiled.
 *
 * The whole strategy is this file plus its shared schema: N isolated implementation
 * candidates from one pinned base, one all-required-members barrier, one comparative review,
 * one human decision, and a select-one finalization. Everything downstream of the returned
 * plan is generic - the engine executes stage kinds and driver keys, and nothing in it may
 * ever ask whether a run is Best-of-N.
 *
 * Compilation is pure and deterministic: the same config and context compile byte-identically
 * every time, and no runtime id appears anywhere in the output. Role and stage ids are
 * LOGICAL (`candidate-1`, `stage-2-review`) precisely so the same plan can be compiled for
 * two different runs, and so a stored plan can be read back and compared against a fresh
 * compilation in a test without a uuid making them differ.
 */

const STRATEGY_VERSION = 1;

/** Logical role key for the nth candidate. 1-based, to match what an operator counts. */
function roleKeyFor(ordinal: number): string {
  return `candidate-${ordinal}`;
}

/**
 * The declarative half of a member's prompt appendix.
 *
 * Bounded, and deliberately without evidence, fencing or sibling identities: this is what
 * the STRATEGY has to say, and the runtime phase renders the rest around it. Two of these
 * lines are product rules rather than advice - no pushing or PR before promotion, and no
 * inspecting siblings - and they are here rather than in the runtime because they are facts
 * about Best-of-N, not about how a prompt is delivered.
 *
 * Sibling isolation is BEHAVIOURAL. The worktrees share one Git repository and a local agent
 * can find them, so nothing here or in the UI may promise that members cannot see each other.
 */
function promptFor(ordinal: number, total: number, approach: string | null): string {
  const lines = [
    `You are candidate ${ordinal} of ${total} working on this task independently.`,
    "Start from the commit this checkout is already on and implement and test the complete task.",
    "Do not inspect the other candidates' checkouts, branches or refs, and do not coordinate with them.",
    "Do not push, do not open a pull request, and do not run the shipping gate: a winner is chosen first.",
    "When the work is ready to be compared, submit it and say concisely what you did and which checks you actually ran.",
    "Do not claim a check you did not run.",
  ];
  if (approach !== null && approach.trim() !== "") {
    lines.splice(1, 0, `Suggested approach for this candidate: ${approach.trim()}`);
  }
  return lines.join("\n");
}

function roleFor(member: BestOfNMember, ordinal: number, total: number): EnsembleRoleSpec {
  return {
    key: roleKeyFor(ordinal),
    label: `Candidate ${ordinal}`,
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

function compile(config: BestOfNConfig, context: StrategyCompileContext): StrategyCompileResult {
  // Guidance is resolved by the caller, never here: `compile` may not read SQLite. A config
  // that named a Persona and a context that could not resolve it is a REFUSAL - falling back
  // to the built-in rubric would run the comparison the operator did not ask for, and the
  // only sign would be a rubric id nobody reads.
  if (config.evaluator.personaId !== null && context.persona === null) {
    return {
      ok: false,
      issues: [
        {
          path: "evaluator.personaId",
          message: "the Persona chosen to judge this comparison could not be resolved",
        },
      ],
    };
  }
  if (context.persona !== null && config.evaluator.personaId === null) {
    return {
      ok: false,
      issues: [
        {
          path: "evaluator.personaId",
          message: "a Persona was resolved for a comparison that did not ask for one",
        },
      ],
    };
  }

  const total = config.members.length;
  const roles = config.members.map((member, index) => roleFor(member, index + 1, total));
  const roleKeys = roles.map((role) => role.key);

  const candidates: EnsembleStageSpec = {
    id: "stage-1-candidates",
    ordinal: 1,
    label: "Candidates",
    driverKind: "member",
    driverKey: "member_wave@1",
    dependsOn: [],
    // The fan-out itself waits for nothing: every member row is durable before the wave is
    // dispatched, which is what the barrier on the review stage below then waits for.
    barrier: { kind: "none" },
    maxAttempts: 1,
    wave: 1,
    roleKeys,
  };

  const review: EnsembleStageSpec = {
    id: "stage-2-review",
    ordinal: 2,
    label: "Comparison",
    driverKind: "review",
    driverKey: "comparative_review@1",
    dependsOn: [candidates.id],
    // Two halves, both required. "Everyone has stopped" alone would let a comparison be
    // manufactured out of one artifact when the rest failed; "two are ready" alone would
    // start judging while a third was still working.
    barrier: {
      kind: "members_settled",
      roleKeys,
      minEligible: 2,
      requiredArtifacts: ["commit"],
    },
    maxAttempts: config.evaluator.maxAttempts,
    evaluator: {
      kind: "comparative_llm",
      // The persona case carries the whole resolved snapshot - name, guidance text and
      // runner/model overrides - not just an id and a revision, because recovery executes
      // THIS plan and must never reload the live Persona. The resolver has already truncated
      // the guidance text to fit the plan's byte cap.
      guidance:
        context.persona === null
          ? { kind: "builtin", rubricId: BEST_OF_N_BUILTIN_RUBRIC }
          : {
              kind: "persona",
              personaId: context.persona.id,
              revision: context.persona.revision,
              name: context.persona.name,
              guidanceMarkdown: context.persona.guidanceMarkdown,
              runner: context.persona.runner,
              model: context.persona.model,
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
      minSubjects: 2,
      maxSubjects: total,
    },
  };

  const decision: EnsembleStageSpec = {
    id: "stage-3-decision",
    ordinal: 3,
    label: "Your decision",
    driverKind: "decision",
    driverKey: "human_decision@1",
    dependsOn: [review.id],
    barrier: { kind: "stages_succeeded", stageIds: [review.id] },
    maxAttempts: 1,
    decision: {
      kind: "select_one",
      eligibleArtifactKind: "commit",
      minEligibleSubjects: 2,
    },
  };

  const finalize: EnsembleStageSpec = {
    id: "stage-4-finalize",
    ordinal: 4,
    label: "Promotion",
    driverKind: "finalize",
    driverKey: "select_one_finalize@1",
    dependsOn: [decision.id],
    // Waits on a PERSON, not on the review: a ranking is advisory, and finalization resets a
    // branch and reaps worktrees. Nothing a model returns may satisfy this barrier.
    barrier: { kind: "human_decision" },
    maxAttempts: config.evaluator.maxAttempts,
    finalization: {
      kind: "select_one",
      requiresHumanDecision: true,
      loserPolicy: "reap_worktrees",
    },
  };

  const plan: CompiledEnsemblePlan = {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey: ensembleStrategyKey("best_of_n", STRATEGY_VERSION),
    budget: {
      maxMembers: total,
      maxConcurrentMembers: Math.min(config.maxConcurrentMembers, total),
      maxWaves: 1,
      maxStageAttempts: config.evaluator.maxAttempts,
      deadlineMs: config.deadlineMs,
    },
    information: { kind: "isolated" },
    roles,
    stages: [candidates, review, decision, finalize],
  };

  // Validated against the durable schema HERE, in the compiler, rather than only when the
  // store writes it. A plan that cannot round-trip is a bug in this file, and finding that
  // out at persistence time would name the store as the culprit and leave a half-created
  // run behind; finding it out here is a refusal with a path on it.
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

export const bestOfNStrategy = defineStrategy<BestOfNConfig>({
  ...ENSEMBLE_STRATEGY_INFO.best_of_n,
  // Re-stated from the shared half only where the type demands the narrower `C`; everything
  // an operator reads - label, blurb, explanation, form - comes from the spread above, so
  // the panel and the daemon cannot describe this strategy differently.
  configSchema: BestOfNConfigSchema,
  capabilities: BEST_OF_N_CAPABILITIES,
  form: BEST_OF_N_FORM,
  estimate: bestOfNEstimate,
  compilesVersion: STRATEGY_VERSION,
  compile,
});
