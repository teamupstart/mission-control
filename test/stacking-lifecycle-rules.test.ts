import assert from "node:assert/strict";
import test from "node:test";
import { mkTask } from "./helpers/session-fixture.ts";
import {
  STACKING_SHIPPED_DEFAULT,
  buildStackPrompt,
  deriveStackState,
  effectiveStacking,
  parseStackObservation,
  stackActionLabel,
  stackActions,
  stackEligibility,
  stackLifecycleLabel,
  stackPromptNeed,
  type StackObservation,
  type StackPromptFacts,
} from "../src/shared/stacking.ts";
import { mergeVerdict, type MergeInput } from "../src/shared/shipping.ts";

// The pure half of the stack lifecycle: which state a stacked child is in, which prompt it
// needs and what that prompt is keyed to, which actions a broken stack offers, and what the
// merge queue says - all from the row's observation, never from the task or the setting.

const HEAD = "a".repeat(40);
const PUSHED = "b".repeat(40);
const PARENT_HEAD = "c".repeat(40);
const PARENT_HEAD_2 = "d".repeat(40);
const MERGE = "e".repeat(40);
const OTHER_MERGE = "f".repeat(40);

function obs(over: Partial<StackObservation> = {}): StackObservation {
  return {
    observedAt: 1, childState: "OPEN", childHeadSha: HEAD, baseRefName: "feat/parent", defaultBranch: "main",
    parentUrl: "https://github.com/acme/repo/pull/7", parentState: "OPEN", parentHeadSha: PARENT_HEAD,
    parentHeadRefName: "feat/parent", parentMergeCommitSha: null, parentHeadInChild: true, baseBehindBy: 0,
    parentTaskStopped: null, parentEpisodeId: "ep-parent", parentTaskId: "parent", retargetError: null, parentUnreadSince: null, ...over,
  };
}

const state = (o: StackObservation | null, releasedHeadSha: string | null = null) => deriveStackState({ observation: o, releasedHeadSha });

test("the state table, one row per state", () => {
  assert.equal(state(obs()), "current");
  assert.equal(state(obs({ parentHeadInChild: false, baseBehindBy: 2 })), "parent-moved");
  assert.equal(state(obs({ parentState: "MERGED", parentMergeCommitSha: MERGE })), "parent-merged-needs-retarget");
  assert.equal(state(obs({ parentState: "MERGED", parentMergeCommitSha: MERGE, baseRefName: "main" })), "restack-needed");
  assert.equal(state(obs({ parentState: "CLOSED" })), "broken");
  assert.equal(state(obs({ parentState: "MERGED", baseRefName: "main" }), HEAD), "released");
  // Never observed yet (a row stacked before this phase): current until the first tick.
  assert.equal(state(null), "current");
});

test("a changed head without the parent's merge commit stays restack-needed", () => {
  // The release check passed for the old head; an unrelated push moved the head on, and the
  // release record does not cover it.
  const o = obs({ parentState: "MERGED", parentMergeCommitSha: MERGE, baseRefName: "main", childHeadSha: PUSHED });
  assert.equal(state(o, HEAD), "restack-needed");
});

test("precedence: a parent that advanced and then merged or closed is never parent-moved", () => {
  const advanced = { parentHeadInChild: false, parentHeadSha: PARENT_HEAD_2 } as const;
  assert.equal(state(obs({ ...advanced, parentState: "MERGED", parentMergeCommitSha: MERGE })), "parent-merged-needs-retarget");
  assert.equal(state(obs({ ...advanced, parentState: "MERGED", parentMergeCommitSha: MERGE, baseRefName: "main" })), "restack-needed");
  assert.equal(state(obs({ ...advanced, parentState: "CLOSED" })), "broken");
  // ...and so neither gets a catch-up prompt.
  for (const o of [
    obs({ ...advanced, parentState: "MERGED", parentMergeCommitSha: MERGE }),
    obs({ ...advanced, parentState: "CLOSED" }),
  ]) {
    assert.notEqual(stackPromptNeed(state(o), o)?.kind, "catch-up");
  }
  // Released beats everything, broken beats a merged parent's retarget.
  assert.equal(state(obs({ parentState: "CLOSED", baseRefName: "main" }), HEAD), "released");
  assert.equal(state(obs({ childState: "CLOSED", parentState: "MERGED", parentMergeCommitSha: MERGE })), "broken");
});

