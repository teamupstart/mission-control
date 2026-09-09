/**
 * The Command run budget, driven through the ENGINE rather than through `runCheck` alone.
 *
 * `test/workflow-check-node.test.ts` already pins the decision at the unit boundary, where
 * `runsSpent` is a number a test hands in. That leaves the part an operator actually feels
 * unproved: whether the count the engine computes from the durable attempt rows agrees with
 * it round after round. The budget is spent by rows written in EARLIER submissions of the
 * same run, so nothing short of a second round can say whether the count is right - a unit
 * test asserting "1 is spent when the cap is 1" would pass just as happily against an engine
 * that recounted from zero on every round, which is the defect this file exists to catch.
 *
 * Every case fakes the execution seam (`checkDeps.execute`) and asserts the CALL LOG, because
 * "the command did not run" is the whole feature; a status assertion alone would pass against
 * an engine that ran the suite and then labelled the result `budget_spent`.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmRunner, LlmRunnerId } from "../src/shared/llm.ts";
import type {
  PersonaExecutionView,
  PublishedWorkflowGraph,
  WorkflowCheckSlot,
  WorkflowCommandView,
  WorkflowContextSnapshot,
} from "../src/shared/workflow.ts";
import { emptyWorkflowCommandView } from "../src/shared/workflow.ts";
import { FIXTURE_RUN_INTENT } from "./helpers/workflow-run-intent.ts";

const home = mkdtempSync(join(tmpdir(), "mission-check-run-budget-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { WorkflowStore, workflowJson } = await import("../src/server/workflows/store.ts");
const { WorkflowEngine } = await import("../src/server/workflows/engine.ts");
const { createCheckScheduler } = await import("../src/server/workflows/checks.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");

/** Session → p1 (Persona) and gate (Check) → Join → End, with the usual repair route back. */
const budgetGraph: PublishedWorkflowGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    {
      id: "p1",
      kind: "persona",
      persona: {
        sourcePersonaId: "p1",
        sourceRevision: 1,
        name: "Reviewer",
        description: "",
        guidanceMarkdown: "REVIEW",
        runner: "claude",
        model: "fake-model",
      },
      position: { x: 200, y: 0 },
    },
    { id: "gate", kind: "check", slot: "test", position: { x: 200, y: 200 } },
    { id: "join", kind: "all_pass", position: { x: 450, y: 100 } },
    { id: "end", kind: "end", outcome: "Complete", position: { x: 700, y: 0 } },
  ],
  edges: [
    { id: "s-p1", source: "session", sourcePort: "submitted", target: "p1", targetPort: "activate" },
    { id: "s-gate", source: "session", sourcePort: "submitted", target: "gate", targetPort: "activate" },
    { id: "p1-pass", source: "p1", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "p1-fail", source: "p1", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "gate-pass", source: "gate", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "gate-fail", source: "gate", sourcePort: "fail", target: "join", targetPort: "result" },
    { id: "join-pass", source: "join", sourcePort: "pass", target: "end", targetPort: "terminal" },
    { id: "join-fail", source: "join", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ],
};

const context: WorkflowContextSnapshot = {
  primaryGoal: { rawPrompt: "REPAIR THE THING", refined: null, sourceNoteKey: "note-1" },
  humanDecisions: [],
  constraints: [],
  acceptanceCriteria: [],
  priorPersonaFeedback: [],
  session: { agent: "claude", name: "work", cwd: "/repo", branch: "feature" },
  evidence: {
    headSha: "abc",
    diffFingerprint: "diff",
    diff: "patch",
    diffTruncated: false,
    workingTreeDirty: false,
    workingTreeStatus: [],
    workingTreeStatusTruncated: false,
    transcript: [],
    transcriptAnchor: null,
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
  },
  compaction: { status: "fallback", runner: null, model: null, error: null },
};

/**
 * The same graph with a SECOND check node on the same slot, both activated by the Session.
 *
 * The shape an operator reaches by gating on the test suite in two stages, and the one that
 * proves the budget belongs to the Command rather than to whichever node asked first: with a
 * limit of one, these two share a single execution inside one round.
 */
