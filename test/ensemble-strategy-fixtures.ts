import {
  ENSEMBLE_PLAN_VERSION,
  ensembleStrategyKey,
  type CompiledEnsemblePlan,
  type EnsembleEvaluatorPolicy,
  type EnsembleLaunchEstimate,
  type EnsembleRoleSpec,
  type EnsembleStageSpec,
  type EnsembleStrategyId,
} from "../src/shared/ensemble.ts";
import type { AgentType, ThinkingLevel } from "../src/shared/types.ts";
import type { EnsembleStore } from "../src/server/ensembles/store.ts";
import { EnsembleEngine } from "../src/server/ensembles/engine.ts";
import type { StrategyDescriptor, StrategyCatalog } from "../src/server/ensembles/strategies/index.ts";
import { defineStrategy } from "../src/server/ensembles/strategies/index.ts";
import { ensembleStrategyCatalog } from "../src/server/ensembles/strategies/index.ts";
import { z } from "zod";
import { fakeSha, FakeGateway, FakeFinalize, ARTIFACT_ADAPTERS } from "./ensemble-fixture.ts";

/**
 * The Phase 8 extension-proof bench: materially different STRATEGY SHAPES, every one composed only
 * from the primitives the generic kernel already ships - member waves, artifact barriers, the two
 * review drivers, the human decision, and the select-one finalizer.
 *
 * Two facts about the kernel make this file possible, and it exists to prove both:
 *
 *  1. The ENGINE dispatches on a stage's `driverKind`/`driverKey`, never on what strategy a run is,
 *     so a plan that fans out a matrix, schedules a pairwise bracket, polls a panel, or feeds a
 *     synthesiser executes through the same engine Best-of-N does. The executable plans below carry
 *     `best_of_n@1` because that is the one strategy key the production store parser recognises as
 *     runnable - the point being proven is that the COMPOSITION varies while the engine does not.
 *
 *  2. The STORE parser fails a run closed the moment its strategy key or a driver key is one this
 *     build does not know (`readRunSnapshot` -> `unreadable`), so a genuinely new strategy id can be
 *     compiled and persisted but never silently executed as Best-of-N. The test strategy DESCRIPTORS
 *     below carry novel ids for exactly that fail-closed proof; they are never appended to
 *     `ENSEMBLE_STRATEGY_IDS`, and the production create route rejects them.
 */

// ---- primitive stage builders ----

const REVIEW_EVALUATOR: EnsembleEvaluatorPolicy = {
  kind: "comparative_llm",
  guidance: { kind: "builtin", rubricId: "best_of_n_v1" },
  runner: null,
  model: null,
  anonymizeSubjects: true,
  materialBudgetBytes: 400 * 1024,
};

interface RoleOver {
  key: string;
  ordinal: number;
  wave?: number;
  label?: string;
  agent?: AgentType | null;
  model?: string | null;
  effort?: ThinkingLevel | null;
  approach?: string | null;
  input?: EnsembleRoleSpec["input"];
}

function role(over: RoleOver): EnsembleRoleSpec {
  return {
    key: over.key,
    label: over.label ?? `Candidate ${over.ordinal}`,
    ordinal: over.ordinal,
    wave: over.wave ?? 1,
    agent: over.agent ?? null,
    model: over.model ?? null,
    effort: over.effort ?? null,
    approach: over.approach ?? null,
    promptTemplate: "Work alone from the pinned base and submit for comparison.",
    requiredArtifacts: ["commit"],
    input: over.input ?? { kind: "run_base" },
  };
}

function memberStage(over: {
  id: string;
  ordinal: number;
  roleKeys: string[];
  wave?: number;
  label?: string;
  dependsOn?: string[];
  barrier?: EnsembleStageSpec["barrier"];
}): EnsembleStageSpec {
  return {
    id: over.id,
    ordinal: over.ordinal,
    label: over.label ?? "Candidates",
    driverKind: "member",
    driverKey: "member_wave@1",
    dependsOn: over.dependsOn ?? [],
    barrier: over.barrier ?? { kind: "none" },
    maxAttempts: 1,
    wave: over.wave ?? 1,
    roleKeys: over.roleKeys,
  };
}

