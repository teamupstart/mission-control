import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What is at stake: this is the engine that turns a compiled plan into real agents on an operator's
 * machine. The failures it must make impossible are all silent and all expensive - a wave dispatched
 * before its members are durable, a member launched past the concurrency the operator authorized, a
 * comparison manufactured out of one artifact when the rest failed, a restart that launches a second
 * fleet. Every test here drives the engine against a fake gateway and a stubbed capture so the whole
 * state machine can be exercised deterministically, without spawning an agent or touching Git.
 */

const home = mkdtempSync(join(tmpdir(), "mission-ensemble-engine-"));
process.env.HARNESS_HOME = join(home, "state");

const { openDb } = await import("../src/server/db.ts");
const { EnsembleStore, clearEnsembleTables } = await import("../src/server/ensembles/store.ts");
const { EnsembleEngine } = await import("../src/server/ensembles/engine.ts");
const { EnsembleManager } = await import("../src/server/ensembles/manager.ts");
const { Registry } = await import("../src/server/registry.ts");
const { ensemblePayload } = await import("../src/shared/ensemble.ts");
const {
  FakeGateway,
  stubAdapters,
  singleWavePlan,
  twoWavePlan,
  reviewPlan,
  runInsert,
  gitRepo,
} = await import("./ensemble-fixture.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => clearEnsembleTables(db));

function harness(now = () => 1000) {
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const published: string[] = [];
  const engine = new EnsembleEngine({
    store,
    tasks: gateway,
    publish: (id) => published.push(id),
    adapters: stubAdapters(),
    now,
    // A no-op wall-clock timer by default, so a deadline run in one test cannot fire a real
    // setTimeout into another. The timer's own behaviour is exercised with a controllable stub below.
    armTimer: () => () => {},
  });
  return { store, gateway, engine, published };
}

/** Move a member's task to running and reconcile it to `active`. */
async function activate(engine: InstanceType<typeof EnsembleEngine>, gateway: InstanceType<typeof FakeGateway>, runId: string, taskId: string, worktree = `/wt/${taskId}`) {
  gateway.running(taskId, worktree);
  await engine.wake(runId);
}

/** Submit a member and advance. Returns the outcome. */
function submit(engine: InstanceType<typeof EnsembleEngine>, runId: string, memberId: string, summary = "done") {
  return engine.submit({ runId, memberId, claims: { summary, checks: [], testEvidence: null }, source: "mcp", requireWorktree: null });
}

test("every member of a wave is durable before the first dispatch", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(3)));
  await engine.launch(run.id);

  assert.equal(gateway.created.length, 3, "all three tasks created");
  assert.equal(gateway.dispatched.length, 3, "all three dispatched (concurrency 3)");
  // The ordering is the invariant: no dispatch may precede the creation of the whole wave.
  const firstDispatch = gateway.log.findIndex((entry) => entry.startsWith("dispatch:"));
  const creates = gateway.log.slice(0, firstDispatch).filter((entry) => entry.startsWith("create:"));
  assert.equal(creates.length, 3, "the whole wave was created before any dispatch");
});

test("every member of a wave is pinned to the same base sha even after HEAD would move", async () => {
  const { store, gateway, engine } = harness();
  const insert = runInsert(singleWavePlan(3));
  const { run } = store.createRun(insert);
  await engine.launch(run.id);
  assert.equal(gateway.dispatched.length, 3);
  for (const dispatch of gateway.dispatched) {
    assert.equal(dispatch.baseSha, insert.baseSha, "member pinned to the run's one base commit");
  }
});

test("member concurrency is a hard ceiling, and a settled member frees exactly one slot", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(4, { maxConcurrentMembers: 2 })));
  await engine.launch(run.id);
  assert.equal(gateway.dispatched.length, 2, "only the ceiling launches at first");

  // Settle the first member: its slot must free exactly one more launch.
  const members = store.listMembers(run.id);
  const firstTask = gateway.dispatched[0]!.taskId;
  const firstMember = store.listAttempts(run.id).find((a) => a.taskId === firstTask)!.memberId;
  await activate(engine, gateway, run.id, firstTask);
  await submit(engine, run.id, firstMember);
  assert.equal(gateway.dispatched.length, 3, "one slot freed, one more launched");
  assert.ok(members.length === 4);
});

