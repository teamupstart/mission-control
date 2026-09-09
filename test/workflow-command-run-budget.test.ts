import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_WORKFLOW_POLICY,
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_COMMAND_DEFAULT_MAX_RUNS,
  WORKFLOW_LIMITS,
  checkOutcomePasses,
  checkRunBudgetSpent,
  emptyWorkflowCommandView,
  workflowCommandRunsFact,
} from "../src/shared/workflow.ts";
import type {
  WorkflowCheckSlot,
  WorkflowCommandView,
  WorkflowPolicy,
} from "../src/shared/workflow.ts";

// What is at stake: a Command's run budget is the difference between a workflow that spends
// twenty minutes running the same test suite in every repair round and one that gates on it
// once. That makes it a setting whose FAILURE MODES are asymmetric, and this file pins both
// directions.
//
// Too loose and the feature does nothing. Too tight and a gate silently stops gating - which
// is the direction that costs something, because a check that passes without running looks
// exactly like a check that ran and was satisfied unless the outcome says otherwise. So the
// budget skip is its own durable status carrying its own sentence, the count is executions
// rather than attempts, and a value this build cannot read degrades toward RUNNING the
// command rather than toward skipping it.

const home = mkdtempSync(join(tmpdir(), "mission-command-run-budget-"));
const state = join(home, "state");

/**
 * A database whose `workflow_commands` predates `max_runs`, with a slot already configured.
 *
 * The genuine upgrade path, which the sibling `workflow-commands-db` fixture cannot reach: it
 * seeds a database with no catalog table at all, so `CREATE TABLE` supplies the column and
 * `addColumn` is never exercised. An operator upgrading this product has the other shape, and
 * the thing that must not happen to them is a catalog that reads as unconfigured because one
 * new column was missing from rows they wrote months ago.
 */
function seedPreBudgetDb(): void {
  mkdirSync(state, { recursive: true });
  const raw = new DatabaseSync(join(state, "harness.db"));
  raw.exec(`
    CREATE TABLE IF NOT EXISTS workflow_commands (
      slot                 TEXT PRIMARY KEY,
      default_command_json TEXT,
      revision             INTEGER NOT NULL DEFAULT 1,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_command_overrides (
      slot         TEXT NOT NULL,
      repo_root    TEXT NOT NULL,
      command_json TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      PRIMARY KEY (slot, repo_root)
    );
  `);
  raw.prepare(
    `INSERT INTO workflow_commands (slot, default_command_json, revision, created_at, updated_at)
     VALUES ('test', ?, 4, 1, 1)`,
  ).run(JSON.stringify(["npm", "test"]));
  raw.prepare(
    `INSERT INTO workflow_command_overrides (slot, repo_root, command_json, created_at, updated_at)
     VALUES ('test', '/repo', ?, 1, 1)`,
  ).run(JSON.stringify(["npm", "run", "test:ci"]));
  raw.close();
}

seedPreBudgetDb();
process.env.HARNESS_HOME = state;