function reviewStage(over: {
  id: string;
  ordinal: number;
  roleKeys: string[];
  minEligible: number;
  maxSubjects: number;
  dependsOn: string[];
  label?: string;
}): EnsembleStageSpec {
  return {
    id: over.id,
    ordinal: over.ordinal,
    label: over.label ?? "Comparison",
    driverKind: "review",
    driverKey: "comparative_review@1",
    dependsOn: over.dependsOn,
    barrier: {
      kind: "members_settled",
      roleKeys: over.roleKeys,
      minEligible: over.minEligible,
      requiredArtifacts: ["commit"],
    },
    maxAttempts: 2,
    evaluator: REVIEW_EVALUATOR,
    subjects: { kind: "ready_artifacts", artifactKind: "commit", minSubjects: 2, maxSubjects: over.maxSubjects },
  };
}

function decisionStage(over: { id: string; ordinal: number; dependsOn: string[]; minEligible: number }): EnsembleStageSpec {
  return {
    id: over.id,
    ordinal: over.ordinal,
    label: "Your decision",
    driverKind: "decision",
    driverKey: "human_decision@1",
    dependsOn: over.dependsOn,
    barrier: { kind: "stages_succeeded", stageIds: over.dependsOn },
    maxAttempts: 1,
    decision: { kind: "select_one", eligibleArtifactKind: "commit", minEligibleSubjects: over.minEligible },
  };
}

function finalizeStage(over: { id: string; ordinal: number; dependsOn: string[] }): EnsembleStageSpec {
  return {
    id: over.id,
    ordinal: over.ordinal,
    label: "Promotion",
    driverKind: "finalize",
    driverKey: "select_one_finalize@1",
    dependsOn: over.dependsOn,
    barrier: { kind: "human_decision" },
    maxAttempts: 2,
    finalization: { kind: "select_one", requiresHumanDecision: true, loserPolicy: "reap_worktrees" },
  };
}

function plan(
  budget: CompiledEnsemblePlan["budget"],
  roles: EnsembleRoleSpec[],
  stages: EnsembleStageSpec[],
  strategyKey = "best_of_n@1",
): CompiledEnsemblePlan {
  return {
    planVersion: ENSEMBLE_PLAN_VERSION,
    strategyKey,
    budget,
    information: { kind: "isolated" },
    roles,
    stages,
  };
}

// ---- launch-count strategy shapes ----

export interface MatrixCell {
  agent?: AgentType | null;
  model?: string | null;
  effort?: ThinkingLevel | null;
  approach?: string | null;
}

/**
 * Fixed matrix: explicit agent/model/effort/approach cells - duplicates included - compiled into
 * ONE bounded wave. `initialMembers === maxMembers`, one wave: the whole roster launches at once.
 */