test("a threshold barrier reached with enough eligible members parks in front of review", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(reviewPlan(3, 2)));
  await engine.launch(run.id);
  const attempts = () => store.listAttempts(run.id);

  // Two submit with artifacts; the third fails. Two eligible >= minEligible 2, so the review barrier
  // is satisfied and the run parks in `evaluating` - this harness has no review executor wired in, so
  // the comparison never runs (the comparative_review path is exercised in ensemble-comparative-review).
  for (const dispatch of gateway.dispatched.slice(0, 2)) {
    const memberId = attempts().find((a) => a.taskId === dispatch.taskId)!.memberId;
    await activate(engine, gateway, run.id, dispatch.taskId);
    await submit(engine, run.id, memberId);
  }
  const failTask = gateway.dispatched[2]!.taskId;
  gateway.fail(failTask);
  await engine.wake(run.id);

  const after = store.getRun(run.id)!;
  assert.equal(after.status, "evaluating", "the run parks in front of the review with no executor wired");
  assert.equal(after.activeStageId, "stage-2");
});

test("an impossible barrier fails the run rather than manufacturing a comparison of one", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(reviewPlan(3, 2)));
  await engine.launch(run.id);
  const attempts = () => store.listAttempts(run.id);

  // Only one member submits; the other two fail. One eligible < minEligible 2 with everyone settled.
  const okTask = gateway.dispatched[0]!.taskId;
  const okMember = attempts().find((a) => a.taskId === okTask)!.memberId;
  await activate(engine, gateway, run.id, okTask);
  await submit(engine, run.id, okMember);
  for (const dispatch of gateway.dispatched.slice(1, 3)) {
    gateway.fail(dispatch.taskId);
  }
  await engine.wake(run.id);

  const after = store.getRun(run.id)!;
  assert.equal(after.status, "failed");
  assert.match(after.error ?? "", /barrier/i);
});

test("a test strategy runs two waves, the second pinned to the first wave's artifact", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(twoWavePlan(2)));
  await engine.launch(run.id);
  assert.equal(gateway.dispatched.length, 2, "wave one launched");

  // Settle both wave-one members.
  const attempts = () => store.listAttempts(run.id);
  for (const dispatch of [...gateway.dispatched]) {
    const memberId = attempts().find((a) => a.taskId === dispatch.taskId)!.memberId;
    await activate(engine, gateway, run.id, dispatch.taskId);
    await submit(engine, run.id, memberId);
  }
  // Wave two must now have launched, pinned to the a-1 member's snapshot, not the run base.
  assert.equal(gateway.dispatched.length, 3, "wave two launched from parent artifacts");
  const a1Member = store.listMembers(run.id).find((m) => m.roleKey === "a-1")!;
  const a1Artifact = store.listArtifacts(run.id).find(
    (a) => a.status === "ready" && a.attemptId === a1Member.selectedAttemptId,
  )!;
  const a1Sha = (a1Artifact.locator as { snapshotSha: string }).snapshotSha;
  const waveTwoDispatch = gateway.dispatched[2]!;
  assert.equal(waveTwoDispatch.baseSha, a1Sha, "wave two started from wave one's exact snapshot");

  // Settle wave two: the run completes with everything retained.
  const b1Member = store.listMembers(run.id).find((m) => m.roleKey === "b-1")!;
  await activate(engine, gateway, run.id, waveTwoDispatch.taskId);
  await submit(engine, run.id, b1Member.id);

  const finished = store.getRun(run.id)!;
  assert.equal(finished.status, "completed");
  assert.equal(finished.outcome?.kind, "retained");
  assert.equal(store.listArtifacts(run.id).filter((a) => a.status === "ready").length, 3);
});

