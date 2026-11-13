import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { Session, Task } from "../src/shared/types.ts";
import type { PrRefs, PrSnapshot } from "../src/server/inspector/github.ts";
import type { StackGitHub } from "../src/server/stacking/github.ts";
import type { StackLifecycleContext } from "../src/server/stacking/state.ts";
import {
  buildStackPrompt,
  deriveStackState,
  mergeLandedOnDefault,
  stackBrokenReason,
  stackLifecycleLabel,
  stackPromptNeed,
  type StackObservation,
} from "../src/shared/stacking.ts";

// A stacked child merged by hand into its parent's branch after that parent had already merged
// (the #1416 / #1417 incident): the lifecycle reads it as Broken with its own reason, offers the
// recovery prompt keyed to the child's merge commit, claims that prompt once, and never reads
// the merge as a release. The poller half - that such a merge completes nothing - is in
// `stacking-stray-merge-poller.test.ts`.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-stray-merge-"));
process.env.HARNESS_HOME = home;
const db = await import("../src/server/db.ts");
const { observeClosedStackChildren, observeStackLifecycle } = await import("../src/server/stacking/state.ts");
const { stackPromptCandidate, stackStandingFor } = await import("../src/server/stacking/delivery.ts");
const { adoptStackLineage } = await import("../src/server/stacking/lineage.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const PARENT = "https://github.com/acme/repo/pull/1416";
const CHILD = "https://github.com/acme/repo/pull/1417";
const RECOVERY = "https://github.com/acme/repo/pull/1456";
const PARENT_HEAD = "d".repeat(40);
const PARENT_MERGE = "e".repeat(40);
const CHILD_HEAD = "f".repeat(40);
const STRAY = "7".repeat(40);
const PARENT_MERGED_AT = 1_000_000;
// 22 seconds later, into the finished parent's branch.
const CHILD_MERGED_AT = PARENT_MERGED_AT + 22_000;

const FOREMAN_ON = { enabled: true, mode: "live", repoAllowlist: ["/repo"] } as unknown as Parameters<typeof stackStandingFor>[2];
const FOREMAN_OFF = { enabled: false, mode: "live", repoAllowlist: ["/repo"] } as unknown as Parameters<typeof stackStandingFor>[2];

function observation(over: Partial<StackObservation> = {}): StackObservation {
  return {
    observedAt: 1, childState: "MERGED", childHeadSha: CHILD_HEAD, baseRefName: "feat/phase-1", defaultBranch: "main",
    parentUrl: PARENT, parentState: "MERGED", parentHeadSha: PARENT_HEAD, parentHeadRefName: "feat/phase-1",
    parentMergeCommitSha: PARENT_MERGE, parentHeadInChild: null, baseBehindBy: null, parentTaskStopped: null,
    parentTaskId: "parent", parentEpisodeId: "ep-parent", retargetError: null,
    childMergeCommitSha: STRAY, childMergedAt: CHILD_MERGED_AT, parentMergedAt: PARENT_MERGED_AT, ...over,
  };
}

// ---- the shared rules ----

test("a merge completes work only when its base is the default branch, and unknown decides nothing", () => {
  assert.equal(mergeLandedOnDefault("main", "main"), true);
  assert.equal(mergeLandedOnDefault("feat/phase-1", "main"), false);
  assert.equal(mergeLandedOnDefault(null, "main"), null);
  assert.equal(mergeLandedOnDefault("main", ""), null);
});

test("a child merged into its parent's branch is Broken, not released; one merged into main is released", () => {
  const stray = observation();
  assert.equal(deriveStackState({ observation: stray, releasedHeadSha: null }), "broken");
  // Even a release recorded for its head does not survive a merge that missed the default branch.
  assert.equal(deriveStackState({ observation: stray, releasedHeadSha: CHILD_HEAD }), "broken");
  assert.equal(stackBrokenReason(stray), "merged-into-parent");
  const landed = observation({ baseRefName: "main" });
  assert.equal(deriveStackState({ observation: landed, releasedHeadSha: null }), "released");
  assert.equal(stackBrokenReason(landed), null);
});

test("the recovery prompt is keyed to the child's own merge commit, and only after the parent merged first", () => {
  assert.deepEqual(stackPromptNeed("broken", observation()), { kind: "recover-merge", tip: STRAY });
  // Merged into a parent that was still open: the parent's later merge may have carried it, so
  // no recovery is offered (the task still stays open; the operator confirms).
  assert.equal(stackPromptNeed("broken", observation({ parentMergedAt: CHILD_MERGED_AT + 1 })), null);
  assert.equal(stackPromptNeed("broken", observation({ parentState: "OPEN", parentMergedAt: null })), null);
  // Undated, unread, or with no merge commit to recover from: nothing is offered on a guess.
  assert.equal(stackPromptNeed("broken", observation({ childMergedAt: null })), null);
  assert.equal(stackPromptNeed("broken", observation({ parentUnreadSince: 5 })), null);
  assert.equal(stackPromptNeed("broken", observation({ childMergeCommitSha: null })), null);
});

test("a child merged into a third branch is Broken, but not offered the parent-branch recovery", () => {
  // Its base was changed by hand to some branch that is neither main nor #1416's, then merged.
  const elsewhere = observation({ baseRefName: "release/2026-11" });
  assert.equal(deriveStackState({ observation: elsewhere, releasedHeadSha: null }), "broken");
  assert.equal(stackBrokenReason(elsewhere), "merged-off-default");
  assert.equal(stackPromptNeed("broken", elsewhere), null);
  assert.equal(stackLifecycleLabel({ state: "broken", parentNumber: 1416, brokenReason: "merged-off-default", retargetError: null, prompt: null }, elsewhere).label,
    "Stack broken: merged into `release/2026-11`, not main");
  // A parent whose branch is not known cannot be told apart from a third branch: no recovery.
  const unknownParent = observation({ parentHeadRefName: null });
  assert.equal(stackBrokenReason(unknownParent), "merged-off-default");
  assert.equal(stackPromptNeed("broken", unknownParent), null);
});

test("a merged child whose base or default branch GitHub did not report is unresolved, not released", () => {
  for (const o of [observation({ baseRefName: null }), observation({ defaultBranch: null }), observation({ baseRefName: null, defaultBranch: null })]) {
    assert.equal(deriveStackState({ observation: o, releasedHeadSha: CHILD_HEAD }), "merge-unconfirmed");
    assert.equal(stackBrokenReason(o), null);
    assert.equal(stackPromptNeed("merge-unconfirmed", o), null);
  }
  const label = stackLifecycleLabel({ state: "merge-unconfirmed", parentNumber: 1416, brokenReason: null, retargetError: null, prompt: null },
    observation({ baseRefName: null }));
  assert.deepEqual(label, { label: "Merged - checking on GitHub whether it reached main", inProgress: true });
});

test("the Broken label names the parent's branch and the default branch, then why the recovery has not gone", () => {
  const o = observation();
  const base = { state: "broken" as const, parentNumber: 1416, brokenReason: "merged-into-parent" as const, retargetError: null };
  assert.equal(stackLifecycleLabel({ ...base, prompt: null }, o).label, "Stack broken: merged into #1416's branch, not main");
  const prompt = { kind: "recover-merge" as const, tip: STRAY };
  assert.equal(stackLifecycleLabel({ ...base, prompt: { ...prompt, status: "foreman-off" } }, o).label,
    "Stack broken: merged into #1416's branch, not main - Recovery needed: Foreman is off");
  assert.equal(stackLifecycleLabel({ ...base, prompt: { ...prompt, status: "no-session" } }, o).label,
    "Stack broken: merged into #1416's branch, not main - Recovery needed: no session");
  assert.equal(stackLifecycleLabel({ ...base, prompt: { ...prompt, status: "sent" } }, o).label,
    "Stack broken: merged into #1416's branch, not main - recovering");
  assert.equal(stackLifecycleLabel({ ...base, prompt: { ...prompt, status: "sent" } }, o).inProgress, false);
});

test("the recovery prompt branches from the default branch, brings over the merge's own diff, and rewrites nothing", () => {
  const text = buildStackPrompt("recover-merge", {
    prNumber: 1417, prUrl: CHILD, headRefName: "feat/phase-2", parentNumber: 1416, parentUrl: PARENT,
    parentHeadRefName: "feat/phase-1", defaultBranch: "main", mergedIntoRefName: "feat/phase-1", mergeCommitSha: STRAY,
  });
  assert.match(text, /merged into `feat\/phase-1` after #1416 \(https:\/\/github\.com\/acme\/repo\/pull\/1416\) had already merged/);
  assert.match(text, /create a new branch from `origin\/main`/);
  assert.match(text, new RegExp(`the diff between merge commit \`${STRAY}\` and its first parent`));
  // The first-parent diff, applied: works for a merge commit and for a one-parent squash commit,
  // where `git cherry-pick -m 1` would refuse.
  assert.ok(text.includes(`git diff --binary ${STRAY}^1 ${STRAY} | git apply --3way`), text);
  assert.match(text, /whether GitHub made a merge commit or a squash commit/);
  assert.doesNotMatch(text, /cherry-pick/);
  assert.match(text, /Resolve any conflicts with main and run focused checks/);
  assert.match(text, /gh pr create --base main/);
  assert.match(text, /This task completes when that pull request merges into main/);
  assert.match(text, /Do NOT force-push, rebase, reset or otherwise rewrite `feat\/phase-2` or `feat\/phase-1`/);
});

// ---- observed from GitHub, against real SQLite ----

interface Gh { refs: Map<string, PrRefs> }

function seam(g: Gh): StackGitHub {
  return {
    prRefs: async (_cwd, url) => {
      const refs = g.refs.get(url);
      return refs ? { ok: true, value: refs } : { ok: false, error: "unreadable" };
    },
    isAncestor: async () => ({ ok: false, error: "unused" }),
    compare: async () => ({ ok: false, error: "unused" }),
    mergeBase: async () => ({ ok: false, error: "unused" }),
    branchSha: async () => ({ ok: false, reason: "unused", outcomeUnknown: false }),
    repositories: async () => [{ owner: "acme", repo: "repo" }],
    primaryRepository: async () => ({ owner: "acme", repo: "repo" }),
    retarget: async () => ({ ok: false, error: "a merged child is never retargeted", outcomeUnknown: false }),
  };
}

const CHILD_TASK: Task = mkTask({
  id: "child", status: "running", repoRoot: "/repo", stackParentTaskId: "parent",
  stackBaseBranch: "feat/phase-1", stackBaseSha: "c".repeat(40), stackPrUrl: PARENT,
});
const PARENT_TASK: Task = mkTask({ id: "parent", status: "done", repoRoot: "/repo" });
const ctx: StackLifecycleContext = {
  getTask: (id) => (id === "child" ? CHILD_TASK : id === "parent" ? PARENT_TASK : undefined),
  workEpisodeForTask: () => null,
  workEpisodeForSession: (sessionId) => (sessionId === "parent-session" ? { episodeId: "ep-parent" } : null),
  taskForSession: () => undefined,
};

function adoptRow(url: string, sessionId: string, adoptedAt: number, headRefName: string): string {
  const number = Number(url.split("/").at(-1));
  const key = `acme/repo#${number}`;
  db.adoptInspectorPr({
    key, url, owner: "acme", repo: "repo", number, repoRoot: "/repo", cwd: "/repo", sessionId, source: "hook",
    state: "open", headSha: null, reviewPosture: null, round: 0, lastReviewedAt: null, lastError: null, failCount: 0,
    lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: null, mergeBlock: null,
    observedHeadSha: null, observedState: null, observedAt: null, headRefName, title: null, adoptedAt, updatedAt: adoptedAt,
  });
  return key;
}

function owner(over: Partial<Session> = {}): Session {
  return mkSession({
    id: "child-session", agentSessionId: "child-conversation", runtime: "sdk", terminals: [], state: "idle",
    hooksSeen: true, stateConfirmed: true, lastActivity: 0, cwd: "/repo", repoRoot: "/repo", gitBranch: "feat/phase-2",
    // The poller records no merge that missed the default branch, so the card still reads open.
    prState: "open", prNumber: 1417, prUrl: CHILD,
    inspector: { prKey: "acme/repo#1417", url: CHILD, mode: "live", open: 0, postedOpen: 0, round: 1, lastReviewedAt: null, failed: false },
    queue: null, note: null, pendingReviews: 0, task: { id: "child" } as Session["task"], ...over,
  });
}

function registryOf(sessions: Session[]) {
  return {
    liveSessions: () => sessions.filter((s) => s.state !== "exited"),
    getSession: (id: string) => sessions.find((s) => s.id === id),
    workflowRunSummaries: () => [],
  };
}

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: "MERGED", headSha: CHILD_HEAD, headRefName: "feat/phase-2", baseRefName: "feat/phase-1", defaultBranch: "main",
    mergeCommitSha: STRAY, mergedAt: CHILD_MERGED_AT, title: "Phase 2", body: "", isDraft: false, threads: [], reviews: [],
    reviewsPageInfo: { hasPreviousPage: false, startCursor: null }, createdAt: 0, mergeable: "UNKNOWN",
    reviewDecision: null, checks: "passing", ...over,
  };
}