const twoGateGraph: PublishedWorkflowGraph = {
  nodes: [
    ...budgetGraph.nodes,
    { id: "gate2", kind: "check", slot: "test", position: { x: 200, y: 320 } },
  ],
  edges: [
    ...budgetGraph.edges,
    { id: "s-gate2", source: "session", sourcePort: "submitted", target: "gate2", targetPort: "activate" },
    { id: "gate2-pass", source: "gate2", sourcePort: "pass", target: "join", targetPort: "result" },
    { id: "gate2-fail", source: "gate2", sourcePort: "fail", target: "join", targetPort: "result" },
  ],
};

function seedVersion(id: string, graph: PublishedWorkflowGraph = budgetGraph): void {
  const db = openDb();
  const defaults = JSON.stringify({ triggerMode: "manual", deliveryMode: "preview", maxRepairRounds: 5 });
  db.prepare(
    `INSERT INTO workflow_definitions (
       id, name, normalized_name, description, draft_graph_json, completion_policy_json,
       binding_defaults_json, draft_revision, current_version_id, archived_at, created_at, updated_at
     ) VALUES (?, ?, ?, '', '{"nodes":[],"edges":[]}', '{"kind":"none"}', ?, 1, ?, NULL, 1, 1)`,
  ).run(`workflow-${id}`, `Review ${id}`, `review-${id}`, defaults, `version-${id}`);
  db.prepare(
    `INSERT INTO workflow_versions (
       id, workflow_id, version, source_draft_revision, graph_json,
       completion_policy_json, binding_defaults_json, published_at
     ) VALUES (?, ?, 1, 1, ?, '{"kind":"none"}', ?, 1)`,
  ).run(`version-${id}`, `workflow-${id}`, JSON.stringify(graph), defaults);
}

/** A run parked at its first submission, ready for the engine to activate. */
function seedSubmission(
  id: string,
  maxRepairRounds = 5,
  graph: PublishedWorkflowGraph = budgetGraph,
): InstanceType<typeof WorkflowStore> {
  seedVersion(id, graph);
  const store = new WorkflowStore();
  const binding = store.insertBinding({
    id: `binding-${id}`,
    workflowVersionId: `version-${id}`,
    noteKey: `note-${id}`,
    sessionId: `session-${id}`,
    sessionAgent: "claude",
    sessionName: id,
    sessionCwd: "/repo",
    sessionRepoRoot: "/repo",
    triggerMode: "manual",
    deliveryMode: "preview",
    maxRepairRounds,
    now: 1,
  });
  store.createInitialSubmission(
    { id: `run-${id}`, binding, intent: FIXTURE_RUN_INTENT, triggerSource: "manual", triggerKey: `manual:${id}:request`, now: 2 },
    {
      id: `submission-${id}`,
      triggerSource: "manual",
      triggerKey: `manual:${id}:request`,
      context: {},
      evidence: {},
      now: 2,
    },
  );
  store.updateSubmissionCapture(`submission-${id}`, {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: `fingerprint-${id}`,
    status: "running",
  }, 3);
  return store;
}

/** The next round of an already-running run, produced by the writer production uses. */
function repairRound(
  store: InstanceType<typeof WorkflowStore>,
  id: string,
  round: number,
): string {
  const submissionId = `submission-${id}-r${round}`;
  store.createRepairSubmission({
    id: submissionId,
    runId: `run-${id}`,
    round,
    triggerSource: "manual",
    triggerKey: `manual:${id}:round-${round}`,
    context: {},
    evidence: {},
    now: 10 * round,
  });
  store.updateSubmissionCapture(submissionId, {
    context: workflowJson(context),
    evidence: workflowJson(context.evidence),
    fingerprint: `fingerprint-${id}-r${round}`,
    status: "running",
  }, 10 * round + 1);
  return submissionId;
}

/**
 * A reviewer whose verdict the test chooses per call, so a round can be made to fail and
 * park the run without the Check ever being the reason it did.
 */
const scriptedRunner = (verdicts: () => "pass" | "fail") => (id: LlmRunnerId): LlmRunner => ({
  id,
  label: id,
  runInThread: null,
  structuredOutput: null,
  sandbox: null,
  price: () => null,
  litter: null,
  killLiveRuns() {},
  async run() {
    return verdicts() === "pass"
      ? JSON.stringify({
          verdict: "pass",
          summary: "Approved",
          approvalDetails: { reason: "Intent is met", evidence: [] },
          confidence: 0.9,
        })
      : JSON.stringify({
          verdict: "fail",
          summary: "Needs repair",
          requestedChanges: [{
            title: "Fix it",
            rationale: "Intent is not met",
            evidence: [{ kind: "goal", quote: "REPAIR THE THING" }],
          }],
          confidence: 0.8,
        });
  },
});