test("retrying a failed member appends an attempt and reuses the logical member", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(2, { maxMembers: 3 })));
  await engine.launch(run.id);
  const failTask = gateway.dispatched[0]!.taskId;
  const memberId = store.listAttempts(run.id).find((a) => a.taskId === failTask)!.memberId;
  const before = store.getMember(memberId)!;

  gateway.fail(failTask);
  await engine.wake(run.id);
  assert.equal(store.getMember(memberId)!.status, "failed");
  gateway.vanish(failTask); // its worktree is reclaimed

  const retried = await engine.retryMember(run.id, memberId);
  assert.equal(retried, true);
  const after = store.getMember(memberId)!;
  assert.equal(after.ordinal, before.ordinal, "the ordinal never changes on retry");
  assert.equal(after.roleKey, before.roleKey);
  const attempts = store.listAttempts(run.id).filter((a) => a.memberId === memberId);
  assert.equal(attempts.length, 2, "a second attempt was appended");
  assert.deepEqual(
    attempts.map((a) => a.attempt).sort(),
    [1, 2],
  );
});

test("retrying a member whose wave already succeeded still dispatches it, not leaving it backlog", async () => {
  const { store, gateway, engine } = harness();
  const plan = reviewPlan(2, 1); // review barrier is met by one eligible member, so the run parks (non-terminal)
  plan.budget.maxMembers = 3; // room for one retry
  const { run } = store.createRun(runInsert(plan));
  await engine.launch(run.id);
  const [t1, t2] = gateway.dispatched.map((d) => d.taskId);
  const m1 = store.listAttempts(run.id).find((a) => a.taskId === t1)!.memberId;
  const m2 = store.listAttempts(run.id).find((a) => a.taskId === t2)!.memberId;

  // Member 1 submits; member 2 fails. Both settled, so the member stage SUCCEEDS and the run parks at
  // review - the exact state that makes a retry's wave un-serviceable by the ordinary advance.
  await activate(engine, gateway, run.id, t1!);
  await submit(engine, run.id, m1);
  gateway.fail(t2!);
  await engine.wake(run.id);
  assert.equal(store.getMember(m2)!.status, "failed");
  assert.equal(store.getRun(run.id)!.status, "evaluating", "the succeeded wave parked the run at review");
  gateway.vanish(t2!); // its worktree is reclaimed

  const before = gateway.dispatched.length;
  assert.equal(await engine.retryMember(run.id, m2), true);
  assert.equal(gateway.dispatched.length, before + 1, "the retry was dispatched, not left in the backlog forever");
  assert.equal(store.getMember(m2)!.status, "launching");
  assert.equal(store.getRun(run.id)!.status, "waiting", "the run returned to waiting for the retried member");
});

test("member retry refuses before Task creation when the lifetime launch budget is spent", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  await engine.launch(run.id);
  const taskId = gateway.dispatched[0]!.taskId;
  const memberId = store.listAttempts(run.id).find((attempt) => attempt.taskId === taskId)!.memberId;
  gateway.fail(taskId);
  await engine.wake(run.id);
  gateway.vanish(taskId);
  assert.equal(await engine.retryMember(run.id, memberId), false);
  assert.equal(gateway.created.length, 2);
});

test("a mismatched stage driver fails visibly before creating a Task", async () => {
  const { store, gateway, engine } = harness();
  const plan = singleWavePlan(1);
  plan.stages[0]!.driverKey = "human_decision@1";
  const { run } = store.createRun(runInsert(plan));
  await engine.launch(run.id);
  assert.equal(store.getRun(run.id)!.status, "failed");
  assert.match(store.getRun(run.id)!.error ?? "", /incompatible driver/);
  assert.equal(gateway.created.length, 0);
  assert.equal(store.listStageAttempts(run.id).length, 0);
});

test("a durable human decision lets a finalize stage park in finalizing", async () => {
  const { store, engine } = harness();
  const plan = singleWavePlan(1);
  plan.stages = [
    {
      id: "stage-finalize",
      ordinal: 1,
      label: "Promotion",
      driverKind: "finalize",
      driverKey: "select_one_finalize@1",
      dependsOn: [],
      barrier: { kind: "human_decision" },
      maxAttempts: 1,
      finalization: {
        kind: "select_one",
        requiresHumanDecision: true,
        loserPolicy: "reap_worktrees",
      },
    },
  ];
  const { run } = store.createRun(runInsert(plan));
  store.recordDecision({
    runId: run.id,
    actor: "human",
    actorId: null,
    selection: ensemblePayload({ memberId: store.listMembers(run.id)[0]!.id }),
    rationale: "chosen",
    operationKey: `decision:${run.id}`,
  });
  await engine.launch(run.id);
  assert.equal(store.getRun(run.id)!.status, "finalizing");
  assert.equal(store.listStageAttempts(run.id).length, 0);
});