const { openDb } = await import("../src/server/db.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { runCheck } = await import("../src/server/workflows/checks.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const REPO = "/repos/thing";
const ALLOWED: WorkflowPolicy = {
  ...DEFAULT_WORKFLOW_POLICY,
  checksEnabled: true,
  repoAllowlist: [REPO],
};

/** One slot's catalog entry, configured, in the grouped shape the daemon projects. */
const configured = (
  maxRuns: number,
  slot: WorkflowCheckSlot = "test",
): WorkflowCommandView => ({
  ...emptyWorkflowCommandView(slot),
  overrides: [{ repoRoot: REPO, command: ["npm", "test"] }],
  maxRuns,
});

/**
 * A check about to run in a repository that allows it, against a fake budget.
 *
 * `spent` is what the ladder is told HAD been spent when it asks; `null` means the caller has
 * no run at all and declines the budget rule. The reservation is granted or refused here by
 * the same shared rule the store applies, so these cases exercise the ladder's handling of the
 * answer without needing a database.
 */
const at = (
  command: WorkflowCommandView | null,
  spent: number | null,
  policy: WorkflowPolicy = ALLOWED,
) => ({
  slot: "test" as WorkflowCheckSlot,
  policy,
  command,
  reserveRun: spent === null ? null : () => ({
    granted: !checkRunBudgetSpent(spent, command?.maxRuns ?? WORKFLOW_COMMAND_DEFAULT_MAX_RUNS),
    spent,
  }),
  cwd: REPO,
  repoRoot: REPO,
  headSha: "a".repeat(40),
});

/**
 * A run with one submission, and the attempt rows a reservation is written onto.
 *
 * Raw inserts for the run and its submission, because what is under test is a COUNT over those
 * two tables and building them through the manager would drag a binding, a published version
 * and a capture into a question that needs none of them. The attempts go through
 * `insertAttempt` so their state is real and `finishAttempt` can move it.
 */
function seedRun(store: InstanceType<typeof WorkflowStore>, id: string, round: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO workflow_runs
       (id, binding_id, workflow_version_id, status, current_phase, max_repair_rounds,
        trigger_source, trigger_key, started_at, updated_at)
     VALUES (?, 'binding', 'version', 'running', 'review', 5, 'manual', ?, 1, 1)`,
  ).run(`run-${id}`, `trigger-${id}`);
  seedSubmission(store, id, round);
}

/** One more immutable evidence snapshot for an existing run, at `round`. */
function seedSubmission(
  store: InstanceType<typeof WorkflowStore>,
  id: string,
  round: number,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO workflow_submissions
       (id, run_id, round, mode, trigger_source, trigger_key, evidence_fingerprint,
        context_json, evidence_json, status, created_at, updated_at)
     VALUES (?, ?, ?, 'full', 'manual', ?, 'fingerprint', '{}', '{}', 'running', 1, 1)`,
  ).run(`submission-${id}-${round}`, `run-${id}`, round, `sub-${id}-${round}`);
  // One attempt per id the cases below reserve against. They are `running`, which is the state
  // an attempt is in at the moment it claims a run.
  for (const suffix of ["a", "b", "c", `r${round}`]) {
    store.insertAttempt({
      id: `attempt-${id}-${round}-${suffix}`,
      submissionId: `submission-${id}-${round}`,
      nodeId: `gate-${suffix}`,
      attempt: 1,
      state: "running",
      persona: null,
      inputFingerprint: "fingerprint",
      now: 1,
    });
  }
}

/** An executor that records every spawn it is asked for and always succeeds. */
function spy() {
  const seen: unknown[] = [];
  return {
    seen,
    execute: async (request: unknown) => {
      seen.push(request);
      return { kind: "exited" as const, exitCode: 0, output: "", truncatedBytes: 0 };
    },
  };
}

test("the default budget is one run, and the ceiling covers every round a run can reach", () => {
  // Both halves of this are load-bearing claims made in prose elsewhere, so they are asserted
  // rather than trusted. The default is what every existing catalog silently adopts on
  // upgrade; the ceiling is what makes "keep running it every round, as it always did"
  // expressible at all, and the plus one is not slack. A run is an initial submission followed
  // by at most `repairRoundsMax` repair rounds, so `repairRoundsMax` alone would leave the
  // option labelled "every round" one execution short of the last round it promises.
  assert.equal(WORKFLOW_COMMAND_DEFAULT_MAX_RUNS, 1);
  assert.equal(WORKFLOW_LIMITS.commandMaxRunsMin, 1);
  assert.equal(
    WORKFLOW_LIMITS.commandMaxRunsMax,
    WORKFLOW_LIMITS.repairRoundsMax + 1,
    "a budget at the ceiling must cover every round a run can reach, and no more",
  );
  assert.equal(emptyWorkflowCommandView("test").maxRuns, WORKFLOW_COMMAND_DEFAULT_MAX_RUNS);
});