test("a parent task stopped while its pull request is open breaks the stack; after it merged, it does not", () => {
  assert.equal(state(obs({ parentTaskStopped: "cancelled" })), "broken");
  assert.equal(state(obs({ parentTaskStopped: "rescheduled" })), "broken");
  assert.equal(state(obs({ parentTaskStopped: "cancelled", parentState: "MERGED", parentMergeCommitSha: MERGE, baseRefName: "main" })), "restack-needed");
});

test("prompts are keyed to the condition's tip, never to the child's head", () => {
  const moved = obs({ parentHeadInChild: false });
  assert.deepEqual(stackPromptNeed(state(moved), moved), { kind: "catch-up", tip: PARENT_HEAD });
  // An unrelated push to the child: still behind the same parent tip, so the same key.
  const pushed = obs({ parentHeadInChild: false, childHeadSha: PUSHED });
  assert.deepEqual(stackPromptNeed(state(pushed), pushed), { kind: "catch-up", tip: PARENT_HEAD });
  // The parent pushes again: a new key.
  const again = obs({ parentHeadInChild: false, parentHeadSha: PARENT_HEAD_2 });
  assert.deepEqual(stackPromptNeed(state(again), again), { kind: "catch-up", tip: PARENT_HEAD_2 });
  const restack = obs({ parentState: "MERGED", parentMergeCommitSha: MERGE, baseRefName: "main" });
  assert.deepEqual(stackPromptNeed(state(restack), restack), { kind: "restack", tip: MERGE });
  const otherParent = obs({ parentState: "MERGED", parentMergeCommitSha: OTHER_MERGE, baseRefName: "main", childHeadSha: PUSHED });
  assert.deepEqual(stackPromptNeed(state(otherParent), otherParent), { kind: "restack", tip: OTHER_MERGE });
  // Not before the retarget, and never with the merge commit unknown.
  const notYet = obs({ parentState: "MERGED", parentMergeCommitSha: MERGE });
  assert.equal(stackPromptNeed(state(notYet), notYet), null);
  const unknown = obs({ parentState: "MERGED", parentMergeCommitSha: null, baseRefName: "main" });
  assert.equal(stackPromptNeed(state(unknown), unknown), null);
});

test("broken-stack actions are offered by state", () => {
  const parentClosed = obs({ parentState: "CLOSED" });
  assert.deepEqual(stackActions(state(parentClosed), parentClosed), ["move-onto-main", "await-replacement"]);
  const closedAfterMerge = obs({ childState: "CLOSED", parentState: "MERGED", parentMergeCommitSha: MERGE });
  assert.deepEqual(stackActions(state(closedAfterMerge), closedAfterMerge), ["reopen-against-main"]);
  // A closed child whose parent closed: only Move onto main, and never Wait for a replacement.
  const closedBoth = obs({ childState: "CLOSED", parentState: "CLOSED" });
  assert.deepEqual(stackActions(state(closedBoth), closedBoth), ["move-onto-main"]);
  // A child closed while its parent is still open: reopen it on the parent's branch.
  const closedOnOpen = obs({ childState: "CLOSED", parentState: "OPEN" });
  assert.equal(state(closedOnOpen), "broken");
  assert.deepEqual(stackActions(state(closedOnOpen), closedOnOpen), ["reopen-on-parent"]);
  assert.equal(stackActionLabel("reopen-on-parent", 7), "Reopen on #7's branch");
  assert.equal(
    stackLifecycleLabel({ state: "broken", parentNumber: 7, brokenReason: "child-closed", retargetError: null, prompt: null }, closedOnOpen).label,
    "Stack broken: this pull request was closed while #7 is still open",
    "it names the parent as open, never as closed or merged",
  );
  for (const o of [closedAfterMerge, closedBoth, closedOnOpen]) assert.ok(!stackActions(state(o), o).includes("await-replacement"));
  // A stopped parent task: restart its work, so its open pull request can merge or close.
  const stopped = obs({ parentTaskStopped: "cancelled" });
  assert.deepEqual(stackActions(state(stopped), stopped), ["reschedule-parent"]);
  const failed = obs({ parentTaskStopped: "failed" });
  assert.deepEqual(stackActions(state(failed), failed), ["reschedule-parent"]);
  const rescheduled = obs({ parentTaskStopped: "rescheduled" });
  assert.deepEqual(stackActions(state(rescheduled), rescheduled), ["start-parent"]);
  const unknownTask = obs({ parentTaskStopped: "cancelled", parentTaskId: null });
  assert.deepEqual(stackActions(state(unknownTask), unknownTask), [], "nothing to restart without the task");
  assert.equal(stackActionLabel("reschedule-parent", 7), "Reschedule #7's task");
  assert.equal(stackActionLabel("start-parent", 7), "Start #7's task");
  assert.deepEqual(stackActions(state(obs()), obs()), []);
});

