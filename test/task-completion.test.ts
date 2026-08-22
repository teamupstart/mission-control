import assert from "node:assert/strict";
import test from "node:test";
import {
  deferredImperativeList,
  taskCompletionContract,
} from "../src/shared/task-completion.ts";
import { withTaskKindContract } from "../src/server/task-contract.ts";
import { buildVerifyPrompt } from "../src/server/foreman/queue-prompt.ts";
import type { VerifyInput } from "../src/server/foreman/queue-prompt.ts";
import { TASK_KINDS } from "../src/shared/types.ts";
import type { Task, TaskKind } from "../src/shared/types.ts";

/**
 * The trusted completion boundary, and the two ways it can drift.
 *
 * A dispatched ship task is told, on its first turn, to stop before commit, push, pull
 * request and CI. Its durable objective, written by a human, routinely still asks for a
 * pull request. Prompted completion then judges that objective with a tool-less verifier -
 * so unless the verifier is told the same boundary the AGENT was told, it correctly reports
 * a missing PR, the hold spends the completed work-cycle generation, and a finished
 * implementation never reaches the workflow bound to review it. That is the deadlock these
 * tests pin.
 *
 * Drift one: two independently worded definitions of ship-complete, one delivered and one
 * judged against. Both surfaces render from `src/shared/task-completion.ts` and this file
 * is what keeps that true.
 *
 * Drift two: the boundary leaking into the EVIDENCE bar. Deferring a pull request must not
 * make missing tests, missing documentation or a missing implementation any less blocking.
 */

function mkTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Ship the retry",
    intent: "Make the uploader retry on a 500, then open a reviewable pull request.",
    kind: "ship",
    agent: "claude",
    priority: null,
    labels: [],
    dependencies: [],
    enabled: true,
    model: null,
    effort: null,
    workflowId: null,
    source: null,
    repoRoot: "/repos/demo",
    worktreePath: "/work/demo",
    branch: null,
    provider: null,
    baseSha: null,
    extraRepos: [],
    homeName: null,
    terminalResourceId: null,
    sessionId: null,
    status: "running",
    outcome: null,
    outcomeUrl: null,
    error: null,
    scheduleId: null,
    scheduleOccurrenceId: null,
    scheduledFor: null,
    createdAt: 1,
    updatedAt: 1,
    dispatchedAt: null,
    completedAt: null,
    ...overrides,
  } as Task;
}

function mkVerifyInput(overrides: Partial<VerifyInput> = {}): VerifyInput {
  return {
    session: { name: "work", cwd: "/work/demo", gitBranch: "feature" },
    intent: "Make the uploader retry on a 500, then open a reviewable pull request.",
    round: 0,
    diff: "diff --git a/up.ts b/up.ts\n+retry();\n",
    diffTruncated: false,
    diffMayIncludeOtherWork: true,
    transcript: [],
    transcriptTruncated: false,
    standards: [],
    standardsTruncated: false,
    instructions: "",
    priorGaps: [],
    ...overrides,
  };
}

test("every task kind declares a completion boundary, and only ship defers work", () => {
  // The registry is exhaustive at the type level; this asserts the VALUES, so a kind added
  // with a copy-pasted contract it does not want is visible here rather than in a verdict.
  for (const kind of TASK_KINDS) {
    const contract = taskCompletionContract(kind);
    if (kind === "ship") {
      assert.ok(contract, "a ship task has a deferred post-completion boundary");
      assert.equal(contract.kind, "ship");
      assert.ok(contract.complete.length > 0);
      assert.ok(contract.deferred.length > 0);
    } else {
      assert.equal(contract, null, `${kind} finishes inside its own delivered turn`);
    }
  }
  // A session with no task at all - the generic prompted conversation - gets none, which is
  // what keeps this change invisible to a human's own pane-typed work.
  assert.equal(taskCompletionContract(null), null);
  assert.equal(taskCompletionContract(undefined), null);
});

test("the deferred actions are one append-only list, not a wording", () => {
  const contract = taskCompletionContract("ship")!;
  // Ids, not prose: these are what a later phase keys an escalation or a recovery reason
  // on, so re-wording an imperative is free and renaming an id is not.
  assert.deepEqual(
    contract.deferred.map((action) => action.id),
    ["commit", "push", "pull-request", "review", "ci"],
  );
});

test("the delivered handoff and the verifier's trusted policy name the SAME boundary", () => {
  const contract = taskCompletionContract("ship")!;
  const task = mkTask();
  const delivered = withTaskKindContract(task, task.intent);
  const prompt = buildVerifyPrompt(mkVerifyInput({ completionContract: contract }));

  // One source of truth, two renderings. The agent reads an imperative sentence; the
  // verifier reads a noun list. Neither restates the set.
  assert.ok(
    delivered.includes(`do not ${deferredImperativeList(contract)}`),
    `the delivered handoff did not render the contract's deferred actions:\n${delivered}`,
  );
  for (const action of contract.deferred) {
    assert.ok(
      delivered.includes(action.imperative),
      `the agent was never told to defer ${action.id}`,
    );
    assert.ok(
      prompt.includes(action.noun),
      `the verifier was never told ${action.id} is deferred`,
    );
  }
  for (const requirement of contract.complete) {
    assert.ok(prompt.includes(requirement), `the verifier was not told "${requirement}" counts`);
  }
});

test("the trusted boundary is policy: above the evidence fence, and it defers nothing else", () => {
  const contract = taskCompletionContract("ship")!;
  const prompt = buildVerifyPrompt(mkVerifyInput({ completionContract: contract }));

  const policy = prompt.indexOf("## Trusted completion boundary");
  const objective = prompt.indexOf("## What the human asked for");
  const fence = prompt.indexOf("BEGIN UNTRUSTED EVIDENCE");
  assert.ok(policy > 0, "the trusted boundary is rendered");
  assert.ok(objective < policy, "the objective still leads - it is the thing being judged");
  assert.ok(
    policy < fence,
    "a boundary stated after the evidence is a boundary the model reads as a claim the evidence made",
  );
  assert.ok(prompt.includes("NOT evidence"), "the section says which side of the fence it is on");

  // The boundary moves, the bar does not. Deferring a pull request cannot be allowed to
  // read as "be lenient" - every one of these stays blocking.
  for (const stillBlocking of ["missing", "untested", "documentation", "regression"]) {
    assert.ok(prompt.includes(stillBlocking), `the unchanged evidence bar dropped "${stillBlocking}"`);
  }
});

test("a caller that supplies no contract gets the prompt it always got", () => {
  const before = buildVerifyPrompt(mkVerifyInput());
  const withNull = buildVerifyPrompt(mkVerifyInput({ completionContract: null }));
  assert.equal(before, withNull);
  assert.ok(
    !before.includes("Trusted completion boundary"),
    "queue-item verification must be untouched - a commissioned item defers nothing",
  );
});

test("no other task kind's delivery gains a completion boundary it did not ask for", () => {
  for (const kind of TASK_KINDS.filter((k): k is TaskKind => k !== "ship")) {
    const contract = taskCompletionContract(kind);
    assert.equal(contract, null);
    const prompt = buildVerifyPrompt(mkVerifyInput({ completionContract: contract }));
    assert.ok(!prompt.includes("Trusted completion boundary"), `${kind} was handed a ship boundary`);
  }
});
