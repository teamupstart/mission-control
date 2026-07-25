import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompiledEnsemblePlan } from "../src/shared/ensemble.ts";

/**
 * What is at stake: creating an ensemble is authority to launch local agents and, eventually, to
 * reset a branch and reap worktrees. Every one of those powers must fail closed. This suite proves
 * the hard budgets cannot be exceeded by a config or a driver's output, that destructive
 * finalization is unreachable without an explicit human confirmation even when a plan would like to
 * skip it, that private refs are generated UUIDs (never caller text) reached only through argument
 * arrays, and that a decision cannot promote an ineligible or guessed artifact. Prompt-injection
 * fencing and byte caps on evidence are covered in ensemble-comparative-review.test.ts and
 * ensemble-store.test.ts; this suite is the caps-and-authority half.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-adv-"));
process.env.HARNESS_HOME = join(home, "state");

// Every server-touching module is imported AFTER HARNESS_HOME is set, because db.ts resolves the
// state dir at import time and a static import would lock in the machine's real one first.
const { ENSEMBLE_HARD_LIMITS } = await import("../src/shared/ensemble.ts");
const { CompiledEnsemblePlanSchema, EnsembleActionSchema } = await import("../src/shared/protocol.ts");
const { BestOfNComparisonResultSchema } = await import("../src/shared/ensemble-strategies/best-of-n.ts");
const { ensembleSnapshotRef } = await import("../src/server/git/ensemble-snapshot.ts");
const { selectOneDecisionDriver } = await import("../src/server/ensembles/decisions/index.ts");
const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { runInsert } = await import("./ensemble-fixture.ts");
const fx = await import("./ensemble-strategy-fixtures.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---- hard budgets cannot be exceeded ----

test("the compiled plan schema refuses any budget above the daemon's hard ceilings", () => {
  const base = fx.fixedMatrixPlan([{ agent: "claude" }, { agent: "codex" }]);
  const mutate = (fn: (p: CompiledEnsemblePlan) => void): CompiledEnsemblePlan => {
    const clone = JSON.parse(JSON.stringify(base)) as CompiledEnsemblePlan;
    fn(clone);
    return clone;
  };
  const rejected = [
    mutate((p) => { p.budget.maxMembers = ENSEMBLE_HARD_LIMITS.maxMembers + 1; }),
    mutate((p) => { p.budget.maxConcurrentMembers = ENSEMBLE_HARD_LIMITS.maxConcurrentMembers + 1; }),
    mutate((p) => { p.budget.maxWaves = ENSEMBLE_HARD_LIMITS.maxWaves + 1; }),
    mutate((p) => { p.budget.maxStageAttempts = ENSEMBLE_HARD_LIMITS.maxStageAttempts + 1; }),
  ];
  for (const plan of rejected) {
    assert.equal(CompiledEnsemblePlanSchema.safeParse(plan).success, false, `a plan over a hard ceiling must not persist`);
  }
  // A base plan within the ceilings still parses - the caps reject excess, not everything.
  assert.equal(CompiledEnsemblePlanSchema.safeParse(base).success, true);
});

test("the compiled plan schema refuses more roles than the budget, or more concurrency than members", () => {
  const tooManyRoles = fx.fixedMatrixPlan([{ agent: "claude" }, { agent: "codex" }, { agent: "claude" }]);
  tooManyRoles.budget.maxMembers = 2; // fewer than the three roles
  assert.equal(CompiledEnsemblePlanSchema.safeParse(tooManyRoles).success, false);

  const overConcurrent = fx.fixedMatrixPlan([{ agent: "claude" }, { agent: "codex" }]);
  overConcurrent.budget.maxConcurrentMembers = overConcurrent.budget.maxMembers + 1;
  assert.equal(CompiledEnsemblePlanSchema.safeParse(overConcurrent).success, false);
});

test("a driver's own output cannot exceed the member cap - a comparison of too many subjects is rejected", () => {
  const subjects = Array.from({ length: ENSEMBLE_HARD_LIMITS.maxMembers + 1 }, (_, i) => ({
    label: `S${i}`,
    score: 50,
    rank: i + 1,
    strengths: [],
    risks: [],
    rationale: "x",
    confidence: 0.5,
  }));
  const parsed = BestOfNComparisonResultSchema.safeParse({ recommendation: "S0", comparison: "c", caveats: [], subjects });
  assert.equal(parsed.success, false, "an evaluator that returns more subjects than the hard cap is refused");
});

// ---- destructive finalization requires a human ----

test("a decision that reaps worktrees cannot be posted without an explicit destructive confirmation", () => {
  const withoutConfirm = EnsembleActionSchema.safeParse({
    kind: "decide",
    requestId: "r1",
    expectedStatus: "awaiting_decision",
    selection: { kind: "selected", artifactId: "art-1" },
    rationale: "looks good",
    // confirmDestructive intentionally omitted
  });
  assert.equal(withoutConfirm.success, false, "a decide without confirmDestructive is refused by the schema");
  const confirmedFalse = EnsembleActionSchema.safeParse({
    kind: "decide",
    requestId: "r1",
    expectedStatus: "awaiting_decision",
    selection: { kind: "selected", artifactId: "art-1" },
    rationale: "looks good",
    confirmDestructive: false,
  });
  assert.equal(confirmedFalse.success, false, "confirmDestructive must be the literal true, not merely present");
});

test("finalization runs nothing destructive while a run is parked on the human decision", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway, finalize } = fx.reviewEngine(store);
  const run = store.createRun(runInsert(fx.pairwisePlan(3), { sourceKey: "adv-park" })).run;
  await fx.runAllMembers(engine, gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  // The run recommends a winner, but until a human decides, nothing is restored, materialized, or reaped.
  assert.equal(finalize.restored.length, 0, "no winner was restored before a human confirmed");
  assert.equal(finalize.materialized.length, 0, "no replacement was materialized");
  assert.equal(gateway.cancelled.length, 0, "no loser worktree was reaped");
  assert.equal(store.getRun(run.id)?.outcome, null, "no terminal outcome exists yet");
});

// ---- a decision cannot promote a stranger's or a guessed artifact ----

test("a decision naming an ineligible or unknown artifact is refused, never a nearest match", () => {
  const context = {
    policy: { kind: "select_one" as const, eligibleArtifactKind: "commit" as const, minEligibleSubjects: 2 },
    eligibleArtifactIds: ["art-a", "art-b"],
    memberForArtifact: (id: string) => (id === "art-a" ? "m-a" : id === "art-b" ? "m-b" : null),
    // What the decision stage persisted when it opened. `select_one` ignores it - its question is
    // fully described by the compiled policy - but the field is on every `DecisionContext` because
    // a driver whose options came from an evaluator validates the answer against exactly this.
    stageInput: { command: "await_human_decision" },
  };
  const guessed = selectOneDecisionDriver.validate({ kind: "selected", artifactId: "art-guessed" }, context);
  assert.equal(guessed.ok, false);
  if (!guessed.ok) assert.equal(guessed.reason, "ineligible_artifact");
  // A ref-looking id is just as ineligible - the eligible set is the only truth.
  const refLike = selectOneDecisionDriver.validate({ kind: "selected", artifactId: "refs/mission-control/ensembles/x/y" }, context);
  assert.equal(refLike.ok, false);
  // The legitimate eligible pick is accepted, so the guard rejects excess, not everything.
  const ok = selectOneDecisionDriver.validate({ kind: "selected", artifactId: "art-a" }, context);
  assert.equal(ok.ok, true);
});

// ---- private refs are generated UUIDs, reached only through argument arrays ----

test("a private ref name refuses anything but a generated UUID for each component", () => {
  const uuid = "12345678-1234-1234-1234-123456789abc";
  assert.match(ensembleSnapshotRef(uuid, uuid), /^refs\/mission-control\/ensembles\//);
  for (const bad of ["../../etc/passwd", "refs/heads/main", "a b", "--force", uuid.slice(0, 30)]) {
    assert.throws(() => ensembleSnapshotRef(uuid, bad), /must be a generated UUID/, `ref component "${bad}" must be refused`);
    assert.throws(() => ensembleSnapshotRef(bad, uuid), /must be a generated UUID/);
  }
});

test("the snapshot and diff helpers invoke git through argument arrays, never a shell string", () => {
  const source = readFileSync(new URL("../src/server/git/ensemble-snapshot.ts", import.meta.url), "utf8");
  assert.match(source, /run\(\s*["']git["']\s*,\s*\[/, "git is invoked with an argument array");
  // No shell: it never imports child_process, calls execSync, or passes shell:true. (A regexp
  // `.exec()` is not a shell call, so match those constructs specifically.)
  assert.doesNotMatch(source, /\bexecSync\b|shell:\s*true|from\s+["']node:child_process["']/, "no shell invocation of git");
});