test("every lifecycle label the merge queue shows", () => {
  const label = (s: Parameters<typeof stackLifecycleLabel>[0], o: StackObservation | null = obs()) => stackLifecycleLabel(s, o);
  const base = { parentNumber: 7, brokenReason: null, retargetError: null, prompt: null } as const;
  assert.deepEqual(label({ ...base, state: "current" }), { label: "Stacked on #7 (waiting for it to merge)", inProgress: false });
  const prompt = (kind: "catch-up" | "restack", status: "pending" | "sent" | "uncertain" | "no-session" | "foreman-off") =>
    ({ ...base, state: kind === "restack" ? "restack-needed" : "parent-moved", prompt: { kind, tip: PARENT_HEAD, status } }) as const;
  assert.equal(label(prompt("catch-up", "pending")).label, "Catching up with #7");
  assert.deepEqual(label(prompt("restack", "sent")), { label: "Restacking onto main", inProgress: true });
  assert.equal(label(prompt("catch-up", "no-session")).label, "Catch-up needed: no session");
  assert.equal(label(prompt("restack", "no-session")).label, "Restack needed: no session");
  assert.equal(label(prompt("catch-up", "foreman-off")).label, "Catch-up needed: Foreman is off");
  assert.equal(label(prompt("restack", "foreman-off")).label, "Restack needed: Foreman is off");
  assert.equal(label(prompt("catch-up", "uncertain")).label, "Catch-up prompt delivery uncertain");
  assert.equal(label(prompt("restack", "uncertain")).label, "Restack prompt delivery uncertain");
  assert.equal(label({ ...base, state: "current", retargetError: "HTTP 422: base is invalid" }).label, "Retarget failed: HTTP 422: base is invalid");
  assert.equal(label({ ...base, state: "broken", brokenReason: "parent-closed" }).label, "Stack broken: #7 closed");
  assert.equal(label({ ...base, state: "released" }).label, null);
  // Only a restack under way is in progress (bucketed with `waiting`); everything else is held.
  assert.equal(label(prompt("catch-up", "foreman-off")).inProgress, false);
  assert.equal(label({ ...base, state: "broken", brokenReason: "parent-closed" }).inProgress, false);
});

test("lifecycle labels never reach mergeBlock: a broken, held child keeps the stack-hold gate", () => {
  const broken = obs({ parentState: "CLOSED", baseRefName: "main" });
  assert.equal(state(broken), "broken");
  assert.equal(stackLifecycleLabel({ state: "broken", parentNumber: 7, brokenReason: "parent-closed", retargetError: null, prompt: null }, broken).label,
    "Stack broken: #7 closed");
  const input: MergeInput = {
    cfg: { autoMerge: true, method: "squash", soakMinutes: 0, repoAllowlist: ["/repo"], closeSessionAfterMerge: false, codeRabbitAutoResolve: false, maxStackDepth: 3 },
    repoRoot: "/repo", cwd: "/repo",
    pr: { state: "OPEN", isDraft: false, headSha: HEAD, createdAt: 0, mergeable: "MERGEABLE", reviewDecision: null,
      checks: "passing", unresolvedThreads: 0, baseRefName: "main", defaultBranch: "main" },
    stack: { lineage: true, releasedForHead: false },
    reviewedBase: "main", reviewedSha: HEAD, reviewPosture: "live", rounds: 1, openFindings: 0, inspectorPosture: "live",
    now: 1_000_000, workflowGate: "none",
  } as unknown as MergeInput;
  assert.equal(mergeVerdict(input).block, "stack-hold");
});