test("the budget rule counts what has finished, and refuses to be switched off by a bad value", () => {
  // `spent` counts FINISHED executions, so the attempt asking is the `spent + 1`th - which is
  // why a budget of one is spent at one and not at two.
  assert.equal(checkRunBudgetSpent(0, 1), false);
  assert.equal(checkRunBudgetSpent(1, 1), true);
  assert.equal(checkRunBudgetSpent(1, 2), false);
  assert.equal(checkRunBudgetSpent(2, 2), true);

  // A zero or a negative would be a gate that skips forever, which is a way to disable a
  // Command that this catalog already expresses by leaving it unconfigured. Clamped toward
  // RUNNING rather than toward skipping: a gate that runs when it did not need to costs time,
  // and one that never runs again costs the assurance the gate exists for.
  assert.equal(checkRunBudgetSpent(0, 0), false);
  assert.equal(checkRunBudgetSpent(0, -5), false);
  assert.equal(checkRunBudgetSpent(1, 0), true);
});

test("the budget reads as a sentence, in the unit an operator reasons about", () => {
  // "per workflow run" and not "per round", because spanning rounds IS the feature: an
  // operator who watched the gate run in round one has to know round two will not run it.
  assert.equal(workflowCommandRunsFact(1), "Runs once per workflow run");
  assert.equal(workflowCommandRunsFact(3), "Runs up to 3 times per workflow run");
  assert.equal(workflowCommandRunsFact(0), "Runs once per workflow run", "clamped, as the rule is");
});

test("a spent budget skips the gate, passes, and says so without spawning anything", async () => {
  const stub = spy();
  const result = await runCheck(at(configured(1), 1), { execute: stub.execute });
  assert.equal(result.kind, "outcome");
  if (result.kind !== "outcome") return;

  assert.deepEqual(stub.seen, [], "a spent budget must never reach the execution runtime");
  assert.equal(result.outcome.status, "budget_spent");
  assert.equal(checkOutcomePasses(result.outcome), true, "the graph has to keep moving");
  assert.equal(result.outcome.exitCode, null);

  // The command IS carried, unlike an unconfigured skip: resolution succeeded, and the argv
  // is exactly what the run declined to spend time on again. An operator deciding whether the
  // cap is set where they want it needs to see which command it is capping.
  assert.deepEqual(result.outcome.command, ["npm", "test"]);

  // The note has to name the limit and where the remaining coverage comes from, or a gate
  // that passed without running reads as a bug in the gate.
  assert.match(result.outcome.note, /already ran once in this workflow run/);
  assert.match(result.outcome.note, /limit of one run/);
  assert.match(result.outcome.note, /CI still runs it against the merge commit/);
});

test("a budget with room left runs the command, and the last permitted run still runs", async () => {
  // The off-by-one that would make a budget of N mean N-1. A run that has spent 1 of 2 is
  // asking for its second and last execution, and that one must actually happen.
  const second = spy();
  const result = await runCheck(at(configured(2), 1), { execute: second.execute });
  assert.equal(result.kind === "outcome" && result.outcome.status, "passed");
  assert.equal(second.seen.length, 1);

  // And the one after it is refused.
  const third = spy();
  const spent = await runCheck(at(configured(2), 2), { execute: third.execute });
  assert.equal(spent.kind === "outcome" && spent.outcome.status, "budget_spent");
  assert.deepEqual(third.seen, []);
});

test("the note counts in plain words, so a budget above one reads correctly", async () => {
  const result = await runCheck(at(configured(3), 3), { execute: spy().execute });
  assert.equal(result.kind === "outcome" && result.outcome.status, "budget_spent");
  assert.match(
    result.kind === "outcome" ? result.outcome.note : "",
    /already ran 3 times in this workflow run/,
  );
  assert.match(result.kind === "outcome" ? result.outcome.note : "", /limit of 3 runs/);
});

test("a caller with no run declines the budget rule rather than inheriting one", async () => {
  // `null` is not a refused reservation. A probe with no run behind it has no budget to spend,
  // and answering it with "spent" would make a gate unrunnable outside a run for a reason that
  // has nothing to do with the operator's setting.
  const stub = spy();
  const result = await runCheck(at(configured(1), null), { execute: stub.execute });
  assert.equal(result.kind === "outcome" && result.outcome.status, "passed");
  assert.equal(stub.seen.length, 1);
});