const passingExecution = (snapshot: { runner: LlmRunnerId | null; model: string | null }): PersonaExecutionView => ({
  runner: { id: snapshot.runner ?? "claude", source: "config", unknown: null },
  model: { id: snapshot.model ?? "fake-model", source: "config" },
});

const checkPolicy = () => ({
  liveEnabled: false,
  repoAllowlist: ["/repo"],
  defaultWorkflowId: null,
  retention: { rawEvidenceDays: 30, completedRunDays: 180, maxCompletedRuns: 1_000 },
  checksEnabled: true,
});

/** The catalog reader the engine injects, over one configured `test` Command. */
const catalogFor = (maxRuns: number) => (slot: WorkflowCheckSlot): WorkflowCommandView => ({
  ...emptyWorkflowCommandView(slot),
  maxRuns,
  overrides: slot === "test" ? [{ repoRoot: "/repo", command: ["npm", "test"] }] : [],
});

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for workflow engine");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The gate's raw outcome for one submission, which is what run detail reads back. */
function gateOutcome(
  store: InstanceType<typeof WorkflowStore>,
  submissionId: string,
  nodeId = "gate",
): Record<string, unknown> {
  const attempt = store.listAttempts(submissionId).find((item) => item.nodeId === nodeId);
  assert.ok(attempt, `no ${nodeId} attempt in ${submissionId}`);
  return attempt.output as Record<string, unknown>;
}