test("the prompts say merge, never force-push or rebase, and name the exact branches", () => {
  const facts: StackPromptFacts = { prNumber: 32, prUrl: "https://github.com/acme/repo/pull/32", headRefName: "feat/child",
    parentNumber: 31, parentUrl: "https://github.com/acme/repo/pull/31", parentHeadRefName: "feat/parent", defaultBranch: "main" };
  const catchUp = buildStackPrompt("catch-up", facts);
  assert.match(catchUp, /merge `origin\/feat\/parent` into `feat\/child`/);
  const restack = buildStackPrompt("restack", facts);
  assert.match(restack, /merge `origin\/main` into `feat\/child`/);
  for (const text of [catchUp, restack, buildStackPrompt("move-onto-main", facts), buildStackPrompt("reopen-against-main", facts)]) {
    assert.match(text, /Do NOT force-push/);
  }
  assert.match(buildStackPrompt("move-onto-main", facts), /Cherry-pick only this task's own commits/);
  assert.match(buildStackPrompt("move-onto-main", facts), /gh pr create --base main/);
  assert.match(buildStackPrompt("reopen-against-main", facts), /from the same branch, `feat\/child`, with `gh pr create --base main`/);
  const reopen = buildStackPrompt("reopen-on-parent", facts);
  assert.match(reopen, /#31 \(https:\/\/github.com\/acme\/repo\/pull\/31\) is still open/);
  assert.match(reopen, /Open it again against #31's branch/);
  assert.match(reopen, /from the same branch, `feat\/child`, with `gh pr create --base feat\/parent`/);
  assert.match(reopen, /"Stacked on #31"/);
  assert.match(reopen, /Do not reopen it against the default branch/);
  assert.match(reopen, /Do NOT force-push/);
});

test("facts the last read could not confirm offer no prompt and no action", () => {
  const moved = obs({ parentHeadInChild: false, parentUnreadSince: 9 });
  assert.equal(state(moved), "parent-moved", "the state still describes the last facts");
  assert.equal(stackPromptNeed(state(moved), moved), null, "but no catch-up is offered on them");
  const merged = obs({ parentState: "MERGED", parentMergeCommitSha: MERGE, baseRefName: "main", parentUnreadSince: 9 });
  assert.equal(stackPromptNeed(state(merged), merged), null);
  const closed = obs({ parentState: "CLOSED", parentUnreadSince: 9 });
  assert.deepEqual(stackActions(state(closed), closed), []);
});

test("a persisted observation reads back, and a malformed one reads as none", () => {
  const o = obs({ parentHeadInChild: false, baseBehindBy: 3, retargetError: "HTTP 422" });
  assert.deepEqual(parseStackObservation(JSON.stringify(o)), o);
  assert.equal(parseStackObservation("{not json"), null);
  assert.equal(parseStackObservation(JSON.stringify({ parentState: "OPEN" })), null);
  assert.equal(parseStackObservation(null), null);
});

test("stacking is on by default: no stored value stacks, an explicit Wait for merge and an After merge edge still wait", () => {
  assert.equal(STACKING_SHIPPED_DEFAULT, "stack");
  assert.equal(effectiveStacking({}), "stack");
  const parent = mkTask({ id: "parent", status: "running", repoRoot: "/repo", title: "Parent" });
  const edge = { type: "task" as const, taskId: "parent", title: "Parent", sessionId: null, episodeId: null,
    agentSessionId: null, branch: null, prUrl: null, selectedAt: null, satisfiedAt: null };
  const child = mkTask({ id: "child", status: "backlog", repoRoot: "/repo", dependencies: [edge] });
  assert.equal(stackEligibility(child, [parent, child], { maxStackDepth: 3 }).ok, true, "no stored choice stacks");
  const explicit = stackEligibility(child, [parent, child], { stacking: "merge", maxStackDepth: 3 });
  assert.equal(explicit.ok === false && explicit.code, "after-merge");
  const afterMerge = mkTask({ id: "child", status: "backlog", repoRoot: "/repo", dependencies: [{ ...edge, mode: "merge" }] });
  const edgeWaits = stackEligibility(afterMerge, [parent, afterMerge], { maxStackDepth: 3 });
  assert.equal(edgeWaits.ok === false && edgeWaits.code, "after-merge");
});