/** A child stacked on #1416, observed on the tick GitHub reports it merged into #1416's branch. */
async function strayChild(parentMergedAt = PARENT_MERGED_AT, snap: Partial<PrSnapshot> = {}): Promise<string> {
  adoptRow(PARENT, "parent-session", 1_000, "feat/phase-1");
  const key = adoptRow(CHILD, "child-session", 2_000, "feat/phase-2");
  assert.equal(adoptStackLineage(key, { task: CHILD_TASK, episodeId: "ep-child" }, 2_000), true);
  const g: Gh = { refs: new Map([[PARENT, {
    state: "MERGED", isDraft: false, headSha: PARENT_HEAD, headRefName: "feat/phase-1", baseRefName: "main",
    defaultBranch: "main", mergeCommitSha: PARENT_MERGE, mergedAt: parentMergedAt,
  }]]) };
  await observeStackLifecycle(db.getInspectorPr(key)!, snapshot(snap), "/repo", seam(g), ctx, 30_000);
  // The Inspector tick retires a merged row right after observing it.
  db.updateInspectorPr(key, { state: "closed", observedState: "MERGED" }, 30_000);
  return key;
}

beforeEach(() => {
  db.openDb().exec("DELETE FROM inspector_prs; DELETE FROM stack_prompt_claims;");
});

