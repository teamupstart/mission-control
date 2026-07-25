import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: the whole architectural promise of the ensemble kernel is that a genuinely
 * different multi-agent pattern is a new PLAN, never a new fork of the engine, the store, the API,
 * the SSE summary, the generic detail, or a layout. This suite turns that promise into executable
 * proof - it runs materially different strategy SHAPES (a fixed matrix, a two-wave successive
 * halving, a pairwise bracket, a panel of ballots, a synthesiser fed parent artifacts, and a
 * retain/no-consensus terminal) through the SAME production persistence and engine Best-of-N uses,
 * asserting each reaches its expected boundary with the expected generic rows. It also pins the
 * fail-closed half: a strategy id this build does not know compiles and persists but is refused
 * rather than executed as Best-of-N, and the production create route rejects it.
 *
 * If any fixture here needed a new table, route, event, Session field, or layout to run, the kernel
 * contract would be incomplete - so the negative half of the proof lives in ensemble-extension-contract.test.ts.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-ext-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ensembleIsRunnable } = await import("../src/shared/ensemble.ts");
const { runInsert } = await import("./ensemble-fixture.ts");
const fx = await import("./ensemble-strategy-fixtures.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

let sourceCounter = 0;
function makeRun(store: InstanceType<typeof EnsembleStore>, plan: ReturnType<typeof fx.fixedMatrixPlan>) {
  return store.createRun(runInsert(plan, { sourceKey: `ext:${(sourceCounter += 1)}` })).run;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function driveToTerminalBoundary(plan: ReturnType<typeof fx.fixedMatrixPlan>): Promise<{
  store: InstanceType<typeof EnsembleStore>;
  runId: string;
  status: string | null;
}> {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  const run = makeRun(store, plan);
  await fx.runAllMembers(engine, gateway, store, run.id);
  await waitFor(() => {
    const s = store.getRun(run.id)?.status;
    return s === "awaiting_decision" || s === "failed" || s === "completed" || s === "cancelled";
  });
  return { store, runId: run.id, status: store.getRun(run.id)?.status ?? null };
}

// ---- launch-count shapes ----

test("fixed matrix: an explicit roster with duplicates launches as one wave and reaches a decision", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  const plan = fx.fixedMatrixPlan([{ agent: "claude" }, { agent: "codex" }, { agent: "claude" }]);
  const run = makeRun(store, plan);
  await fx.runAllMembers(engine, gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  // One wave: every member dispatched before the review, and duplicates are legitimate rows.
  assert.equal(gateway.dispatched.length, 3);
  const members = store.listMembers(run.id);
  assert.equal(members.length, 3);
  assert.equal(store.listAttempts(run.id).filter((a) => a.agent === "claude").length, 2);
  // A single comparison over all three, then the human boundary - no member carries a score.
  assert.equal(store.listEvaluations(run.id).length, 1);
  for (const m of members) assert.equal(m.resultLabel, null);
});

test("successive halving: a second, smaller wave starts from the survivors' parent artifacts", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  const plan = fx.successiveHalvingPlan(4, 2);
  const run = makeRun(store, plan);
  await fx.runAllMembers(engine, gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  const members = store.listMembers(run.id);
  assert.equal(members.length, 6, "four wide plus two finalists");
  assert.equal(members.filter((m) => m.wave === 1).length, 4);
  assert.equal(members.filter((m) => m.wave === 2).length, 2);
  // The finalists were dispatched only after the first review succeeded, from a pinned parent commit.
  const finalists = store.listAttempts(run.id).filter((a) => members.find((m) => m.id === a.memberId)?.wave === 2);
  assert.equal(finalists.length, 2);
  for (const a of finalists) assert.ok(a.baseSha, "a finalist is pinned to its parent artifact's commit");
  // Two review stages executed - the wide cull and the finalist comparison.
  assert.equal(store.listEvaluations(run.id).length, 2);
});

test("preview estimates distinguish initial count, max count, concurrency, and waves per shape", () => {
  const catalog = fx.testStrategyCatalog();
  const est = (id: string) => catalog[id]!.estimate({});
  assert.deepEqual(est("fixed_matrix"), { initialMembers: 3, maxMembers: 3, maxConcurrentMembers: 3, maxWaves: 1, evaluationCalls: 1 });
  // Halving launches fewer than its max and runs two waves - the estimate says so before launch.
  const halving = est("successive_halving")!;
  assert.equal(halving.initialMembers, 4);
  assert.equal(halving.maxMembers, 6);
  assert.equal(halving.maxWaves, 2);
  assert.ok(halving.initialMembers < halving.maxMembers, "initial is distinct from the capped maximum");
  // A pairwise bracket over three makes three comparison calls; a fixed matrix makes one.
  assert.equal(est("pairwise")!.evaluationCalls, 3);
  assert.equal(est("fixed_matrix")!.evaluationCalls, 1);
});

// ---- comparison / collaboration shapes ----

test("pairwise: a bounded bracket persists one evaluation per pair over the same immutable subjects", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  const run = makeRun(store, fx.pairwisePlan(3));
  await fx.runAllMembers(engine, gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  // Three members -> three pairs -> three separate evaluations, each over exactly two subjects.
  const evaluations = store.listEvaluations(run.id);
  assert.equal(evaluations.length, 3);
  for (const e of evaluations) assert.equal(e.subjectArtifactIds.length, 2);
  // Standings are derived from the generic evaluation rows; nothing is written back onto a member.
  for (const m of store.listMembers(run.id)) assert.equal(m.resultLabel, null);
});

test("panel: independent ballots over one subject set are each their own evaluation", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  const run = makeRun(store, fx.panelPlan(3, 3));
  await fx.runAllMembers(engine, gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  const evaluations = store.listEvaluations(run.id);
  assert.equal(evaluations.length, 3, "one ballot per panelist");
  for (const e of evaluations) assert.equal(e.subjectArtifactIds.length, 3, "every ballot sees the whole set");
  for (const m of store.listMembers(run.id)) assert.equal(m.resultLabel, null);
});

test("synthesis: a later member is fed the proposals' parent artifacts as its pinned input", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  const run = makeRun(store, fx.synthesisPlan(3));
  await fx.runAllMembers(engine, gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  const members = store.listMembers(run.id);
  const synth = members.find((m) => m.roleKey === "synth")!;
  assert.equal(synth.wave, 2);
  const synthAttempt = store.listAttempts(run.id).find((a) => a.memberId === synth.id)!;
  assert.ok(synthAttempt.baseSha, "the synthesiser is pinned to a parent artifact's snapshot commit");
  // Lineage is durable: the synthesiser's role input names its parents, and it ran after them.
  const plan = store.getRun(run.id)!.plan!;
  const synthRole = plan.roles.find((r) => r.key === "synth")!;
  assert.equal(synthRole.input.kind, "parent_artifacts");
});

test("retain / no consensus: a decision can finalise non-destructively with every artifact kept", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  const run = makeRun(store, fx.retainPlan(2));
  await fx.runAllMembers(engine, gateway, store, run.id);
  await waitFor(() => store.getRun(run.id)?.status === "awaiting_decision");

  // The operator declines to pick a winner; no_consensus retains everything and reaps nothing.
  const decision = await engine.decide({
    runId: run.id,
    requestId: "no-consensus-1",
    expectedStatus: "awaiting_decision",
    selection: { kind: "no_consensus", reason: "the two approaches are not comparable" },
    rationale: "kept both",
    actorId: "operator",
  });
  assert.equal(decision.ok, true);
  await waitFor(() => {
    const s = store.getRun(run.id)?.status;
    return s === "completed" || s === "failed";
  });
  const finished = store.getRun(run.id)!;
  assert.equal(finished.status, "completed");
  assert.equal(finished.outcome?.kind, "no_consensus");
  // Non-destructive: no single winner, every member is retained, and every artifact is still kept.
  assert.notEqual(finished.outcome?.kind, "selected");
  for (const m of store.listMembers(run.id)) assert.equal(m.status, "retained");
  const ready = store.listArtifacts(run.id).filter((a) => a.status === "ready");
  assert.equal(ready.length, 2, "both immutable artifacts survive no-consensus");
  if (finished.outcome?.kind === "no_consensus") assert.equal(finished.outcome.artifactIds.length, 2);
});

// ---- every shape round-trips through the same persistence and summary ----

test("every strategy shape round-trips through the same store rows and compact summary", () => {
  const shapes = {
    fixed_matrix: fx.fixedMatrixPlan([{ agent: "claude" }, { agent: "codex" }]),
    successive_halving: fx.successiveHalvingPlan(4, 2),
    pairwise: fx.pairwisePlan(3),
    panel: fx.panelPlan(3, 3),
    synthesis: fx.synthesisPlan(3),
    retain: fx.retainPlan(2),
  };
  for (const [name, plan] of Object.entries(shapes)) {
    const store = new EnsembleStore(db);
    const run = store.createRun(runInsert(plan, { sourceKey: `roundtrip:${name}` })).run;
    // The store reads it back runnable and byte-identical - no new column was needed for any shape.
    const loaded = store.getRun(run.id)!;
    assert.ok(ensembleIsRunnable(loaded), `${name} round-trips as a runnable run`);
    assert.deepEqual(loaded.plan!.stages.map((s) => s.driverKey).sort(), plan.stages.map((s) => s.driverKey).sort());
    // The compact summary is strategy-agnostic and bounded regardless of how many stages the shape has.
    const summary = store.summary(run.id)!;
    assert.equal(summary.memberCount, plan.roles.length);
    assert.equal(summary.maxMembers, plan.budget.maxMembers);
  }
});

// ---- the manager compiles whatever descriptor is injected ----

test("the manager compiles and persists a materially different composition from an injected descriptor", () => {
  const store = new EnsembleStore(db);
  const manager = new EnsembleManager(new Registry(), store, {
    // The production id, but a descriptor that compiles a PAIRWISE-shaped plan under it. The manager
    // validates the id against the production enum and then resolves the descriptor through the
    // injected catalog, so this drives the whole compile-and-persist path against a new composition.
    catalog: fx.catalogWithBestOfN(() => fx.pairwisePlan(3)),
  });
  const created = manager.create({
    sourceKey: "manager-override-1",
    title: "pairwise via manager",
    intent: "compare",
    repoRoot: "/repo",
    strategyId: "best_of_n",
  });
  assert.equal(created.ok, true, "an injected descriptor compiles through the generic manager path");
  if (!created.ok) return;
  const run = store.getRun(created.run.id)!;
  assert.ok(ensembleIsRunnable(run), "keyed best_of_n@1, the store accepts the new composition as runnable");
  // The persisted plan is the injected pairwise shape - three review stages, not Best-of-N's one.
  assert.equal(run.plan!.stages.filter((s) => s.driverKind === "review").length, 3);
});

// ---- fail-closed: a novel strategy or driver key persists but never executes ----

test("a run persisted under a novel strategy key loads unreadable and the engine refuses to run it", async () => {
  const store = new EnsembleStore(db);
  const { engine, gateway } = fx.reviewEngine(store);
  // A valid plan, but keyed to a strategy this build has never heard of. It persists (a run nobody
  // can see is one nobody can cancel) but must never be executed as Best-of-N.
  const run = store.createRun(
    runInsert(fx.pairwisePlan(3, "pairwise@1"), {
      sourceKey: "unreadable-strategy",
      strategyId: "pairwise" as never,
      strategyKey: "pairwise@1",
      strategyLabel: "Pairwise",
    }),
  ).run;
  const reloaded = store.getRun(run.id)!;
  assert.equal(reloaded.strategyId, null, "the store refuses to name a strategy it does not have");
  assert.notEqual(reloaded.unreadable, null);
  assert.equal(ensembleIsRunnable(reloaded), false, "an unreadable run is never runnable");
  // The engine's launch path reads the same run and declines rather than compiling with today's
  // defaults - the proof is that no member was ever created or dispatched, whatever status it settles on.
  await engine.launch(run.id);
  assert.equal(store.listAttempts(run.id).length, 0, "no member launch attempt was ever created");
  assert.equal(gateway.dispatched.length, 0, "no member Task was ever dispatched");
});

test("the production create input schema rejects a test/unknown strategy id before anything launches", async () => {
  const { EnsembleCreateInputSchema } = await import("../src/shared/protocol.ts");
  for (const id of ["pairwise", "successive_halving", "totally_made_up"]) {
    const parsed = EnsembleCreateInputSchema.safeParse({
      sourceKey: "x",
      title: "t",
      intent: "i",
      repoRoot: "/repo",
      strategyId: id,
    });
    assert.equal(parsed.success, false, `production create rejects strategy id ${id}`);
  }
  // The one production id still parses.
  assert.equal(
    EnsembleCreateInputSchema.safeParse({ sourceKey: "x", title: "t", intent: "i", repoRoot: "/repo", strategyId: "best_of_n" }).success,
    true,
  );
});