test("a slot nobody configured is skipped for THAT reason, and never spends a run", async () => {
  // Precedence, and it matters twice over. The two skips send an operator to different places -
  // "you configured nothing" is answered in the Command Library's command field, "the budget is
  // spent" by the control beside it - and only one of them is true here.
  //
  // The reservation is the second half: a gate refused before the budget rung must not CALL it,
  // or a run would spend its whole allowance on rounds where nothing was ever executed.
  let claims = 0;
  const result = await runCheck({
    ...at(emptyWorkflowCommandView("test"), 99),
    reserveRun: () => {
      claims += 1;
      return { granted: false, spent: 99 };
    },
  }, { execute: spy().execute });
  assert.equal(result.kind === "outcome" && result.outcome.status, "skipped");
  assert.match(
    result.kind === "outcome" ? result.outcome.note : "",
    /No test Command is configured/,
  );
  assert.equal(claims, 0, "an unconfigured slot must never claim a run it cannot use");
});

test("an unauthorized repository never claims a run either", async () => {
  // The same rule on the other refusal above the budget rung. An operator who grants the
  // repository later must find the allowance untouched by the rounds that could not run.
  let claims = 0;
  const result = await runCheck({
    ...at(configured(1), 0, { ...DEFAULT_WORKFLOW_POLICY, checksEnabled: false, repoAllowlist: [REPO] }),
    reserveRun: () => {
      claims += 1;
      return { granted: true, spent: 0 };
    },
  }, { execute: spy().execute });
  assert.equal(result.kind === "outcome" && result.outcome.status, "unavailable");
  assert.equal(claims, 0);
});

test("an unauthorized repository is unavailable, even with budget to spare", async () => {
  // The other precedence edge. Authorization is a fact about the environment that stays true
  // whatever the budget says, and telling an operator about a cap they have room under would
  // send them to fix the wrong thing.
  const offSwitch = await runCheck(
    at(configured(5), 0, { ...DEFAULT_WORKFLOW_POLICY, checksEnabled: false, repoAllowlist: [REPO] }),
    { execute: spy().execute },
  );
  assert.equal(offSwitch.kind === "outcome" && offSwitch.outcome.status, "unavailable");
});

test("a build with no execution runtime never claims a run", async () => {
  // The regression this test exists for: the reservation used to be taken BEFORE the runtime
  // seam was checked, so every platform that cannot run Commands claimed an allowance and then
  // threw it away. Nothing executed, but the run was spent - and the next round, or a sibling
  // gate on a machine that can run them, was refused as `budget_spent` for executions that
  // never happened.
  //
  // `deps` with no `execute` is exactly the shipped state of a build with no execution
  // runtime, which is why this is the honest way to drive it.
  let claims = 0;
  const result = await runCheck({
    ...at(configured(1), 0),
    reserveRun: () => {
      claims += 1;
      return { granted: true, spent: 0 };
    },
  }, {});
  assert.equal(result.kind === "outcome" && result.outcome.status, "unavailable");
  assert.equal(claims, 0, "a gate that cannot run a command must not spend one");
});

test("an unavailable runtime leaves the budget for the round that can use it", () => {
  // The same defect stated as the consequence an operator would meet, and against the store
  // rather than a spy: if the unavailable path had claimed the allowance, the count would be 1
  // here and the gate that CAN run the command would be skipped for a limit nobody reached.
  const store = new WorkflowStore(db);
  seedRun(store, "runtime", 1);
  assert.equal(store.checkRunsSpent("run-runtime", "test", null), 0);

  // Whatever the ladder decides on a runtime-less build, no reservation is written - so the
  // allowance is still whole for the attempt that reaches an executor.
  assert.equal(
    store.reserveCheckRun("run-runtime", "attempt-runtime-1-a", "test", 1, null).granted,
    true,
    "the first attempt that actually reaches a command must still be granted",
  );
});