test("the tick records the stray merge, and the retired row is Broken with the recovery on offer", async () => {
  const key = await strayChild();
  const o = db.getInspectorPr(key)!.stack!.observation!;
  assert.equal(o.childMergeCommitSha, STRAY);
  assert.equal(o.childMergedAt, CHILD_MERGED_AT);
  assert.equal(o.parentMergedAt, PARENT_MERGED_AT);

  // Foreman on and the owner idle: Foreman delivers it on its next settled tick.
  const pending = stackStandingFor(db.getInspectorPr(key)!, [owner()], FOREMAN_ON)!;
  assert.equal(pending.state, "broken");
  assert.equal(pending.brokenReason, "merged-into-parent");
  assert.deepEqual(pending.prompt, { kind: "recover-merge", tip: STRAY, status: "pending" });
  assert.equal(pending.label, "Stack broken: merged into #1416's branch, not main - recovery prompt on its way");
  assert.deepEqual(pending.actions, []);

  // Foreman off: the merge queue offers the send by hand.
  const off = stackStandingFor(db.getInspectorPr(key)!, [owner()], FOREMAN_OFF)!;
  assert.equal(off.prompt?.status, "foreman-off");
  assert.equal(off.label, "Stack broken: merged into #1416's branch, not main - Recovery needed: Foreman is off");

  // No live session: it waits for Resume, as every other stack prompt does.
  assert.equal(stackStandingFor(db.getInspectorPr(key)!, [], FOREMAN_ON)!.label,
    "Stack broken: merged into #1416's branch, not main - Recovery needed: no session");
});