test("the default budget of one runs the command in round 1 and records budget_spent in round 2", async () => {
  const store = seedSubmission("default");
  const commands: string[][] = [];
  let round = 0;
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    // Round one fails so the run parks and a second round exists at all; round two passes so
    // the assertion below is about a graph that ADVANCED past a gate that never ran.
    runnerFor: scriptedRunner(() => (++round === 1 ? "fail" : "pass")),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: catalogFor(1),
    checkDeps: () => ({
      execute: async (input: { command: string[] }) => {
        commands.push(input.command);
        return { kind: "exited" as const, exitCode: 0, output: "42 passing\n", truncatedBytes: 0 };
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-default");
  await waitFor(() => store.getRun("run-default")?.status === "waiting_for_session");
  assert.deepEqual(commands, [["npm", "test"]]);
  assert.equal(gateOutcome(store, "submission-default").status, "passed");

  const second = repairRound(store, "default", 2);
  engine.activateSubmission(second);
  await waitFor(() => store.getRun("run-default")?.status === "completed");
  await engine.stop();

  // The executor was never asked a second time. This is the assertion the feature is for.
  assert.deepEqual(commands, [["npm", "test"]]);
  const outcome = gateOutcome(store, second);
  assert.equal(outcome.status, "budget_spent");
  assert.equal(outcome.exitCode, null);
  // The argv it declined to spend time on is retained, so an operator can see what the cap
  // stopped rather than only that something was stopped.
  assert.deepEqual(outcome.command, ["npm", "test"]);
  assert.match(String(outcome.note), /already ran/);
  // And the graph advanced: a pass receipt on the gate edge, and the run reached its End.
  const attempt = store.listAttempts(second).find((item) => item.nodeId === "gate")!;
  assert.equal(attempt.state, "completed");
  assert.equal((attempt.verdict as Record<string, unknown>).verdict, "pass");
  assert.equal(
    store.listReceipts(second).filter((receipt) => receipt.edgeId === "gate-pass").length,
    1,
  );
  assert.equal(store.getRun("run-default")?.currentPhase, "complete");
});

test("a repair-round gate with a spent budget bypasses occupied command capacity", async () => {
  // The dashboard symptom this pins: a repair round showed test as Queued behind unrelated
  // Commands for several minutes, then changed to budget_spent without ever executing. Once
  // an earlier round has spent this Command's allowance, no scarce execution slot is needed
  // to decide the next gate, so an occupied slot must not delay the graph.
  const store = seedSubmission("occupied");
  const checkSchedule = createCheckScheduler(1);
  let round = 0;
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    checkSchedule,
    runnerFor: scriptedRunner(() => (++round === 1 ? "fail" : "pass")),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: catalogFor(1),
    checkDeps: () => ({
      checkoutSubpath: async () => null,
      execute: async () => ({
        kind: "exited" as const,
        exitCode: 0,
        output: "42 passing\n",
        truncatedBytes: 0,
      }),
    }),
  });
  engine.start();
  engine.activateSubmission("submission-occupied");
  await waitFor(() => store.getRun("run-occupied")?.status === "waiting_for_session");

  let releaseCapacity!: () => void;
  let markOccupied!: () => void;
  const capacityReleased = new Promise<void>((resolve) => {
    releaseCapacity = resolve;
  });
  const capacityOccupied = new Promise<void>((resolve) => {
    markOccupied = resolve;
  });
  const occupant = checkSchedule(async () => {
    markOccupied();
    await capacityReleased;
  });
  await capacityOccupied;

  const second = repairRound(store, "occupied", 2);
  try {
    engine.activateSubmission(second);
    // The immediate Persona is a deterministic event-loop boundary: by the time it settles,
    // an ungated budget decision has had every microtask it needs. The old behavior leaves
    // only the Check queued here until capacity is released below.
    await waitFor(() => store.listAttempts(second).some((item) =>
      item.nodeId === "p1" && item.state === "completed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(
      store.listAttempts(second).find((item) => item.nodeId === "gate")?.state,
      "completed",
    );
    assert.equal(gateOutcome(store, second).status, "budget_spent");
  } finally {
    releaseCapacity();
    await occupant;
    await engine.stop();
  }
});

test("a budget of two runs the command in both rounds", async () => {
  const store = seedSubmission("two");
  const commands: string[][] = [];
  let round = 0;
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: scriptedRunner(() => (++round === 1 ? "fail" : "pass")),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: catalogFor(2),
    checkDeps: () => ({
      execute: async (input: { command: string[] }) => {
        commands.push(input.command);
        return { kind: "exited" as const, exitCode: 0, output: "42 passing\n", truncatedBytes: 0 };
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-two");
  await waitFor(() => store.getRun("run-two")?.status === "waiting_for_session");

  const second = repairRound(store, "two", 2);
  engine.activateSubmission(second);
  await waitFor(() => store.getRun("run-two")?.status === "completed");
  await engine.stop();

  assert.equal(commands.length, 2, "a cap of two must let the second round run the command");
  assert.equal(gateOutcome(store, "submission-two").status, "passed");
  assert.equal(gateOutcome(store, second).status, "passed");
});

test("granting repair rounds moves the budget epoch so the next round runs the command again", async () => {
  // One repair round, so round two is the last the run can afford and the grant has something
  // real to revive - the operator's escape hatch is only reachable from a spent run.
  const store = seedSubmission("grant", 1);
  const commands: string[][] = [];
  const manager = new WorkflowManager(new Registry(), store, {
    engine: {
      concurrency: 3,
      runnerFor: scriptedRunner(() => "fail"),
      resolveExecution: passingExecution,
      retryBaseMs: 1,
      workflowPolicy: () => checkPolicy(),
      workflowCommand: catalogFor(1),
      checkDeps: () => ({
        execute: async (input: { command: string[] }) => {
          commands.push(input.command);
          return { kind: "exited" as const, exitCode: 0, output: "42 passing\n", truncatedBytes: 0 };
        },
      }),
    },
  });
  manager.engine.start();
  manager.engine.activateSubmission("submission-grant");
  await waitFor(() => store.getRun("run-grant")?.status === "waiting_for_session");
  assert.equal(commands.length, 1);

  const second = repairRound(store, "grant", 2);
  manager.engine.activateSubmission(second);
  await waitFor(() => store.getRun("run-grant")?.status === "waiting_for_session"
    && store.listAttempts(second).some((item) => item.nodeId === "join" && item.state === "completed"));
  assert.equal(commands.length, 1, "round two spent the budget round one used");
  assert.equal(gateOutcome(store, second).status, "budget_spent");

  // Park the run the way a run that has run out of rounds parks, through the one writer of
  // that block rather than by hand, so the grant below meets the preconditions it ships with.
  store.blockForRoundLimit(store.getRun("run-grant")!, 40);
  const granted = manager.grantRepairRounds("run-grant", { requestId: "grant-1", rounds: 2 }, 41);
  assert.equal(granted.ok, true);
  assert.equal(store.getRun("run-grant")?.checkBudgetEpochRound, 3);

  const third = repairRound(store, "grant", 3);
  manager.engine.activateSubmission(third);
  await waitFor(() => store.listAttempts(third).some((item) => item.nodeId === "gate" && item.state === "completed"));
  await manager.stop();

  assert.equal(commands.length, 2, "the grant must buy the gate a fresh run, not just a round");
  assert.equal(gateOutcome(store, third).status, "passed");
});

test("a round in which the command never ran does not consume budget", async () => {
  // Proved through the engine rather than against the store, because the honest version of
  // this question is whether the ENGINE's count skips a round that produced a passing,
  // completed attempt without spawning anything. The catalog is what changes between rounds:
  // round one has no command configured for this machine, exactly as a fresh install does,
  // and the operator configures one before round two.
  const store = seedSubmission("skip");
  const commands: string[][] = [];
  let configured = false;
  let round = 0;
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: scriptedRunner(() => (++round <= 2 ? "fail" : "pass")),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: (slot: WorkflowCheckSlot) =>
      configured ? catalogFor(1)(slot) : emptyWorkflowCommandView(slot),
    checkDeps: () => ({
      execute: async (input: { command: string[] }) => {
        commands.push(input.command);
        return { kind: "exited" as const, exitCode: 0, output: "42 passing\n", truncatedBytes: 0 };
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-skip");
  await waitFor(() => store.getRun("run-skip")?.status === "waiting_for_session");
  assert.deepEqual(commands, [], "an unconfigured slot must never reach the executor");
  assert.equal(gateOutcome(store, "submission-skip").status, "skipped");

  configured = true;
  const second = repairRound(store, "skip", 2);
  engine.activateSubmission(second);
  await waitFor(() => store.getRun("run-skip")?.status === "waiting_for_session"
    && store.listAttempts(second).some((item) => item.nodeId === "join" && item.state === "completed"));
  // The defect this catches: counting attempts instead of executions would have made round
  // one's skip spend the whole budget, and the newly configured command would never run.
  assert.equal(commands.length, 1);
  assert.equal(gateOutcome(store, second).status, "passed");

  // And the one execution that did happen still spends the budget of one.
  const third = repairRound(store, "skip", 3);
  engine.activateSubmission(third);
  await waitFor(() => store.getRun("run-skip")?.status === "completed");
  await engine.stop();
  assert.equal(commands.length, 1);
  assert.equal(gateOutcome(store, third).status, "budget_spent");
});

test("two check nodes on one Command share its budget inside a single round", async () => {
  // The budget is stored with the Command and reads as "the test suite runs once per run", so
  // a graph that gates on `test` twice must execute it once BETWEEN them. Counting per node
  // would run it twice under a limit of one, which is the setting not being enforced at the
  // level it is configured at.
  //
  // Both gates are activated by the same Session receipt and run concurrently, so this is also
  // the race: they ask within microseconds of each other and neither has finished when the
  // other asks. Only a claim recorded at the moment it is answered can refuse the second.
  const store = seedSubmission("shared", 5, twoGateGraph);
  const commands: string[][] = [];
  const engine = new WorkflowEngine(store, () => {}, {
    concurrency: 3,
    runnerFor: scriptedRunner(() => "pass"),
    resolveExecution: passingExecution,
    retryBaseMs: 1,
    workflowPolicy: () => checkPolicy(),
    workflowCommand: catalogFor(1),
    checkDeps: () => ({
      execute: async (input: { command: string[] }) => {
        commands.push(input.command);
        // A real suite is slow, and holding both gates inside the window where neither has
        // finished is exactly the overlap a per-node count would have let through.
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { kind: "exited" as const, exitCode: 0, output: "42 passing\n", truncatedBytes: 0 };
      },
    }),
  });
  engine.start();
  engine.activateSubmission("submission-shared");
  await waitFor(() => store.getRun("run-shared")?.status === "completed");
  await engine.stop();

  assert.equal(commands.length, 1, "one Command, one allowance, however many nodes name it");
  const outcomes = [
    gateOutcome(store, "submission-shared", "gate").status,
    gateOutcome(store, "submission-shared", "gate2").status,
  ].sort();
  assert.deepEqual(outcomes, ["budget_spent", "passed"], "one ran, the other was skipped");
  // And the run still completed: a shared budget must not turn the second gate into a block.
  assert.equal(store.getRun("run-shared")?.status, "completed");
});
