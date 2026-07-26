import {
  ENSEMBLE_PLAN_VERSION,
  ensembleStrategyKey,
  type CompiledEnsemblePlan,
  type EnsembleEvaluatorGuidance,
  type EnsembleJson,
  type EnsemblePanelJudgeSpec,
  type EnsembleRoleSpec,
  type EnsembleStageSpec,
} from "@shared/ensemble.ts";
import {
  PANEL_LENSES,
  PANEL_VOTE_CAPABILITIES,
  PANEL_VOTE_FORM,
  PANEL_VOTE_MIN_QUORUM,
  PanelVoteConfigSchema,
  panelVoteEstimate,
  type PanelVoteConfig,
  type PanelVoteJudge,
  type PanelVoteMember,
} from "@shared/ensemble-strategies/panel-vote.ts";
import { ENSEMBLE_STRATEGY_INFO } from "@shared/ensemble-strategies.ts";
import { CompiledEnsemblePlanSchema } from "@shared/protocol.ts";
import {
  defineStrategy,
  type StrategyCompileContext,
  type StrategyCompileResult,
  type StrategyPersonaRef,
} from "./types.ts";

/**
 * Panel vote version 1, compiled.
 *
 * The whole strategy is this file plus its shared schema: N isolated implementation candidates from
 * one pinned base, one all-required-members barrier, ONE review stage whose evaluator names M
 * judges, one human decision, and a select-one finalization. The only structural difference from
 * Best-of-N is that evaluator: the plan is otherwise the same four stages driven by the same
 * generic engine, which is the point - a second strategy is a composition, not a fork.
 *
 * The panel is ONE stage rather than M review stages, and that is a decision worth stating. M
 * stages would compose from primitives that already exist (the Phase 8 fixture proves it), but the
 * engine services one review at a time per run, so M stages is M SEQUENTIAL calls and a decision
 * gated on all of them - the operator waits M times as long for the same answer, and a single
 * judge's malformed reply fails a whole stage rather than one ballot. One stage with a panel driver
 * is what makes the judges parallel and a quorum expressible.
 *
 * Compilation is pure and deterministic: the same config and context compile byte-identically every
 * time, and no runtime id appears anywhere in the output.
 */

const STRATEGY_VERSION = 1;

/** Logical role key for the nth candidate. 1-based, to match what an operator counts. */
function roleKeyFor(ordinal: number): string {
  return `candidate-${ordinal}`;
}

/** Logical judge key for the nth panelist. Stable for the life of the run. */
function judgeKeyFor(ordinal: number): string {
  return `judge-${ordinal}`;
}

/**
 * The declarative half of a member's prompt appendix.
 *
 * Identical in kind to Best-of-N's - a candidate is a candidate - but it names the panel, because
 * what the agent is told about how its work will be judged is part of the task it was given, and
 * telling it "one comparison will rank you" when three lenses will is a small, avoidable lie.
 *
 * Sibling isolation is BEHAVIOURAL. The worktrees share one Git repository and a local agent can
 * find them, so nothing here or in the UI may promise that members cannot see each other.
 */
function promptFor(ordinal: number, total: number, judges: number, approach: string | null): string {
  const lines = [
    `You are candidate ${ordinal} of ${total} working on this task independently.`,
    "Start from the commit this checkout is already on and implement and test the complete task.",
    "Do not inspect the other candidates' checkouts, branches or refs, and do not coordinate with them.",
    "Do not push, do not open a pull request, and do not run the shipping gate: a winner is chosen first.",
    `When every candidate has finished, a panel of ${judges} independent judges will each score all of the submissions from one angle alone - correctness, maintainability, risk and so on - so do not optimise for a single one of them at the others' expense.`,
    "When the work is ready to be compared, submit it and say concisely what you did and which checks you actually ran.",
    "Do not claim a check you did not run.",
  ];
  if (approach !== null && approach.trim() !== "") {
    lines.splice(1, 0, `Suggested approach for this candidate: ${approach.trim()}`);
  }
  return lines.join("\n");
}