test("the budget belongs to the Command, so two nodes naming one slot share it", () => {
  // THE rule this feature is configured at. The maximum is stored with the Command and reads
  // as "the test suite runs once per run", so a graph that gates on `test` in two places must
  // execute it once between them - not once each. Counting per node would have let a limit of
  // one run twice in a single round, which is the setting not being enforced where it is set.
  const store = new WorkflowStore(db);
  seedRun(store, "shared", 1);

  const first = store.reserveCheckRun("run-shared", "attempt-shared-1-a", "test", 1, null);
  assert.deepEqual(first, { granted: true, spent: 0 });

  // A DIFFERENT node, same slot, same run, same round. It finds the allowance already taken.
  const second = store.reserveCheckRun("run-shared", "attempt-shared-1-b", "test", 1, null);
  assert.deepEqual(second, { granted: false, spent: 1 });

  // And a different Command is untouched: the budget is per slot, not per run.
  assert.deepEqual(
    store.reserveCheckRun("run-shared", "attempt-shared-1-c", "lint", 1, null),
    { granted: true, spent: 0 },
  );
});

test("a reservation is recorded before the claim returns, which is what makes it shared", () => {
  // The race the reservation exists to close. Two checks in one stage run concurrently, so a
  // caller that counted, awaited its command and only then recorded the execution would let
  // both read the same zero. Asserting the count MOVES on the granting call is what proves the
  // claim is durable at the moment it is answered rather than when the command finishes.
  const store = new WorkflowStore(db);
  seedRun(store, "race", 1);
  assert.equal(store.checkRunsSpent("run-race", "test", null), 0);
  store.reserveCheckRun("run-race", "attempt-race-1-a", "test", 2, null);
  assert.equal(store.checkRunsSpent("run-race", "test", null), 1, "the claim is recorded now");
  store.reserveCheckRun("run-race", "attempt-race-1-b", "test", 2, null);
  assert.equal(store.checkRunsSpent("run-race", "test", null), 2);
  assert.equal(
    store.reserveCheckRun("run-race", "attempt-race-1-c", "test", 2, null).granted,
    false,
    "a budget of two is spent by two reservations, whoever made them",
  );
});

test("an infrastructure failure returns the run it reserved, so its retry is not refused", () => {
  // An infra retry is the SAME execution asked again, not a second one. Its attempt row ends
  // in `error`, and excluding that state is what lets the retry claim the budget the dead try
  // never really spent - otherwise a single flaky worktree lease would burn a gate's whole
  // allowance and every later round would report a limit nobody reached.
  const store = new WorkflowStore(db);
  seedRun(store, "infra", 1);
  assert.equal(store.reserveCheckRun("run-infra", "attempt-infra-1-a", "test", 1, null).granted, true);
  store.finishAttempt("attempt-infra-1-a", { state: "error", error: "the lease died" }, 50);
  assert.equal(store.checkRunsSpent("run-infra", "test", null), 0, "a dead try spends nothing");
  assert.equal(store.reserveCheckRun("run-infra", "attempt-infra-1-b", "test", 1, null).granted, true);
});

test("the epoch is what a grant moves, and it releases the whole slot", () => {
  // The operator escape hatch, at the level the budget lives. A grant that freed only the node
  // that happened to run would leave a sibling gate skipped for an allowance the operator has
  // already replaced.
  const store = new WorkflowStore(db);
  seedRun(store, "epoch", 1);
  store.reserveCheckRun("run-epoch", "attempt-epoch-1-a", "test", 1, null);
  assert.equal(store.reserveCheckRun("run-epoch", "attempt-epoch-1-b", "test", 1, null).granted, false);

  // Round 2 exists and the epoch moves to it, exactly as `grantRepairRounds` writes it.
  seedSubmission(store, "epoch", 2);
  assert.equal(store.checkRunsSpent("run-epoch", "test", 2), 0, "round 1 is behind the epoch");
  assert.equal(
    store.reserveCheckRun("run-epoch", "attempt-epoch-2-r2", "test", 1, 2).granted,
    true,
    "a granted run must be able to gate on the Command again",
  );
});