export function fixedMatrixPlan(cells: MatrixCell[], strategyKey = "best_of_n@1"): CompiledEnsemblePlan {
  const roles = cells.map((cell, i) =>
    role({ key: `cell-${i + 1}`, ordinal: i + 1, agent: cell.agent, model: cell.model, effort: cell.effort, approach: cell.approach }),
  );
  const roleKeys = roles.map((r) => r.key);
  const stages = [
    memberStage({ id: "stage-matrix", ordinal: 1, roleKeys }),
    reviewStage({ id: "stage-review", ordinal: 2, roleKeys, minEligible: 2, maxSubjects: roles.length, dependsOn: ["stage-matrix"] }),
    decisionStage({ id: "stage-decide", ordinal: 3, dependsOn: ["stage-review"], minEligible: 2 }),
    finalizeStage({ id: "stage-finalize", ordinal: 4, dependsOn: ["stage-decide"] }),
  ];
  return plan(
    { maxMembers: roles.length, maxConcurrentMembers: roles.length, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    roles,
    stages,
    strategyKey,
  );
}

/**
 * Successive halving: an initial wave, one review, then a smaller SECOND wave that starts from the
 * survivors' parent artifacts and is gated on the first wave's barrier. Distinct estimate from a
 * fixed roster: `initialMembers < maxMembers`, `maxWaves === 2`.
 */
export function successiveHalvingPlan(first = 4, advance = 2, strategyKey = "best_of_n@1"): CompiledEnsemblePlan {
  const waveA = Array.from({ length: first }, (_, i) => role({ key: `a-${i + 1}`, ordinal: i + 1, wave: 1 }));
  const waveB = Array.from({ length: advance }, (_, i) =>
    role({
      key: `b-${i + 1}`,
      ordinal: first + i + 1,
      wave: 2,
      label: `Finalist ${i + 1}`,
      input: { kind: "parent_artifacts", roleKeys: [`a-${i + 1}`] },
    }),
  );
  const waveAKeys = waveA.map((r) => r.key);
  const waveBKeys = waveB.map((r) => r.key);
  const stages = [
    memberStage({ id: "stage-wide", ordinal: 1, roleKeys: waveAKeys }),
    reviewStage({ id: "stage-cull", ordinal: 2, roleKeys: waveAKeys, minEligible: 2, maxSubjects: first, dependsOn: ["stage-wide"] }),
    memberStage({
      id: "stage-deep",
      ordinal: 3,
      wave: 2,
      label: "Finalists",
      roleKeys: waveBKeys,
      dependsOn: ["stage-cull"],
      barrier: { kind: "stages_succeeded", stageIds: ["stage-cull"] },
    }),
    reviewStage({ id: "stage-final-review", ordinal: 4, roleKeys: waveBKeys, minEligible: 2, maxSubjects: advance, dependsOn: ["stage-deep"] }),
    decisionStage({ id: "stage-decide", ordinal: 5, dependsOn: ["stage-final-review"], minEligible: 2 }),
    finalizeStage({ id: "stage-finalize", ordinal: 6, dependsOn: ["stage-decide"] }),
  ];
  return plan(
    { maxMembers: first + advance, maxConcurrentMembers: first, maxWaves: 2, maxStageAttempts: 2, deadlineMs: null },
    [...waveA, ...waveB],
    stages,
    strategyKey,
  );
}

/**
 * Adaptive-shaped: a minimum initial roster plus one optional later wave, so the estimate reports
 * `initialMembers` (the minimum) distinct from `maxMembers` (with the optional wave). The kernel
 * ships no runtime spawn-more driver, so this fixture proves the ESTIMATE distinction and the
 * multi-wave execution path, not a runtime confidence predicate.
 */
export function adaptivePlan(minimum = 2, extra = 2, strategyKey = "best_of_n@1"): CompiledEnsemblePlan {
  return successiveHalvingPlan(minimum, extra, strategyKey);
}

// ---- comparison strategy shapes ----

/**
 * Pairwise tournament: one member wave, then a bounded set of SEPARATE review stages, each judging
 * exactly one pair, each persisting its own evaluation. Standings are read off the generic
 * evaluation rows - no member score column. `pairs()` is a deterministic round-robin over the roster.
 */
export function pairwisePlan(count = 3, strategyKey = "best_of_n@1"): CompiledEnsemblePlan {
  const roles = Array.from({ length: count }, (_, i) => role({ key: `p-${i + 1}`, ordinal: i + 1 }));
  const roleKeys = roles.map((r) => r.key);
  const pairStages: EnsembleStageSpec[] = [];
  let ordinal = 2;
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      pairStages.push(
        reviewStage({
          id: `stage-pair-${i + 1}-${j + 1}`,
          ordinal: ordinal++,
          roleKeys,
          minEligible: 2,
          maxSubjects: 2,
          dependsOn: ["stage-members"],
          label: `Pair ${i + 1} vs ${j + 1}`,
        }),
      );
    }
  }
  const pairIds = pairStages.map((s) => s.id);
  const stages = [
    memberStage({ id: "stage-members", ordinal: 1, roleKeys }),
    ...pairStages,
    decisionStage({ id: "stage-decide", ordinal: ordinal++, dependsOn: pairIds, minEligible: 2 }),
    finalizeStage({ id: "stage-finalize", ordinal: ordinal++, dependsOn: ["stage-decide"] }),
  ];
  return plan(
    { maxMembers: count, maxConcurrentMembers: count, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    roles,
    stages,
    strategyKey,
  );
}