function roleFor(
  member: PanelVoteMember,
  ordinal: number,
  total: number,
  judges: number,
): EnsembleRoleSpec {
  return {
    key: roleKeyFor(ordinal),
    label: `Candidate ${ordinal}`,
    ordinal,
    wave: 1,
    agent: member.agent,
    model: member.model,
    effort: member.effort,
    approach: member.approach,
    promptTemplate: promptFor(ordinal, total, judges, member.approach),
    requiredArtifacts: ["commit"],
    input: { kind: "run_base" },
  };
}

function compile(config: PanelVoteConfig, context: StrategyCompileContext): StrategyCompileResult {
  // Guidance is resolved by the caller, never here: `compile` may not read SQLite. A judge that
  // named a Persona and a context that could not resolve it is a REFUSAL - falling back to that
  // judge's built-in lens would run a panel the operator did not configure, and the only sign
  // would be a rubric id nobody reads.
  const judges: EnsemblePanelJudgeSpec[] = [];
  const named = new Set<string>();
  for (const [index, judge] of config.judges.entries()) {
    const resolved = judgeGuidance(judge, index, context);
    if (!resolved.ok) return resolved.refusal;
    if (judge.personaId !== null) named.add(judge.personaId);
    judges.push({
      key: judgeKeyFor(index + 1),
      label: resolved.label,
      ordinal: index + 1,
      guidance: resolved.guidance,
      runner: judge.runner,
      model: judge.model,
    });
  }
  // A resolution nobody asked for means the caller and this compiler disagree about what the
  // config says, which is exactly the drift the resolve-outside-compile split exists to catch.
  for (const personaId of context.personas.keys()) {
    if (named.has(personaId)) continue;
    return {
      ok: false,
      issues: [
        { path: "judges", message: `a Persona (${personaId}) was resolved for a panel that did not ask for one` },
      ],
    };
  }

  const total = config.members.length;
  const roles = config.members.map((member, index) =>
    roleFor(member, index + 1, total, config.judges.length),
  );
  const roleKeys = roles.map((role) => role.key);

  const candidates: EnsembleStageSpec = {
    id: "stage-1-candidates",
    ordinal: 1,
    label: "Candidates",
    driverKind: "member",
    driverKey: "member_wave@1",
    dependsOn: [],
    // The fan-out itself waits for nothing: every member row is durable before the wave is
    // dispatched, which is what the barrier on the panel stage below then waits for.
    barrier: { kind: "none" },
    maxAttempts: 1,
    wave: 1,
    roleKeys,
  };

  const panel: EnsembleStageSpec = {
    id: "stage-2-panel",
    ordinal: 2,
    label: "Panel",
    driverKind: "review",
    driverKey: "panel_review@1",
    dependsOn: [candidates.id],
    // Two halves, both required. "Everyone has stopped" alone would let a panel be convened over
    // one artifact when the rest failed; "two are ready" alone would start judging while a third
    // was still working.
    barrier: {
      kind: "members_settled",
      roleKeys,
      minEligible: 2,
      requiredArtifacts: ["commit"],
    },
    maxAttempts: config.maxAttempts,
    evaluator: {
      kind: "panel_llm",
      judges,
      // The quorum is a constant TODAY, but it is compiled into the plan rather than read from
      // this module at execution time so that a later build changing its mind cannot re-aim a run
      // already in flight - the same rule the whole compiled plan obeys.
      minSuccessfulJudges: Math.min(PANEL_VOTE_MIN_QUORUM, judges.length),
      anonymizeSubjects: config.anonymizeSubjects,
      materialBudgetBytes: config.materialBudgetBytes,
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
    dependsOn: [panel.id],
    barrier: { kind: "stages_succeeded", stageIds: [panel.id] },
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
    // Waits on a PERSON, not on the panel: an aggregate is advisory, and finalization resets a
    // branch and reaps worktrees. Nothing any number of models return may satisfy this barrier.
    barrier: { kind: "human_decision" },
    maxAttempts: config.maxAttempts,
    finalization: {
      kind: "select_one",
      requiresHumanDecision: true,
      loserPolicy: "reap_worktrees",
    },
  };

  const plan: CompiledEnsemblePlan = {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey: ensembleStrategyKey("panel_vote", STRATEGY_VERSION),
    budget: {
      maxMembers: total,
      maxConcurrentMembers: Math.min(config.maxConcurrentMembers, total),
      maxWaves: 1,
      maxStageAttempts: config.maxAttempts,
      deadlineMs: config.deadlineMs,
    },
    information: { kind: "isolated" },
    roles,
    stages: [candidates, panel, decision, finalize],
  };

  // Validated against the durable schema HERE, in the compiler, rather than only when the store
  // writes it: a plan that cannot round-trip is a bug in this file, and finding that out at
  // persistence time would name the store as the culprit and leave a half-created run behind.
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

/** One judge's snapshotted guidance: its Persona if it named one, else its built-in lens. */
function judgeGuidance(
  judge: PanelVoteJudge,
  index: number,
  context: StrategyCompileContext,
):
  | { ok: true; guidance: EnsembleEvaluatorGuidance; label: string }
  | { ok: false; refusal: StrategyCompileResult } {
  if (judge.personaId === null) {
    return {
      ok: true,
      guidance: { kind: "builtin", rubricId: judge.lens },
      label: PANEL_LENSES[judge.lens].label,
    };
  }
  const persona = context.personas.get(judge.personaId) ?? null;
  if (persona === null) {
    return {
      ok: false,
      refusal: {
        ok: false,
        issues: [
          {
            path: `judges.${index}.personaId`,
            message: "the Persona chosen for this judge could not be resolved",
          },
        ],
      },
    };
  }
  return {
    ok: true,
    guidance: {
      kind: "persona",
      personaId: persona.id,
      revision: persona.revision,
      name: persona.name,
      guidanceMarkdown: persona.guidanceMarkdown,
      runner: persona.runner,
      model: persona.model,
    },
    label: persona.name,
  };
}

/**
 * Every Persona this config names, read off the RAW blob.
 *
 * Runs before validation, so anything it cannot make sense of is "no Persona named" here and the
 * schema states the real refusal with a path on it. The same id may legitimately appear on two
 * judges - one Persona sampled twice is a choice the operator is allowed to make - and the manager
 * resolves by id, so a repeat costs one lookup, not two.
 */
function personaRefs(raw: unknown): StrategyPersonaRef[] {
  const judges = readObject(raw)?.judges;
  if (!Array.isArray(judges)) return [];
  const refs: StrategyPersonaRef[] = [];
  judges.forEach((entry, index) => {
    const record = readObject(entry);
    if (!record) return;
    const personaId = typeof record.personaId === "string" && record.personaId !== "" ? record.personaId : null;
    if (personaId === null) return;
    const revision = record.personaRevision;
    refs.push({
      path: `judges.${index}.personaId`,
      personaId,
      revision:
        typeof revision === "number" && Number.isInteger(revision) && revision > 0 ? revision : null,
    });
  });
  return refs;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const panelVoteStrategy = defineStrategy<PanelVoteConfig>({
  ...ENSEMBLE_STRATEGY_INFO.panel_vote,
  // Re-stated from the shared half only where the type demands the narrower `C`; everything an
  // operator reads - label, blurb, explanation, form - comes from the spread above, so the panel
  // and the daemon cannot describe this strategy differently.
  configSchema: PanelVoteConfigSchema,
  capabilities: PANEL_VOTE_CAPABILITIES,
  form: PANEL_VOTE_FORM,
  estimate: panelVoteEstimate,
  compilesVersion: STRATEGY_VERSION,
  compile,
  personaRefs,
});