test("an upgrading catalog gains the column, keeps its commands, and adopts the default", () => {
  // The migration an operator actually experiences. `addColumn` appends `max_runs` to a table
  // that already holds their configuration, so the column arrives LAST here rather than where
  // `CREATE TABLE` would put it - and the rows themselves must be untouched.
  const columns = (db.prepare(`PRAGMA table_info(workflow_commands)`)
    .all() as unknown as Array<{ name: string }>).map((column) => column.name);
  assert.deepEqual(
    columns,
    ["slot", "default_command_json", "revision", "created_at", "updated_at", "max_runs"],
  );

  const store = new WorkflowStore(db);
  const view = store.getWorkflowCommand("test")!;
  assert.deepEqual(view.defaultCommand, ["npm", "test"], "the stored command must survive");
  assert.deepEqual(view.overrides, [{ repoRoot: "/repo", command: ["npm", "run", "test:ci"] }]);
  assert.equal(view.revision, 4, "a migration is not an edit two windows should see");
  assert.equal(view.maxRuns, WORKFLOW_COMMAND_DEFAULT_MAX_RUNS);

  // Every slot the catalog projects carries a budget, including the ones nobody has written.
  for (const slot of WORKFLOW_CHECK_SLOTS) {
    assert.equal(store.getWorkflowCommand(slot)?.maxRuns, WORKFLOW_COMMAND_DEFAULT_MAX_RUNS);
  }
});

test("the budget survives a whole-slot save and is clamped rather than trusted", () => {
  const store = new WorkflowStore(db);
  const before = store.getWorkflowCommand("lint")!;
  assert.equal(
    store.replaceWorkflowCommandCas("lint", before.revision, {
      defaultCommand: ["npm", "run", "lint"],
      overrides: [],
      maxRuns: 4,
    }, 2_000).ok,
    true,
  );
  assert.equal(store.getWorkflowCommand("lint")?.maxRuns, 4);

  // The store is the boundary a future caller reaches without passing the route schema, so it
  // refuses to persist a value that would switch the gate off permanently.
  const held = store.getWorkflowCommand("lint")!;
  assert.equal(
    store.replaceWorkflowCommandCas("lint", held.revision, {
      defaultCommand: ["npm", "run", "lint"],
      overrides: [],
      maxRuns: 0,
    }, 3_000).ok,
    true,
  );
  assert.equal(
    store.getWorkflowCommand("lint")?.maxRuns,
    WORKFLOW_LIMITS.commandMaxRunsMin,
    "a zero budget must never be stored as one",
  );

  const ceiling = store.getWorkflowCommand("lint")!;
  store.replaceWorkflowCommandCas("lint", ceiling.revision, {
    defaultCommand: ["npm", "run", "lint"],
    overrides: [],
    maxRuns: 9_999,
  }, 4_000);
  assert.equal(store.getWorkflowCommand("lint")?.maxRuns, WORKFLOW_LIMITS.commandMaxRunsMax);
});

test("a hand-edited budget degrades the field toward running, not the slot toward unconfigured", () => {
  // The same rule `default_command_json` follows: one unreadable value must not hide a command
  // an operator can otherwise see and repair. And an unreadable budget resolves to the
  // default, which RUNS the gate - the safe direction for a value that decides whether a gate
  // gates at all.
  const store = new WorkflowStore(db);
  const before = store.getWorkflowCommand("build")!;
  store.replaceWorkflowCommandCas("build", before.revision, {
    defaultCommand: ["npm", "run", "build"],
    overrides: [],
    maxRuns: 3,
  }, 5_000);
  // A string, because the column's own NOT NULL already refuses the emptier corruption - so
  // the value that actually reaches a reader is a wrong TYPE, which SQLite stores happily and
  // no constraint can catch.
  db.prepare(`UPDATE workflow_commands SET max_runs = 'lots' WHERE slot = 'build'`).run();

  const view = new WorkflowStore(db).getWorkflowCommand("build")!;
  assert.deepEqual(view.defaultCommand, ["npm", "run", "build"], "the slot must still be readable");
  assert.equal(view.maxRuns, WORKFLOW_COMMAND_DEFAULT_MAX_RUNS);
});