/**
 * Panel consensus: one member wave, then several INDEPENDENT review stages over the SAME immutable
 * subject set - each a ballot, each its own evaluation row - and a decision gated on all of them.
 * Agreement is aggregated from the ballots; nothing is written back onto a member.
 */
export function panelPlan(count = 3, panelists = 3, strategyKey = "best_of_n@1"): CompiledEnsemblePlan {
  const roles = Array.from({ length: count }, (_, i) => role({ key: `c-${i + 1}`, ordinal: i + 1 }));
  const roleKeys = roles.map((r) => r.key);
  const ballotStages = Array.from({ length: panelists }, (_, i) =>
    reviewStage({
      id: `stage-ballot-${i + 1}`,
      ordinal: i + 2,
      roleKeys,
      minEligible: 2,
      maxSubjects: count,
      dependsOn: ["stage-members"],
      label: `Panelist ${i + 1}`,
    }),
  );
  const ballotIds = ballotStages.map((s) => s.id);
  const stages = [
    memberStage({ id: "stage-members", ordinal: 1, roleKeys }),
    ...ballotStages,
    decisionStage({ id: "stage-decide", ordinal: panelists + 2, dependsOn: ballotIds, minEligible: 2 }),
    finalizeStage({ id: "stage-finalize", ordinal: panelists + 3, dependsOn: ["stage-decide"] }),
  ];
  return plan(
    { maxMembers: count, maxConcurrentMembers: count, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    roles,
    stages,
    strategyKey,
  );
}

/**
 * Critique/synthesis: an initial wave of proposals, then a SECOND-wave synthesiser whose input is
 * the proposals' immutable parent artifacts, launched at a verified artifact commit. Selecting the
 * synthesiser's output is the terminal outcome, and its `parent_artifacts` input is the lineage.
 */
export function synthesisPlan(proposals = 3, strategyKey = "best_of_n@1"): CompiledEnsemblePlan {
  const props = Array.from({ length: proposals }, (_, i) => role({ key: `prop-${i + 1}`, ordinal: i + 1, wave: 1 }));
  const propKeys = props.map((r) => r.key);
  const synth = role({
    key: "synth",
    ordinal: proposals + 1,
    wave: 2,
    label: "Synthesiser",
    input: { kind: "parent_artifacts", roleKeys: propKeys },
  });
  const stages = [
    memberStage({ id: "stage-proposals", ordinal: 1, roleKeys: propKeys }),
    memberStage({
      id: "stage-synthesis",
      ordinal: 2,
      wave: 2,
      label: "Synthesis",
      roleKeys: ["synth"],
      dependsOn: ["stage-proposals"],
      barrier: { kind: "members_settled", roleKeys: propKeys, minEligible: 2, requiredArtifacts: ["commit"] },
    }),
    // A comparison of the surviving proposals plus the synthesis output, so the operator selects one.
    reviewStage({ id: "stage-review", ordinal: 3, roleKeys: [...propKeys, "synth"], minEligible: 2, maxSubjects: proposals + 1, dependsOn: ["stage-synthesis"] }),
    decisionStage({ id: "stage-decide", ordinal: 4, dependsOn: ["stage-review"], minEligible: 2 }),
    finalizeStage({ id: "stage-finalize", ordinal: 5, dependsOn: ["stage-decide"] }),
  ];
  return plan(
    { maxMembers: proposals + 1, maxConcurrentMembers: proposals, maxWaves: 2, maxStageAttempts: 2, deadlineMs: null },
    [...props, synth],
    stages,
    strategyKey,
  );
}

/**
 * Retain / no-consensus: one member wave then a decision, whose `no_consensus` branch retains every
 * artifact and finalises non-destructively - no single winner, no Workflow handoff. Proves the
 * kernel's terminal outcome need not be a winner.
 */
export function retainPlan(count = 2, strategyKey = "best_of_n@1"): CompiledEnsemblePlan {
  const roles = Array.from({ length: count }, (_, i) => role({ key: `r-${i + 1}`, ordinal: i + 1 }));
  const roleKeys = roles.map((r) => r.key);
  const stages = [
    memberStage({ id: "stage-members", ordinal: 1, roleKeys }),
    {
      id: "stage-decide",
      ordinal: 2,
      label: "Your decision",
      driverKind: "decision" as const,
      driverKey: "human_decision@1" as const,
      dependsOn: ["stage-members"],
      barrier: { kind: "members_settled" as const, roleKeys, minEligible: 2, requiredArtifacts: ["commit" as const] },
      maxAttempts: 1,
      decision: { kind: "select_one" as const, eligibleArtifactKind: "commit" as const, minEligibleSubjects: 2 },
    },
    finalizeStage({ id: "stage-finalize", ordinal: 3, dependsOn: ["stage-decide"] }),
  ];
  return plan(
    { maxMembers: count, maxConcurrentMembers: count, maxWaves: 1, maxStageAttempts: 2, deadlineMs: null },
    roles,
    stages,
    strategyKey,
  );
}

// ---- test strategy descriptors (novel ids, never in ENSEMBLE_STRATEGY_IDS) ----

/**
 * The bounded set of test-only strategy KEYS. They are deliberately NOT in `ENSEMBLE_STRATEGY_IDS`:
 * a run compiled under one persists and loads, but the production store parser marks it unreadable
 * and refuses to execute it, which is the fail-closed proof. The `as EnsembleStrategyId` casts are
 * the whole point - the type system reserves that union for production ids, and these are not one.
 */
export const TEST_STRATEGY_IDS = ["fixed_matrix", "successive_halving", "pairwise", "panel", "synthesis"] as const;
export type TestStrategyId = (typeof TEST_STRATEGY_IDS)[number];

function defineTestStrategy(
  id: TestStrategyId,
  build: (config: unknown) => CompiledEnsemblePlan,
  estimate: EnsembleLaunchEstimate,
): StrategyDescriptor {
  return defineStrategy<unknown>({
    id: id as unknown as EnsembleStrategyId,
    currentVersion: 1,
    compilesVersion: 1,
    label: id,
    blurb: `test-only ${id} strategy`,
    explanation: `A Phase 8 extension-proof fixture for ${id}; never enabled for production creation.`,
    capabilities: {
      singleSessionFinalization: true,
      sharesArtifacts: id === "synthesis" || id === "successive_halving",
      requiresHumanDecision: true,
      artifactKinds: ["commit"],
      launchShape: id === "successive_halving" ? "adaptive" : "fixed",
    },
    configSchema: z.unknown(),
    form: { fields: [] },
    estimate: () => estimate,
    // Enabled WITHIN the injected test catalog so the manager's create path will compile it - the
    // point of the fail-closed proof is that compilation succeeds yet the persisted run is refused.
    // These ids are never in `ENSEMBLE_STRATEGY_IDS`, so `creatableStrategyDescriptors()` (which
    // folds over that tuple) never sees them and the production route rejects them by schema.
    enabled: true,
    compile: (config) => ({ ok: true, plan: build(config), config: {} }),
  });
}

/**
 * A catalog whose `best_of_n` descriptor is REPLACED by one that compiles whatever plan the test
 * gives it, keyed `best_of_n@1` so the store still reads it back runnable.
 *
 * This is the manager-level extension proof: `manager.create({ strategyId: "best_of_n" })` validates
 * the id against the production enum (which is why a novel id cannot reach the manager at all) and
 * then resolves the DESCRIPTOR through the injected catalog - so a test drives the whole
 * compile-and-persist path against a materially different composition without touching production.
 */
export function catalogWithBestOfN(build: () => CompiledEnsemblePlan): StrategyCatalog {
  return {
    ...ensembleStrategyCatalog,
    best_of_n: defineStrategy<unknown>({
      id: "best_of_n",
      currentVersion: 1,
      compilesVersion: 1,
      label: "Best of N (test override)",
      blurb: "test override",
      explanation: "A test descriptor that compiles a different composition under the runnable key.",
      capabilities: {
        singleSessionFinalization: true,
        sharesArtifacts: false,
        requiresHumanDecision: true,
        artifactKinds: ["commit"],
        launchShape: "fixed",
      },
      configSchema: z.unknown(),
      form: { fields: [] },
      estimate: () => ({ initialMembers: 3, maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, evaluationCalls: 3 }),
      enabled: true,
      compile: () => ({ ok: true, plan: build(), config: {} }),
    }),
  };
}

/** A catalog that adds the test strategies BESIDE the production ones, for manager injection. */
export function testStrategyCatalog(): StrategyCatalog {
  return {
    ...ensembleStrategyCatalog,
    fixed_matrix: defineTestStrategy(
      "fixed_matrix",
      () => fixedMatrixPlan([{ agent: "claude" }, { agent: "codex" }, { agent: "claude" }], "fixed_matrix@1"),
      { initialMembers: 3, maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, evaluationCalls: 1 },
    ),
    successive_halving: defineTestStrategy(
      "successive_halving",
      () => successiveHalvingPlan(4, 2, "successive_halving@1"),
      { initialMembers: 4, maxMembers: 6, maxConcurrentMembers: 4, maxWaves: 2, evaluationCalls: 2 },
    ),
    pairwise: defineTestStrategy(
      "pairwise",
      () => pairwisePlan(3, "pairwise@1"),
      { initialMembers: 3, maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, evaluationCalls: 3 },
    ),
    panel: defineTestStrategy(
      "panel",
      () => panelPlan(3, 3, "panel@1"),
      { initialMembers: 3, maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, evaluationCalls: 3 },
    ),
    synthesis: defineTestStrategy(
      "synthesis",
      () => synthesisPlan(3, "synthesis@1"),
      { initialMembers: 3, maxMembers: 4, maxConcurrentMembers: 3, maxWaves: 2, evaluationCalls: 1 },
    ),
  };
}

// ---- review-capable engine harness ----

interface Material {
  files: Array<{ path: string; oldPath: string | null; insertions: number; deletions: number; binary: boolean }>;
  filesChanged: number;
  insertions: number;
  deletions: number;
  patch: string;
  truncated: boolean;
  omittedBytes: number;
}

function defaultMaterial(): Material {
  return {
    files: [{ path: "src/app.ts", oldPath: null, insertions: 3, deletions: 1, binary: false }],
    filesChanged: 1,
    insertions: 3,
    deletions: 1,
    patch: "diff --git a/src/app.ts b/src/app.ts\n@@\n+added a line\n-removed a line\n",
    truncated: false,
    omittedBytes: 0,
  };
}

/** A commit adapter that captures a deterministic fake snapshot and materialises a non-empty diff. */
export function reviewAdapters() {
  const commit = {
    kind: "commit" as const,
    formatVersion: 1,
    async capture(input: { runId: string; artifactId: string; baseSha: string }) {
      const ref = `refs/mission-control/ensembles/${input.runId}/${input.artifactId}`;
      const snapshotSha = fakeSha(`snap:${input.artifactId}`);
      const treeSha = fakeSha(`tree:${input.artifactId}`);
      return {
        locator: { kind: "git_snapshot", formatVersion: 1, ref, snapshotSha, baseSha: input.baseSha, parentSha: input.baseSha, treeSha },
        fingerprint: treeSha,
        observed: { filesChanged: 1, insertions: 3, deletions: 1, binaryFiles: 0, dirty: false, patchTruncated: false, patchOmittedBytes: 0 },
      };
    },
    async recover() {
      return null;
    },
    async materialize() {
      return defaultMaterial();
    },
    async verify() {
      return true;
    },
    async restore() {},
  };
  return { ...ARTIFACT_ADAPTERS, commit } as never;
}

/** The labels the comparative prompt asked the model to rank, parsed back out. */
export function labelsFromPrompt(prompt: string): string[] {
  const line = prompt.match(/Rank exactly these submissions, each once: (.+)\./);
  return line ? line[1]!.split(", ").map((s) => s.trim()) : [];
}

/** A schema-valid, semantically-complete comparative reply for however many subjects a stage used. */
export function validComparison(prompt: string): string {
  const labels = labelsFromPrompt(prompt);
  return JSON.stringify({
    recommendation: labels[0],
    comparison: "The submissions differ in scope and clarity.",
    caveats: [],
    subjects: labels.map((label, index) => ({
      label,
      score: 90 - index * 10,
      rank: index + 1,
      strengths: ["clear"],
      risks: ["thin tests"],
      rationale: "solid overall",
      confidence: 0.8,
    })),
  });
}

/**
 * A review- AND finalize-capable engine over a shared store, with the model call stubbed to a valid
 * comparison and finalization driven by a `FakeFinalize` so a plan can run past the human decision to
 * a terminal outcome. The `finalize` and `gateway` are returned so a test can inspect what was reaped.
 */
export function reviewEngine(
  store: EnsembleStore,
  opts: { runModel?: (prompt: string) => Promise<string> | string; publish?: (id: string) => void } = {},
): {
  engine: EnsembleEngine;
  gateway: FakeGateway;
  finalize: FakeFinalize;
  prompts: string[];
  modelCalls: () => number;
} {
  const gateway = new FakeGateway();
  const finalize = new FakeFinalize();
  const prompts: string[] = [];
  let modelCalls = 0;
  const engine = new EnsembleEngine({
    store,
    tasks: gateway,
    publish: opts.publish ?? (() => {}),
    adapters: reviewAdapters(),
    armTimer: () => () => {},
    finalize,
    review: {
      scheduler: <T>(fn: () => Promise<T>) => fn(),
      resolveExecution: () => ({ runnerId: "claude" as const, modelId: "test-judge", unknownRunner: null }),
      runModel: async (_runnerId: string, prompt: string) => {
        modelCalls += 1;
        prompts.push(prompt);
        return opts.runModel ? await opts.runModel(prompt) : validComparison(prompt);
      },
      timeoutMs: 1000,
    },
  });
  return { engine, gateway, finalize, prompts, modelCalls: () => modelCalls };
}

/**
 * Launch a run, bring every INITIAL-wave member up, and submit it. Later waves are brought up as the
 * engine dispatches them, so a two-wave plan runs to its barrier without the caller tracking waves.
 */
export async function runAllMembers(
  engine: EnsembleEngine,
  gateway: FakeGateway,
  store: EnsembleStore,
  runId: string,
  costs: Record<string, number | null> = {},
): Promise<void> {
  await engine.launch(runId);
  const handled = new Set<string>();
  const atBoundary = (): boolean => {
    const s = store.getRun(runId)?.status;
    return s === "awaiting_decision" || s === "failed" || s === "completed" || s === "cancelled";
  };
  // A review runs OUTSIDE the run lock and only then dispatches the next wave, so "no pending
  // dispatches right now" is not "done" - it may just mean an async review has not landed yet. Loop
  // until the run parks at a boundary, bringing up whatever the engine has dispatched each pass and
  // yielding for the async work in between. The guard bounds a genuinely stuck plan.
  for (let guard = 0; guard < 200 && !atBoundary(); guard++) {
    const pending = gateway.dispatched.filter((d) => !handled.has(d.taskId));
    for (const dispatch of pending) {
      handled.add(dispatch.taskId);
      const attempt = store.listAttempts(runId).find((a) => a.taskId === dispatch.taskId);
      if (!attempt) continue;
      gateway.running(dispatch.taskId, `/wt/${dispatch.taskId}`);
      if (dispatch.taskId in costs) gateway.setCost(dispatch.taskId, costs[dispatch.taskId]!);
      await engine.wake(runId);
      await engine.submit({
        runId,
        memberId: attempt.memberId,
        claims: { summary: `work ${attempt.memberId}`, checks: ["typecheck"], testEvidence: null },
        source: "mcp",
        requireWorktree: `/wt/${dispatch.taskId}`,
      });
    }
    await engine.wake(runId);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