test("a card that no longer carries the pull request leaves only the operator's send", async () => {
  const key = await strayChild();
  const standing = stackStandingFor(db.getInspectorPr(key)!, [owner({ prUrl: null, prState: null, prNumber: null })], FOREMAN_ON)!;
  assert.equal(standing.prompt?.status, "foreman-off");
  assert.equal(standing.prompt?.blocker, "the session's card no longer shows this pull request");
});

test("a child merged into its parent's branch while the parent was still open is Broken with no recovery", async () => {
  const key = await strayChild(CHILD_MERGED_AT + 60_000);
  const standing = stackStandingFor(db.getInspectorPr(key)!, [owner()], FOREMAN_ON)!;
  assert.equal(standing.state, "broken");
  assert.equal(standing.prompt, null);
  assert.equal(standing.label, "Stack broken: merged into #1416's branch, not main");
});

test("the recovery prompt is claimed once, keyed to the pull request and its merge commit", async () => {
  const key = await strayChild();
  const sessions = [owner()];
  const request = { prKey: key, kind: "recover-merge" as const, tip: STRAY };
  const candidate = stackPromptCandidate(registryOf(sessions), "child-session", request, "foreman", db.getInspectorPr(key)!, FOREMAN_ON, false, 10_000_000);
  assert.equal(candidate.error, undefined, candidate.error);
  if (candidate.error !== undefined) return;
  assert.deepEqual(candidate.claim, { kind: "recover-merge", tip: STRAY });
  assert.ok(candidate.payload.includes(`git diff --binary ${STRAY}^1 ${STRAY} | git apply --3way`));
  assert.match(candidate.payload, /merged into `feat\/phase-1` after #1416/);

  const claim = db.claimStackPrompt(key, "recover-merge", STRAY, "child-session", 1);
  assert.ok(claim, "the first claim is taken");
  assert.equal(db.claimStackPrompt(key, "recover-merge", STRAY, "child-session", 2), null, "never claimed twice");
  db.finishStackPrompt(claim!, "delivered", 3);
  const sent = stackStandingFor(db.getInspectorPr(key)!, sessions, FOREMAN_ON)!;
  assert.equal(sent.prompt?.status, "sent");
  assert.equal(sent.label, "Stack broken: merged into #1416's branch, not main - recovering");
  const again = stackPromptCandidate(registryOf(sessions), "child-session", request, "foreman", db.getInspectorPr(key)!, FOREMAN_ON, false, 10_000_000);
  assert.equal(again.error, "That stack prompt was already delivered");
});

test("once the recovery pull request is adopted, the stray row reads Replaced by it and offers nothing", async () => {
  const key = await strayChild();
  const recovery = adoptRow(RECOVERY, "child-session", 40_000, "feat/phase-2-recovery");
  // The recovery is opened from a new branch, so it is adopted in the task's NEXT work episode.
  assert.equal(adoptStackLineage(recovery, { task: CHILD_TASK, episodeId: "ep-child-recovery" }, 40_000), true);
  const standing = stackStandingFor(db.getInspectorPr(key)!, [owner()], FOREMAN_ON)!;
  assert.equal(standing.label, "Replaced by #1456");
  assert.equal(standing.prompt, null);
});

test("a merged child whose base was not reported is read again until it is, then resolves", async () => {
  const key = await strayChild(PARENT_MERGED_AT, { baseRefName: "" });
  assert.equal(db.getInspectorPr(key)!.stack!.observation!.baseRefName, null);
  assert.equal(stackStandingFor(db.getInspectorPr(key)!, [owner()], FOREMAN_ON)!.state, "merge-unconfirmed");
  assert.equal(stackStandingFor(db.getInspectorPr(key)!, [owner()], FOREMAN_ON)!.prompt, null);

  // The closed-children sweep reads the child again; this time GitHub names its base.
  const g: Gh = { refs: new Map([
    [PARENT, { state: "MERGED", isDraft: false, headSha: PARENT_HEAD, headRefName: "feat/phase-1", baseRefName: "main",
      defaultBranch: "main", mergeCommitSha: PARENT_MERGE, mergedAt: PARENT_MERGED_AT }],
    [CHILD, { state: "MERGED", isDraft: false, headSha: CHILD_HEAD, headRefName: "feat/phase-2", baseRefName: "feat/phase-1",
      defaultBranch: "main", mergeCommitSha: STRAY, mergedAt: CHILD_MERGED_AT }],
  ]) };
  await observeClosedStackChildren(seam(g), ctx, () => "/repo", 40_000);
  const standing = stackStandingFor(db.getInspectorPr(key)!, [owner()], FOREMAN_ON)!;
  assert.equal(standing.state, "broken");
  assert.equal(standing.brokenReason, "merged-into-parent");
  assert.deepEqual(standing.prompt, { kind: "recover-merge", tip: STRAY, status: "pending" });

  // Resolved: the sweep stops reading it.
  const reads: string[] = [];
  const counting: StackGitHub = { ...seam(g), prRefs: async (cwd, url) => (reads.push(url), seam(g).prRefs(cwd, url)) };
  await observeClosedStackChildren(counting, ctx, () => "/repo", 50_000);
  assert.deepEqual(reads, []);
});