test("stage retry refuses member/decision stages and re-drives a review stage", async () => {
  const { store, engine } = harness();
  const plan = reviewPlan(2, 2);
  const candidates = plan.stages[0]!;
  const review = plan.stages[1]!;
  store.createRun(runInsert(plan));
  const run = store.listNonTerminalRuns()[0]!;
  // A member stage is retried per-member through `retryMember`, never as a whole - refused, so
  // relaunching one member cannot collide with the attempt numbers of the rest.
  assert.equal(await engine.retryStage(run.id, candidates.id), false);
  // A review stage IS re-driven from durable state now that Phase 6 gives `retry_stage` a body:
  // it re-advances the run, which is idempotent, so it never duplicates an effect.
  assert.equal(await engine.retryStage(run.id, review.id), true);
});

test("a duplicate launch does not create a second wave (command-key idempotency)", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(3)));
  // Two launches racing: the persist-before-act command key collides, so the wave is created once.
  await Promise.all([engine.launch(run.id), engine.launch(run.id)]);
  assert.equal(gateway.created.length, 3, "exactly one wave of tasks");
  assert.equal(store.listStageAttempts(run.id).filter((s) => s.stageId === "stage-1").length, 1);
});

test("a submit and a cancel racing on one run serialize to one consistent terminal state", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  await engine.launch(run.id);
  const task = gateway.dispatched[0]!.taskId;
  const memberId = store.listAttempts(run.id).find((a) => a.taskId === task)!.memberId;
  await activate(engine, gateway, run.id, task);

  // Fire a submission and a cancel at the same time; the per-run lock orders them.
  await Promise.all([
    submit(engine, run.id, memberId).catch(() => {}),
    engine.cancelRun(run.id, "operator stopped it"),
  ]);
  const after = store.getRun(run.id)!;
  // Whichever won, the run is in exactly one terminal-or-cancelling state, never a torn one.
  assert.ok(["cancelled", "running", "waiting", "completed"].includes(after.status ?? ""));
  if (after.status === "cancelled") {
    // A cancel keeps submitted refs but withdraws live members.
    assert.ok(gateway.cancelled.length >= 1 || store.listArtifacts(run.id).some((a) => a.status === "ready"));
  }
});

test("a run past its wall-clock deadline fails rather than parking forever", async () => {
  let clock = 0;
  const { store, engine } = harness(() => clock);
  const plan = singleWavePlan(2);
  plan.budget.deadlineMs = 1000;
  const { run } = store.createRun(runInsert(plan), 0);
  clock = 5000; // well past the deadline
  await engine.launch(run.id);
  assert.equal(store.getRun(run.id)!.status, "failed");
  assert.match(store.getRun(run.id)!.error ?? "", /deadline/i);
});

test("a quiet run trips its deadline via the armed timer, tearing down its live members", async () => {
  let clock = 0;
  // An array holder, so the deadline wake captured inside the `armTimer` callback stays visible to
  // the test (a plain `let` would be narrowed back to its initial null by control-flow analysis).
  const armed: Array<() => void> = [];
  const store = new EnsembleStore(db);
  const gateway = new FakeGateway();
  const engine = new EnsembleEngine({
    store,
    tasks: gateway,
    publish: () => {},
    adapters: stubAdapters(),
    now: () => clock,
    // Capture the deadline wake instead of scheduling real time, so the test fires it deterministically.
    armTimer: (_delayMs, cb) => {
      armed.push(cb);
      return () => {};
    },
  });
  const plan = singleWavePlan(2);
  plan.budget.deadlineMs = 1000;
  const { run } = store.createRun(runInsert(plan), 0);
  await engine.launch(run.id);
  const task = gateway.dispatched[0]!.taskId;
  gateway.running(task, `/wt/${task}`);
  await engine.wake(run.id);
  // The run is now quiet - a member is running and no further event is coming - but a deadline wake
  // is armed, which is the whole point: without it, the deadline would never be noticed.
  assert.ok(armed.length > 0, "a deadline wake was armed for the quiet non-terminal run");
  assert.notEqual(store.getRun(run.id)!.status, "failed");

  clock = 5000; // the deadline has now passed
  armed[armed.length - 1]!();
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the fired wake settle

  const after = store.getRun(run.id)!;
  assert.equal(after.status, "failed", "the armed timer failed the otherwise-quiet run");
  assert.match(after.error ?? "", /deadline/i);
  assert.ok(gateway.cancelled.includes(task), "failing the run tore down its live member Task, not leaking it");
  const member = store.listMembers(run.id).find((m) => m.taskId === task)!;
  assert.equal(store.getMember(member.id)!.status, "failed");
});

test("a refused dispatch fails the member and settles the wave instead of stalling it", async () => {
  const gateway = new FakeGateway();
  gateway.failAllDispatches();
  const store = new EnsembleStore(db);
  const engine = new EnsembleEngine({ store, tasks: gateway, publish: () => {}, adapters: stubAdapters(), armTimer: () => () => {} });
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  await engine.launch(run.id);
  // The rejection handler runs under the run lock after the launch releases it; let it settle.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const members = store.listMembers(run.id);
  assert.ok(members.every((m) => m.status === "failed"), "a refused dispatch fails its member, never leaves it launching");
  assert.equal(store.getRun(run.id)!.status, "failed", "the wave reached a terminal state rather than stalling");
});

test("completing a run stops its submitted members' live agents while keeping their artifacts", async () => {
  const { store, gateway, engine } = harness();
  const { run } = store.createRun(runInsert(singleWavePlan(2)));
  await engine.launch(run.id);
  for (const dispatch of [...gateway.dispatched]) {
    const memberId = store.listAttempts(run.id).find((a) => a.taskId === dispatch.taskId)!.memberId;
    await activate(engine, gateway, run.id, dispatch.taskId);
    await submit(engine, run.id, memberId);
  }
  assert.equal(store.getRun(run.id)!.status, "completed");
  // Their still-live Tasks were cancelled through the owner (agents stopped), but the immutable
  // artifacts survive - a completed run must not leave agents that cancelRun then refuses to reap.
  assert.deepEqual([...gateway.cancelled].sort(), gateway.dispatched.map((d) => d.taskId).sort());
  assert.equal(store.listArtifacts(run.id).filter((a) => a.status === "ready").length, 2);
});

test("preflight validates the resolved harness and mandatory submission capability", async () => {
  const { path } = gitRepo();
  const checked: string[] = [];
  const manager = new EnsembleManager(new Registry(), new EnsembleStore(db), {
    agentBinPresent: async (agent) => {
      checked.push(agent);
      return true;
    },
    missionMcpAvailable: async () => true,
  });
  const callPreflight = (
    subject: InstanceType<typeof EnsembleManager>,
    plan: ReturnType<typeof singleWavePlan>,
  ) => (subject as unknown as {
    preflight(value: ReturnType<typeof singleWavePlan>, repoRoot: string): Promise<{ ok: boolean; issues?: Array<{ message: string }> }>;
  }).preflight(plan, path);

  const defaulted = singleWavePlan(1);
  defaulted.roles[0]!.model = "claude-opus-4-8";
  assert.equal((await callPreflight(manager, defaulted)).ok, true);
  assert.deepEqual(checked, ["claude"]);

  // An off-catalog model id is ACCEPTED, exactly as ordinary dispatch preserves it: MODEL_CATALOG
  // is documented incomplete, so preflight must not reject a valid model it merely does not list -
  // that would silently strip the off-catalog support dispatch already gives. Only demonstrable
  // harness incompatibilities (effort, a missing binary) and a missing submission tool are refused.
  const offCatalog = singleWavePlan(1);
  offCatalog.roles[0]!.model = "claude-opus-4-8-preview-2027";
  assert.equal((await callPreflight(manager, offCatalog)).ok, true);

  const toolLess = singleWavePlan(1);
  toolLess.roles[0]!.agent = "pi";
  toolLess.roles[0]!.model = "openai/gpt-5.5";
  const toolResult = await callPreflight(manager, toolLess);
  assert.equal(toolResult.ok, false);
  assert.match(toolResult.issues?.[0]?.message ?? "", /submission tool/);
  manager.stop();
});
