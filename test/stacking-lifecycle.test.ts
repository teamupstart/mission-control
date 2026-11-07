import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import type { Session, Task } from "../src/shared/types.ts";
import type { WorkflowRunSummary } from "../src/shared/workflow.ts";
import type { PrRefs, PrSnapshot } from "../src/server/inspector/github.ts";
import type { StackGitHub } from "../src/server/stacking/github.ts";
import type { StackLifecycleContext } from "../src/server/stacking/state.ts";

// The stack lifecycle against real SQLite and a scripted GitHub: what the Inspector tick
// observes and records, base reconciliation, the replacement-parent transition, the prompt
// claims, the standing the merge queue reads, and the delivery guards.

const home = mkdtempSync(join(tmpdir(), "mission-stacking-lifecycle-"));
process.env.HARNESS_HOME = home;
const db = await import("../src/server/db.ts");
const { recordStackObservation } = db;
const { observeClosedStackChildren, observeStackLifecycle } = await import("../src/server/stacking/state.ts");
const { recheckStackParent, stackPromptCandidate, stackStandingFor } = await import("../src/server/stacking/delivery.ts");
const { adoptStackLineage, refreshStackRelease } = await import("../src/server/stacking/lineage.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const P1 = "https://github.com/acme/repo/pull/7";
const P2 = "https://github.com/acme/repo/pull/8";
const CUT = "c".repeat(40);
const P1_HEAD = "d".repeat(40);
const P1_HEAD_2 = "1".repeat(40);
const P2_HEAD = "2".repeat(40);
const MERGE = "e".repeat(40);
const P2_MERGE = "3".repeat(40);
const CHILD_HEAD = "f".repeat(40);
const CHILD_PUSHED = "4".repeat(40);
const RESTACKED = "5".repeat(40);

let nextNumber = 100;

interface Gh {
  refs: Map<string, PrRefs>;
  /** `${base}..${head}` -> is base in head. Absent = GitHub could not answer. */
  ancestry: Map<string, boolean>;
  compares: string[];
  retargets: { number: number; base: string }[];
  refuseRetarget: string | null;
}

function gh(): Gh {
  return { refs: new Map(), ancestry: new Map(), compares: [], retargets: [], refuseRetarget: null };
}

function seam(g: Gh): StackGitHub {
  const ancestry = (base: string, head: string) => g.ancestry.get(`${base}..${head}`);
  return {
    prRefs: async (_cwd, url) => {
      const refs = g.refs.get(url);
      return refs ? { ok: true, value: refs } : { ok: false, error: "unreadable" };
    },
    isAncestor: async (_cwd, _o, _r, base, head) => {
      const answer = ancestry(base, head);
      return answer === undefined ? { ok: false, error: "compare failed" } : { ok: true, value: answer };
    },
    compare: async (_cwd, _o, _r, base, head) => {
      g.compares.push(`${base}..${head}`);
      const answer = ancestry(base, head);
      return answer === undefined ? { ok: false, error: "compare failed" } : { ok: true, value: { contains: answer, behindBy: answer ? 0 : 2 } };
    },
    mergeBase: async () => ({ ok: false, error: "unused" }),
    branchSha: async () => ({ ok: false, reason: "unused", outcomeUnknown: false }),
    repositories: async () => [{ owner: "acme", repo: "repo" }],
    primaryRepository: async () => ({ owner: "acme", repo: "repo" }),
    retarget: async (_cwd, _o, _r, number, base) => {
      g.retargets.push({ number, base });
      return g.refuseRetarget
        ? { ok: false, error: `gh api (retarget pull request) failed (exit 1): ${g.refuseRetarget}`, outcomeUnknown: false }
        : { ok: true };
    },
  };
}

function refs(over: Partial<PrRefs> = {}): PrRefs {
  return { state: "OPEN", isDraft: false, headSha: P1_HEAD, headRefName: "feat/parent", baseRefName: "main",
    defaultBranch: "main", mergeCommitSha: null, ...over };
}

function snapshot(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: "OPEN", headSha: CHILD_HEAD, headRefName: "feat/child", baseRefName: "feat/parent", defaultBranch: "main",
    mergeCommitSha: null, title: "child", body: "", isDraft: false, threads: [], reviews: [],
    reviewsPageInfo: { hasPreviousPage: false, startCursor: null }, createdAt: 0, mergeable: "MERGEABLE",
    reviewDecision: null, checks: "passing", ...over,
  };
}

function adoptRow(url: string, sessionId: string, adoptedAt: number): string {
  const number = Number(url.split("/").at(-1));
  const key = `acme/repo#${number}`;
  db.adoptInspectorPr({
    key, url, owner: "acme", repo: "repo", number, repoRoot: "/repo", cwd: "/repo", sessionId, source: "hook",
    state: "open", headSha: null, reviewPosture: null, round: 0, lastReviewedAt: null, lastError: null, failCount: 0,
    lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: null, mergeBlock: null,
    observedHeadSha: null, observedState: null, observedAt: null, headRefName: url === P1 || url === P2 ? null : "feat/child",
    title: null, adoptedAt, updatedAt: adoptedAt,
  });
  return key;
}

const CHILD_TASK: Task = mkTask({
  id: "child", status: "running", repoRoot: "/repo", stackParentTaskId: "parent",
  stackBaseBranch: "feat/parent", stackBaseSha: CUT, stackPrUrl: P1,
});
let parentTask: Task = mkTask({ id: "parent", status: "running", repoRoot: "/repo" });
let parentEpisode = "ep-parent";

const ctx: StackLifecycleContext = {
  getTask: (id) => (id === "child" ? CHILD_TASK : id === "parent" ? parentTask : undefined),
  workEpisodeForTask: (id) => (id === "parent" ? { episodeId: parentEpisode, prUrl: P1 } : null),
  workEpisodeForSession: (sessionId) => (sessionId.startsWith("parent-") ? { episodeId: sessionId.slice("parent-".length) } : null),
  taskForSession: (sessionId) => (sessionId.startsWith("parent-") ? parentTask : sessionId.startsWith("child") ? CHILD_TASK : undefined),
};

/** A stacked child row, seeded from the task's dispatch, with parent P1 adopted from the parent session. */
function stackedChild(adoptedAt = 2_000): string {
  adoptRow(P1, "parent-ep-parent", 1_000);
  nextNumber += 1;
  const key = adoptRow(`https://github.com/acme/repo/pull/${nextNumber}`, "child-session", adoptedAt);
  assert.equal(adoptStackLineage(key, { task: CHILD_TASK, episodeId: "ep-child" }, adoptedAt), true);
  return key;
}

const row = (key: string) => db.getInspectorPr(key)!;
const observe = (key: string, g: Gh, snap: Partial<PrSnapshot> = {}, now = 10_000) =>
  observeStackLifecycle(row(key), snapshot(snap), "/repo", seam(g), ctx, now);

const FOREMAN_ON = { enabled: true, mode: "live", repoAllowlist: ["/repo"] } as unknown as Parameters<typeof stackStandingFor>[2];
const FOREMAN_OFF = { enabled: false, mode: "live", repoAllowlist: ["/repo"] } as unknown as Parameters<typeof stackStandingFor>[2];

function owner(over: Partial<Session> = {}): Session {
  return mkSession({
    id: "child-session", agentSessionId: "child-conversation", runtime: "sdk", terminals: [], state: "idle",
    hooksSeen: true, stateConfirmed: true, lastActivity: 0, cwd: "/repo", repoRoot: "/repo", gitBranch: "feat/child",
    prState: "open", prNumber: nextNumber, prUrl: `https://github.com/acme/repo/pull/${nextNumber}`,
    inspector: { prKey: `acme/repo#${nextNumber}`, url: `https://github.com/acme/repo/pull/${nextNumber}`, mode: "live",
      open: 0, postedOpen: 0, round: 1, lastReviewedAt: null, failed: false },
    queue: null, note: null, pendingReviews: 0, task: { id: "child" } as Session["task"], ...over,
  });
}

function registryOf(sessions: Session[], runs: WorkflowRunSummary[] = []) {
  return {
    liveSessions: () => sessions.filter((s) => s.state !== "exited"),
    getSession: (id: string) => sessions.find((s) => s.id === id),
    workflowRunSummaries: () => runs,
  };
}

beforeEach(() => {
  db.openDb().exec("DELETE FROM inspector_prs; DELETE FROM stack_prompt_claims;");
  parentTask = mkTask({ id: "parent", status: "running", repoRoot: "/repo" });
  parentEpisode = "ep-parent";
  setShippingConfig({ stacking: "stack" });
});

// ---- observation and derivation ----

test("a parent that pushed past the child reads parent-moved, with the behind-by count, and a quiet pair is not re-asked", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  await observe(key, g);
  assert.equal(stackStandingFor(row(key), [], FOREMAN_ON)!.state, "current");
  await observe(key, g);
  assert.equal(g.compares.length, 1, "an unchanged (parent head, child head) pair reuses the last answer");
  g.refs.set(P1, refs({ headSha: P1_HEAD_2 }));
  g.ancestry.set(`${P1_HEAD_2}..${CHILD_HEAD}`, false);
  const o = await observe(key, g);
  assert.equal(o!.baseBehindBy, 2);
  const standing = stackStandingFor(row(key), [], FOREMAN_ON)!;
  assert.equal(standing.state, "parent-moved");
  assert.deepEqual(standing.prompt, { kind: "catch-up", tip: P1_HEAD_2, status: "no-session" });
  assert.equal(standing.label, "Catch-up needed: no session");
});

test("lineage rows derive with the Shipping setting off and no session", async () => {
  setShippingConfig({ stacking: "merge" });
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  await observe(key, g, { baseRefName: "main" });
  const standing = stackStandingFor(row(key), [], FOREMAN_ON)!;
  assert.equal(standing.state, "restack-needed");
  assert.equal(standing.label, "Restack needed: no session");
});

test("retarget on parent merge is idempotent, including when GitHub already retargeted", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  // GitHub retargeted it itself after deleting the parent's branch: nothing to do.
  await observe(key, g, { baseRefName: "main" });
  assert.deepEqual(g.retargets, []);
  // Still on the parent's branch: retargeted once, to the default branch, and noted.
  await observe(key, g, { baseRefName: "feat/parent" });
  assert.deepEqual(g.retargets, [{ number: nextNumber, base: "main" }]);
  assert.equal(row(key).stack!.note, "base moved from feat/parent to main");
  assert.equal(row(key).stack!.observation!.baseRefName, "main");
  assert.equal(stackStandingFor(row(key), [], FOREMAN_ON)!.state, "restack-needed");
  // The next tick sees the edit applied and asks for nothing.
  await observe(key, g, { baseRefName: "main" });
  assert.equal(g.retargets.length, 1);
  // A snapshot read before an edit landed is checked against GitHub again before any write.
  g.refs.set(row(key).url, refs({ headSha: CHILD_HEAD, headRefName: "feat/child", baseRefName: "main" }));
  await observe(key, g, { baseRefName: "feat/parent" });
  assert.equal(g.retargets.length, 1, "already on main: no second edit");
  assert.equal(row(key).stack!.observation!.baseRefName, "main");
});

test("a refused retarget shows its reason and is applied on a later tick", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  g.refuseRetarget = "HTTP 422: Validation Failed";
  await observe(key, g);
  let standing = stackStandingFor(row(key), [], FOREMAN_ON)!;
  assert.equal(standing.label, "Retarget failed: HTTP 422: Validation Failed");
  assert.equal(standing.state, "parent-merged-needs-retarget");
  g.refuseRetarget = null;
  await observe(key, g, {}, 11_000);
  standing = stackStandingFor(row(key), [], FOREMAN_ON)!;
  assert.equal(standing.retargetError, null);
  assert.equal(standing.state, "restack-needed");
  assert.equal(g.retargets.length, 2);
});

test("a closed parent breaks the stack, the child keeps the stack-hold gate value, and both actions are offered", async () => {
  const key = stackedChild();
  db.updateInspectorPr(key, { mergeBlock: "stack-hold" }, 1);
  const g = gh();
  g.refs.set(P1, refs({ state: "CLOSED" }));
  await observe(key, g, { baseRefName: "main" });
  const standing = stackStandingFor(row(key), [owner()], FOREMAN_ON)!;
  assert.equal(standing.state, "broken");
  assert.equal(standing.label, "Stack broken: #7 closed");
  assert.deepEqual(standing.actions, ["move-onto-main", "await-replacement"]);
  assert.equal(row(key).mergeBlock, "stack-hold", "the lifecycle never writes the gate value");
  // A rescheduled or cancelled parent task while its pull request is open: broken too.
  const other = stackedChild(3_000);
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  parentTask = { ...parentTask, status: "cancelled" };
  await observe(other, g);
  let stopped = stackStandingFor(row(other), [], FOREMAN_ON)!;
  assert.equal(stopped.label, "Stack broken: #7's task was cancelled");
  assert.deepEqual(stopped.actions, ["reschedule-parent"], "the action that fixes it: restart the parent's work");
  assert.equal(stopped.parentTaskId, "parent");
  // Rescheduled: back in the backlog, not started yet - the action is to start it.
  parentTask = { ...parentTask, status: "backlog" };
  await observe(other, g);
  stopped = stackStandingFor(row(other), [], FOREMAN_ON)!;
  assert.equal(stopped.label, "Stack broken: #7's task was rescheduled");
  assert.deepEqual(stopped.actions, ["start-parent"]);
  // Started again, in a new episode: working on its open pull request, so not broken.
  parentTask = { ...parentTask, status: "running" };
  parentEpisode = "ep-parent-2";
  await observe(other, g);
  assert.equal(stackStandingFor(row(other), [], FOREMAN_ON)!.state, "current");
});

// ---- the replacement-parent transition ----

test("the replacement-parent transition: opt-in, same episode, appends history, keeps the cut, clears the release, idempotent", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  await observe(key, g, {}, 5_000); // records the parent's episode while it is open
  // A release recorded for an earlier head, under the old parent.
  db.releaseInspectorPrStack(key, CHILD_PUSHED, "closed", 5_000);
  g.refs.set(P1, refs({ state: "CLOSED" }));
  // A replacement opened by the parent task's session, in the same episode.
  adoptRow(P2, "parent-ep-parent", 6_000);
  g.refs.set(P2, refs({ headSha: P2_HEAD, headRefName: "feat/parent-v2" }));
  g.ancestry.set(`${P2_HEAD}..${CHILD_HEAD}`, false);

  // Not without the operator's choice.
  await observe(key, g, { baseRefName: "main" }, 7_000);
  assert.equal(row(key).stack!.parentPrUrl, P1);
  // And never for a child already released off its closed parent.
  db.setStackAwaitReplacement(key, 7_000, 7_000);
  db.releaseInspectorPrStack(key, CHILD_HEAD, "closed", 7_000);
  await observe(key, g, { baseRefName: "main" }, 7_000);
  db.releaseInspectorPrStack(key, CHILD_PUSHED, "closed", 7_000);
  assert.equal(row(key).stack!.parentPrUrl, P1);
  assert.ok(db.setStackAwaitReplacement(key, 7_000, 7_000));
  assert.equal(stackStandingFor(row(key), [], FOREMAN_ON)!.label, "Stack broken: #7 closed - waiting for a replacement");

  await observe(key, g, { baseRefName: "main" }, 8_000);
  const lineage = row(key).stack!;
  assert.equal(lineage.parentPrUrl, P2);
  assert.deepEqual(lineage.history, [{ from: P1, to: P2, at: 8_000 }]);
  assert.equal(lineage.baseSha, CUT, "the commit the child was cut at never changes");
  assert.equal(lineage.releasedHeadSha, null, "a release verified against the old parent is cleared");
  // Retargeted onto the replacement's branch and caught up with it.
  assert.deepEqual(g.retargets.at(-1), { number: nextNumber, base: "feat/parent-v2" });
  const standing = stackStandingFor(row(key), [], FOREMAN_ON)!;
  assert.equal(standing.state, "parent-moved");
  assert.deepEqual(standing.prompt?.kind, "catch-up");
  assert.equal(standing.prompt?.tip, P2_HEAD);
  // Idempotent: the same replacement again changes nothing.
  assert.equal(db.transitionStackParent(key, P1, P2, 9_000), false);
  await observe(key, g, { baseRefName: "feat/parent-v2" }, 9_000);
  assert.equal(row(key).stack!.history.length, 1);
});

test("the transition never takes a replacement from another episode, and never moves a closed child", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  await observe(key, g, {}, 5_000);
  g.refs.set(P1, refs({ state: "CLOSED" }));
  db.setStackAwaitReplacement(key, 6_000, 6_000);
  // The parent task was rescheduled: its new episode's pull request is not a replacement.
  adoptRow(P2, "parent-ep-later", 6_000);
  g.refs.set(P2, refs({ headSha: P2_HEAD, headRefName: "feat/parent-v2" }));
  await observe(key, g, { baseRefName: "main" }, 7_000);
  assert.equal(row(key).stack!.parentPrUrl, P1);
  // Same episode, but the child itself is closed: there is nothing to retarget.
  db.openDb().prepare("UPDATE inspector_prs SET session_id = 'parent-ep-parent' WHERE key = 'acme/repo#8'").run();
  await observe(key, g, { state: "CLOSED", baseRefName: "feat/parent" }, 8_000);
  assert.equal(row(key).stack!.parentPrUrl, P1);
});

test("a replacement that merges releases the child after its restack; one that closes returns it to broken", async () => {
  const key = stackedChild();
  const g = gh();
  db.openDb().prepare("UPDATE inspector_prs SET stack_parent_pr_url = ? WHERE key = ?").run(P2, key);
  // The replacement merged.
  g.refs.set(P2, refs({ state: "MERGED", headSha: P2_HEAD, mergeCommitSha: P2_MERGE }));
  await observe(key, g, { baseRefName: "main" });
  assert.deepEqual(stackStandingFor(row(key), [], FOREMAN_ON)!.prompt?.tip, P2_MERGE);
  // The session merged origin/main in and pushed: the replacement's merge commit is in its head.
  g.ancestry.set(`${P2_MERGE}..${RESTACKED}`, true);
  assert.equal(await refreshStackRelease(row(key), snapshot({ headSha: RESTACKED, baseRefName: "main" }), "/repo", seam(g), 12_000), true);
  await observe(key, g, { headSha: RESTACKED, baseRefName: "main" }, 12_000);
  assert.equal(stackStandingFor(row(key), [], FOREMAN_ON)!.state, "released");
  assert.equal(stackStandingFor(row(key), [], FOREMAN_ON)!.label, null);

  const other = stackedChild(3_000);
  db.openDb().prepare("UPDATE inspector_prs SET stack_parent_pr_url = ? WHERE key = ?").run(P2, other);
  g.refs.set(P2, refs({ state: "CLOSED", headSha: P2_HEAD }));
  await observe(other, g, { baseRefName: "main" });
  assert.equal(stackStandingFor(row(other), [], FOREMAN_ON)!.state, "broken");
});

test("sequence: P1 closes, P2 takes over, P2 closes, Move onto main - the new child inherits P2 and is released only by the closed-parent check", async () => {
  const first = stackedChild();
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  await observe(first, g, {}, 5_000);
  g.refs.set(P1, refs({ state: "CLOSED" }));
  db.setStackAwaitReplacement(first, 5_500, 5_500);
  adoptRow(P2, "parent-ep-parent", 6_000);
  g.refs.set(P2, refs({ headSha: P2_HEAD, headRefName: "feat/parent-v2" }));
  g.ancestry.set(`${P2_HEAD}..${CHILD_HEAD}`, true);
  await observe(first, g, { baseRefName: "main" }, 7_000);
  assert.equal(row(first).stack!.parentPrUrl, P2);
  // P2 closes too. The session runs Move onto main: a new pull request on main, the old one closed.
  g.refs.set(P2, refs({ state: "CLOSED", headSha: P2_HEAD, headRefName: "feat/parent-v2" }));
  await observe(first, g, { baseRefName: "feat/parent-v2" }, 8_000);
  assert.deepEqual(stackStandingFor(row(first), [owner()], FOREMAN_ON)!.actions, ["move-onto-main", "await-replacement"]);
  await observe(first, g, { state: "CLOSED", baseRefName: "main" }, 8_500);
  db.updateInspectorPr(first, { state: "closed" }, 8_500);
  nextNumber += 1;
  const moved = adoptRow(`https://github.com/acme/repo/pull/${nextNumber}`, "child-session", 9_000);
  adoptStackLineage(moved, { task: CHILD_TASK, episodeId: "ep-child" }, 9_000);
  const lineage = row(moved).stack!;
  assert.equal(lineage.parentPrUrl, P2);
  assert.equal(lineage.baseSha, CUT);
  assert.deepEqual(lineage.history, [{ from: P1, to: P2, at: 7_000 }], "exactly one history entry");
  // It stays on the default branch: the expected base of a closed parent is the default branch.
  g.retargets.length = 0;
  await observe(moved, g, { headSha: RESTACKED, baseRefName: "main" }, 9_500);
  assert.deepEqual(g.retargets, []);
  // The old row is history now: it names its replacement and offers nothing.
  const old = stackStandingFor(row(first), [owner()], FOREMAN_ON)!;
  assert.equal(old.label, `Replaced by #${nextNumber}`);
  assert.deepEqual(old.actions, []);
  // Released only by the closed-parent check against P2 and the stack base.
  g.ancestry.set(`${CUT}..${RESTACKED}`, true);
  g.ancestry.set(`${P2_HEAD}..${RESTACKED}`, false);
  assert.equal(await refreshStackRelease(row(moved), snapshot({ headSha: RESTACKED, baseRefName: "main" }), "/repo", seam(g), 10_000), false,
    "still carries the commit it was cut at");
  g.ancestry.set(`${CUT}..${RESTACKED}`, false);
  assert.equal(await refreshStackRelease(row(moved), snapshot({ headSha: RESTACKED, baseRefName: "main" }), "/repo", seam(g), 10_000), true);
});

test("a child closed by base deletion: Reopen against main after a merged parent, only Move onto main after a closed one", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  await observe(key, g, { state: "CLOSED", baseRefName: "feat/parent" });
  db.updateInspectorPr(key, { state: "closed" }, 1);
  assert.deepEqual(g.retargets, [], "a closed pull request is never retargeted");
  let standing = stackStandingFor(row(key), [owner({ prState: null, prUrl: null })], FOREMAN_ON)!;
  assert.equal(standing.label, "Stack broken: GitHub closed this pull request after #7 merged");
  assert.deepEqual(standing.actions, ["reopen-against-main"]);
  // The reopened pull request inherits the lineage and restacks as usual.
  nextNumber += 1;
  const reopened = adoptRow(`https://github.com/acme/repo/pull/${nextNumber}`, "child-session", 4_000);
  adoptStackLineage(reopened, { task: CHILD_TASK, episodeId: "ep-child" }, 4_000);
  assert.equal(row(reopened).stack!.parentPrUrl, P1);
  await observe(reopened, g, { baseRefName: "main" });
  assert.equal(stackStandingFor(row(reopened), [], FOREMAN_ON)!.state, "restack-needed");
  g.ancestry.set(`${MERGE}..${RESTACKED}`, true);
  assert.equal(await refreshStackRelease(row(reopened), snapshot({ headSha: RESTACKED, baseRefName: "main" }), "/repo", seam(g), 5_000), true);

  const other = stackedChild(6_000);
  g.refs.set(P1, refs({ state: "CLOSED" }));
  await observe(other, g, { state: "CLOSED", baseRefName: "feat/parent" });
  db.updateInspectorPr(other, { state: "closed" }, 1);
  standing = stackStandingFor(row(other), [], FOREMAN_ON)!;
  assert.deepEqual(standing.actions, ["move-onto-main"], "never Wait for a replacement for a closed child");
});

// ---- prompts: claims, standing and delivery guards ----

async function restackNeeded(): Promise<string> {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  await observe(key, g, { baseRefName: "main" });
  return key;
}

test("the claim lifecycle: one prompt per tip across ticks and restarts, re-armed only by a new tip or a confirmed non-delivery", async () => {
  const key = await restackNeeded();
  const first = db.claimStackPrompt(key, "restack", MERGE, "child-session", 1);
  assert.ok(first);
  assert.equal(db.claimStackPrompt(key, "restack", MERGE, "child-session", 2), null, "never twice");
  db.finishStackPrompt(first!, "delivered", 3);
  // A "restart" is the same rows read again; a push to the child does not change the key.
  db.closeDb();
  assert.equal(db.claimStackPrompt(key, "restack", MERGE, "child-session", 4), null);
  assert.equal(db.readStackPromptClaim(key, "restack", MERGE)?.outcome, "delivered");
  // A different parent merge commit is a new key.
  assert.ok(db.claimStackPrompt(key, "restack", P2_MERGE, "child-session", 5));
  // A confirmed non-delivery releases the claim; an unconfirmed one stays.
  const refused = db.claimStackPrompt(key, "catch-up", P1_HEAD_2, "child-session", 6)!;
  db.finishStackPrompt(refused, "refused", 7);
  assert.equal(db.readStackPromptClaim(key, "catch-up", P1_HEAD_2), null);
  assert.ok(db.claimStackPrompt(key, "catch-up", P1_HEAD_2, "child-session", 8));
  // The operator's re-arm takes only an UNCERTAIN claim, never a delivered one.
  assert.ok(db.claimStackPrompt(key, "catch-up", P1_HEAD_2, "child-session", 9, true));
  assert.equal(db.claimStackPrompt(key, "restack", MERGE, "child-session", 10, true), null);
});

test("an unrelated child push in the same state sends nothing new; a new parent tip re-arms the catch-up", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs({ headSha: P1_HEAD_2 }));
  g.ancestry.set(`${P1_HEAD_2}..${CHILD_HEAD}`, false);
  g.ancestry.set(`${P1_HEAD_2}..${CHILD_PUSHED}`, false);
  await observe(key, g);
  const sessions = [owner()];
  assert.equal(stackStandingFor(row(key), sessions, FOREMAN_ON)!.prompt?.status, "pending");
  const claim = db.claimStackPrompt(key, "catch-up", P1_HEAD_2, "child-session", 1)!;
  db.finishStackPrompt(claim, "delivered", 2);
  await observe(key, g, { headSha: CHILD_PUSHED });
  let standing = stackStandingFor(row(key), sessions, FOREMAN_ON)!;
  assert.deepEqual(standing.prompt, { kind: "catch-up", tip: P1_HEAD_2, status: "sent" });
  assert.equal(standing.label, "Catching up with #7");
  g.refs.set(P1, refs({ headSha: P2_HEAD }));
  g.ancestry.set(`${P2_HEAD}..${CHILD_PUSHED}`, false);
  await observe(key, g, { headSha: CHILD_PUSHED });
  standing = stackStandingFor(row(key), sessions, FOREMAN_ON)!;
  assert.deepEqual(standing.prompt, { kind: "catch-up", tip: P2_HEAD, status: "pending" });
});

test("a crash between claim and inject, for each kind: uncertain, never resent by Foreman, and the manual send re-arms it once", async () => {
  for (const kind of ["catch-up", "restack"] as const) {
    db.openDb().exec("DELETE FROM inspector_prs; DELETE FROM stack_prompt_claims;");
    const key = stackedChild();
    const g = gh();
    if (kind === "restack") g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
    else {
      g.refs.set(P1, refs({ headSha: P1_HEAD_2 }));
      g.ancestry.set(`${P1_HEAD_2}..${CHILD_HEAD}`, false);
    }
    await observe(key, g, { baseRefName: kind === "restack" ? "main" : "feat/parent" });
    const tip = kind === "restack" ? MERGE : P1_HEAD_2;
    const session = owner();
    const registry = registryOf([session]);
    // The claim was stored, then the daemon died before the inject confirmed.
    assert.ok(db.claimStackPrompt(key, kind, tip, session.id, 1));
    const standing = stackStandingFor(row(key), [session], FOREMAN_ON)!;
    assert.equal(standing.label, kind === "restack" ? "Restack prompt delivery uncertain" : "Catch-up prompt delivery uncertain");
    const request = { prKey: key, kind, tip };
    const auto = stackPromptCandidate(registry, session.id, request, "foreman", row(key), FOREMAN_ON);
    assert.ok(auto.error, "Foreman never retries an uncertain delivery");
    const manual = stackPromptCandidate(registry, session.id, request, "human", row(key), FOREMAN_ON);
    assert.equal(manual.error, undefined);
    const rearmed = db.claimStackPrompt(key, kind, tip, session.id, 2, true)!;
    db.finishStackPrompt(rearmed, "delivered", 3);
    assert.ok(stackPromptCandidate(registry, session.id, request, "human", row(key), FOREMAN_ON).error, "exactly once");
    assert.equal(db.claimStackPrompt(key, kind, tip, session.id, 4, true), null);
  }
});

test("delivery guards: a busy session, queued turns, a work queue, an active workflow, an absent session, Foreman off", async () => {
  const key = await restackNeeded();
  const request = { prKey: key, kind: "restack" as const, tip: MERGE };
  const check = (session: Session, origin: "foreman" | "human", runs: WorkflowRunSummary[] = [], foreman = FOREMAN_ON) =>
    stackPromptCandidate(registryOf([session], runs), session.id, request, origin, row(key), foreman).error ?? null;
  assert.equal(check(owner(), "foreman"), null);
  assert.equal(check(owner(), "human"), null);
  assert.match(check(owner({ state: "working" }), "foreman")!, /still working/);
  assert.match(check(owner({ state: "working" }), "human")!, /still working/);
  assert.match(check(owner({ pendingTurns: [{ id: "t" } as Session["pendingTurns"][number]] }), "foreman")!, /Queued conversation turns/);
  assert.match(check(owner({ queue: { openCount: 1 } as Session["queue"] }), "human")!, /work queue/);
  const run = { id: "run", status: "running", sessionId: "child-session" } as unknown as WorkflowRunSummary;
  assert.match(check(owner(), "foreman", [run])!, /active workflow/);
  assert.match(check(owner({ foremanInvite: null }), "foreman")!, /not Foreman.s to send/, "a session Foreman was not invited into");
  // Foreman off: Foreman sends nothing, and the merge queue offers the manual send.
  assert.ok(check(owner(), "foreman", [], FOREMAN_OFF));
  assert.equal(stackStandingFor(row(key), [owner()], FOREMAN_OFF)!.label, "Restack needed: Foreman is off");
  assert.equal(stackStandingFor(row(key), [owner({ foremanInvite: null })], FOREMAN_ON)!.label,
    "Restack needed: Foreman can't send it - Foreman is not invited into this session");
  assert.equal(check(owner(), "human", [], FOREMAN_OFF), null);
  // No live session: nothing is sent, by anyone.
  const absent = stackPromptCandidate(registryOf([]), "child-session", request, "human", row(key), FOREMAN_ON);
  assert.ok(absent.error);
  // A broken-stack action is the operator's, never Foreman's.
  assert.ok(stackPromptCandidate(registryOf([owner()]), "child-session", { prKey: key, kind: "move-onto-main", tip: null }, "human", row(key), FOREMAN_ON).error,
    "not offered for a restack-needed child");
});

test("Resume recovery: with no session the row says so and nothing is sent; the resumed session gets it exactly once", async () => {
  const key = await restackNeeded();
  const request = { prKey: key, kind: "restack" as const, tip: MERGE };
  assert.equal(stackStandingFor(row(key), [], FOREMAN_ON)!.label, "Restack needed: no session");
  assert.ok(stackPromptCandidate(registryOf([]), "child-session", request, "foreman", row(key), FOREMAN_ON).error);
  // Resumed: a NEW session running the same task owns it, on its first idle tick.
  const resumed = owner({ id: "child-resumed", agentSessionId: "child-resumed-conversation" });
  const standing = stackStandingFor(row(key), [resumed], FOREMAN_ON)!;
  assert.equal(standing.sessionId, "child-resumed");
  assert.equal(standing.prompt?.status, "pending");
  const candidate = stackPromptCandidate(registryOf([resumed]), resumed.id, request, "foreman", row(key), FOREMAN_ON);
  assert.equal(candidate.error, undefined);
  const claim = db.claimStackPrompt(key, "restack", MERGE, resumed.id, 1)!;
  db.finishStackPrompt(claim, "delivered", 2);
  assert.ok(stackPromptCandidate(registryOf([resumed]), resumed.id, request, "foreman", row(key), FOREMAN_ON).error);
});

test("prompts still go out for an already-stacked child after the Shipping default is switched off", async () => {
  const key = await restackNeeded();
  setShippingConfig({ stacking: "merge" });
  const standing = stackStandingFor(row(key), [owner()], FOREMAN_ON)!;
  assert.equal(standing.prompt?.status, "pending");
  const candidate = stackPromptCandidate(registryOf([owner()]), "child-session", { prKey: key, kind: "restack", tip: MERGE }, "foreman", row(key), FOREMAN_ON);
  assert.equal(candidate.error, undefined);
  assert.match((candidate as { payload: string }).payload, /merge `origin\/main` into `feat\/child`/);
});

// ---- failed GitHub reads during observation ----

test("an unreadable parent decides nothing: last facts kept for display, no retarget, no prompt until a read succeeds", async () => {
  const key = stackedChild();
  const g = gh();
  // A catch-up is pending: the parent pushed past the child.
  g.refs.set(P1, refs({ headSha: P1_HEAD_2 }));
  g.ancestry.set(`${P1_HEAD_2}..${CHILD_HEAD}`, false);
  const first = await observe(key, g, {}, 5_000);
  const session = owner();
  const request = { prKey: key, kind: "catch-up" as const, tip: P1_HEAD_2 };
  assert.deepEqual(stackStandingFor(row(key), [session], FOREMAN_ON)!.prompt, { kind: "catch-up", tip: P1_HEAD_2, status: "pending" });
  assert.equal(stackPromptCandidate(registryOf([session]), session.id, request, "foreman", row(key), FOREMAN_ON).error, undefined);

  // The parent then merges - and the next read of it fails. Acting on the last facts would tell
  // the child to merge a parent branch that may no longer exist.
  g.refs.delete(P1);
  const marked = await observe(key, g, { baseRefName: "feat/parent", headSha: CHILD_PUSHED }, 6_000);
  assert.deepEqual(marked, { ...first!, childHeadSha: CHILD_PUSHED, parentUnreadSince: 6_000 },
    "the last PARENT facts, kept and marked unconfirmed; the child's own facts as just read");
  assert.deepEqual(row(key).stack!.observation, marked);
  assert.deepEqual(g.retargets, [], "no base edit on an unknown parent");
  assert.deepEqual(g.compares, [`${P1_HEAD_2}..${CHILD_HEAD}`], "no compare either");
  const held = stackStandingFor(row(key), [session], FOREMAN_ON)!;
  assert.equal(held.prompt, null, "the pending catch-up is withdrawn");
  assert.deepEqual(held.actions, []);
  assert.equal(held.label, "Checking #7 on GitHub - prompts wait until it can be read");
  assert.equal(held.inProgress, false);
  assert.ok(stackPromptCandidate(registryOf([session]), session.id, request, "foreman", row(key), FOREMAN_ON).error, "Foreman cannot deliver it");
  assert.ok(stackPromptCandidate(registryOf([session]), session.id, request, "human", row(key), FOREMAN_ON).error, "nor can the operator");
  // A second failed read keeps the first failure time.
  assert.equal((await observe(key, g, {}, 7_000))!.parentUnreadSince, 6_000);

  // The parent reads again: it merged. The child is retargeted and the RESTACK is offered,
  // keyed to the merge commit - never the stale catch-up.
  g.refs.set(P1, refs({ state: "MERGED", headSha: P1_HEAD_2, mergeCommitSha: MERGE }));
  const fresh = await observe(key, g, {}, 8_000);
  assert.equal(fresh!.parentUnreadSince ?? null, null, "a successful read clears the mark");
  assert.deepEqual(g.retargets, [{ number: nextNumber, base: "main" }]);
  const resumed = stackStandingFor(row(key), [session], FOREMAN_ON)!;
  assert.deepEqual(resumed.prompt, { kind: "restack", tip: MERGE, status: "pending" });
  assert.ok(stackPromptCandidate(registryOf([session]), session.id, request, "foreman", row(key), FOREMAN_ON).error, "the old catch-up stays refused");

  // The FIRST read of a parent failing is recorded too: the child's own facts, an unknown
  // parent, marked unconfirmed - so the row says it is checking, not that the stack is fine.
  const unseen = stackedChild(3_000);
  const firstFailure = await observe(unseen, gh(), {}, 9_000);
  assert.equal(firstFailure?.parentUnreadSince, 9_000);
  assert.equal(firstFailure?.parentState, null);
  assert.equal(firstFailure?.childHeadSha, CHILD_HEAD);
  assert.deepEqual(row(unseen).stack!.observation, firstFailure);
  const checking = stackStandingFor(row(unseen), [owner()], FOREMAN_ON)!;
  assert.equal(checking.label, "Checking #7 on GitHub - prompts wait until it can be read");
  assert.equal(checking.prompt, null);
  assert.deepEqual(checking.actions, []);
});

test("a failed compare leaves ancestry unknown: no catch-up prompt, no cached answer, and the next tick asks again", async () => {
  const key = stackedChild();
  const g = gh();
  // The parent pushed again, and GitHub's compare call fails for the new pair.
  g.refs.set(P1, refs({ headSha: P1_HEAD_2 }));
  const o = await observe(key, g, {}, 5_000);
  assert.equal(o!.parentHeadSha, P1_HEAD_2);
  assert.equal(o!.parentHeadInChild, null, "unknown, not 'contained' and not 'moved'");
  assert.equal(o!.baseBehindBy, null);
  let standing = stackStandingFor(row(key), [owner()], FOREMAN_ON)!;
  assert.equal(standing.state, "current", "an unanswered compare never derives parent-moved");
  assert.equal(standing.prompt, null, "so no catch-up prompt is offered");
  assert.equal(standing.label, "Stacked on #7 (waiting for it to merge)");
  assert.deepEqual(g.retargets, [], "the base already matches the open parent: nothing to edit");
  // The unknown is not cached: the same pair is asked again, and a real answer is used.
  g.ancestry.set(`${P1_HEAD_2}..${CHILD_HEAD}`, false);
  await observe(key, g, {}, 6_000);
  assert.deepEqual(g.compares, [`${P1_HEAD_2}..${CHILD_HEAD}`, `${P1_HEAD_2}..${CHILD_HEAD}`]);
  standing = stackStandingFor(row(key), [owner()], FOREMAN_ON)!;
  assert.equal(standing.state, "parent-moved");
  assert.deepEqual(standing.prompt, { kind: "catch-up", tip: P1_HEAD_2, status: "pending" });
});

test("a child closed while its parent is still open: Reopen on the parent's branch, and the reopened PR stays stacked there", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  // Somebody closed the child by hand; its parent #7 is open and unchanged.
  await observe(key, g, { state: "CLOSED", baseRefName: "feat/parent" });
  db.updateInspectorPr(key, { state: "closed" }, 1);
  assert.deepEqual(g.retargets, [], "a closed pull request is never retargeted");
  const session = owner({ prState: null, prUrl: null });
  const standing = stackStandingFor(row(key), [session], FOREMAN_ON)!;
  assert.equal(standing.state, "broken");
  assert.equal(standing.label, "Stack broken: this pull request was closed while #7 is still open");
  assert.deepEqual(standing.actions, ["reopen-on-parent"]);
  // The operator's action is the session's prompt, through the same candidate check.
  const request = { prKey: key, kind: "reopen-on-parent" as const, tip: null };
  assert.ok(stackPromptCandidate(registryOf([session]), session.id, request, "foreman", row(key), FOREMAN_ON).error, "never Foreman's");
  const candidate = stackPromptCandidate(registryOf([session]), session.id, request, "human", row(key), FOREMAN_ON);
  assert.equal(candidate.error, undefined);
  assert.match((candidate as { payload: string }).payload, /gh pr create --base feat\/parent/);

  // The reopened pull request inherits the lineage, and its base is the open parent's branch.
  nextNumber += 1;
  const reopened = adoptRow(`https://github.com/acme/repo/pull/${nextNumber}`, "child-session", 4_000);
  adoptStackLineage(reopened, { task: CHILD_TASK, episodeId: "ep-child" }, 4_000);
  assert.equal(row(reopened).stack!.parentPrUrl, P1);
  assert.equal(row(reopened).stack!.baseSha, CUT);
  await observe(reopened, g, { baseRefName: "feat/parent" });
  assert.deepEqual(g.retargets, [], "already on the parent's branch: nothing to correct");
  assert.equal(stackStandingFor(row(reopened), [owner()], FOREMAN_ON)!.state, "current");
  // The closed row is history now, and offers nothing.
  const old = stackStandingFor(row(key), [owner()], FOREMAN_ON)!;
  assert.equal(old.label, `Replaced by #${nextNumber}`);
  assert.deepEqual(old.actions, []);
});

test("a session Foreman's own rule will never drive reads as Foreman can't send it, with the reason and the manual send", async () => {
  const key = await restackNeeded();
  const request = { prKey: key, kind: "restack" as const, tip: MERGE };
  const offAllowlist = { enabled: true, mode: "live", repoAllowlist: ["/elsewhere"] } as unknown as Parameters<typeof stackStandingFor>[2];
  for (const [session, foreman, reason] of [
    [owner({ hooksSeen: false }), FOREMAN_ON, "the session is not hook-instrumented"],
    [owner({ foremanInvite: null }), FOREMAN_ON, "Foreman is not invited into this session"],
    [owner(), offAllowlist, "Foreman is not allowed in this repository"],
  ] as const) {
    const standing = stackStandingFor(row(key), [session], foreman)!;
    // Never "pending" - that would show a restack under way that Foreman will refuse to type.
    assert.equal(standing.prompt?.status, "foreman-off", reason);
    assert.equal(standing.prompt?.blocker, reason);
    assert.equal(standing.label, `Restack needed: Foreman can't send it - ${reason}`);
    assert.equal(standing.inProgress, false, "held, not in progress");
    // The same rule refuses Foreman at delivery, so the two can never disagree...
    assert.ok(stackPromptCandidate(registryOf([session]), session.id, request, "foreman", row(key), foreman).error, reason);
    // ...and the operator's manual send is the route that is offered and accepted.
    assert.equal(stackPromptCandidate(registryOf([session]), session.id, request, "human", row(key), foreman).error, undefined, reason);
  }
  // Plain "Foreman is off" stays plain.
  const off = stackStandingFor(row(key), [owner()], FOREMAN_OFF)!;
  assert.equal(off.label, "Restack needed: Foreman is off");
  assert.equal(off.prompt?.blocker, undefined);
  // A transient hold is not a reason: a busy owner stays pending, and Foreman delivers once it parks.
  assert.equal(stackStandingFor(row(key), [owner({ state: "working" })], FOREMAN_ON)!.prompt?.status, "pending");
});

test("an owner with no pane is offered no send it cannot deliver: the row says to resume the task", async () => {
  const key = await restackNeeded();
  const request = { prKey: key, kind: "restack" as const, tip: MERGE };
  const paneless = owner({ runtime: "terminal", terminals: [] });
  for (const foreman of [FOREMAN_ON, FOREMAN_OFF]) {
    const standing = stackStandingFor(row(key), [paneless], foreman)!;
    assert.equal(standing.prompt?.status, "no-pane", "not foreman-off: that would offer a manual send");
    assert.equal(standing.sessionHasPane, false);
    assert.equal(standing.label, "Restack needed: the session has no pane to type into - resume its task to restore one");
    assert.equal(standing.inProgress, false);
  }
  // Nothing can type into it: refused to Foreman and to the operator alike.
  assert.ok(stackPromptCandidate(registryOf([paneless]), paneless.id, request, "foreman", row(key), FOREMAN_ON).error);
  assert.match(stackPromptCandidate(registryOf([paneless]), paneless.id, request, "human", row(key), FOREMAN_ON).error ?? "",
    /no pane to type into - resume its task/);
  // A resumed session with a pane gets it back.
  assert.equal(stackStandingFor(row(key), [owner()], FOREMAN_ON)!.prompt?.status, "pending");
});

test("the replacement transition re-checks the operator's choice, the child's state and its release when it writes", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  await observe(key, g, {}, 5_000);
  g.refs.set(P1, refs({ state: "CLOSED" }));
  adoptRow(P2, "parent-ep-parent", 6_000);
  g.refs.set(P2, refs({ headSha: P2_HEAD, headRefName: "feat/parent-v2" }));
  // The operator withdraws "Wait for a replacement" while the replacement's read is in flight.
  db.setStackAwaitReplacement(key, 6_500, 6_500);
  const withdrawing: StackGitHub = {
    ...seam(g),
    prRefs: async (cwd, url) => {
      if (url === P2) db.setStackAwaitReplacement(key, null, 6_600);
      return seam(g).prRefs(cwd, url);
    },
  };
  await observeStackLifecycle(row(key), snapshot({ baseRefName: "main" }), "/repo", withdrawing, ctx, 7_000);
  assert.equal(row(key).stack!.parentPrUrl, P1, "a withdrawn choice is honoured even mid-transition");
  assert.deepEqual(row(key).stack!.history, []);
  // The release check releases this very head in the gap: the transition refuses too.
  db.setStackAwaitReplacement(key, 7_500, 7_500);
  const releasing: StackGitHub = {
    ...seam(g),
    prRefs: async (cwd, url) => {
      if (url === P2) db.releaseInspectorPrStack(key, CHILD_HEAD, "closed", 7_600);
      return seam(g).prRefs(cwd, url);
    },
  };
  await observeStackLifecycle(row(key), snapshot({ baseRefName: "main" }), "/repo", releasing, ctx, 8_000);
  assert.equal(row(key).stack!.parentPrUrl, P1);
  assert.equal(row(key).stack!.releasedHeadSha, CHILD_HEAD, "the release recorded in the gap is kept");
  // And a closed child is never swapped.
  db.revokeInspectorPrStack(key, 8_100);
  db.updateInspectorPr(key, { state: "closed" }, 8_100);
  assert.equal(db.transitionStackParent(key, P1, P2, 8_200, CHILD_HEAD), false);
  // With the choice standing, the child open and unreleased, it goes through.
  db.updateInspectorPr(key, { state: "open" }, 8_300);
  assert.equal(db.transitionStackParent(key, P1, P2, 8_400, CHILD_HEAD), true);
  assert.equal(row(key).stack!.parentPrUrl, P2);
});

test("a closed, unreplaced child keeps its parent observed, so its recovery action follows the parent", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  // Closed while its parent is open: Reopen on #7's branch.
  await observe(key, g, { state: "CLOSED", baseRefName: "feat/parent" });
  db.updateInspectorPr(key, { state: "closed", observedState: "CLOSED" }, 1);
  assert.deepEqual(stackStandingFor(row(key), [owner()], FOREMAN_ON)!.actions, ["reopen-on-parent"]);
  // The parent then merges. The retired row is still read every sweep, so the offer changes.
  g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  g.refs.set(row(key).url, refs({ state: "CLOSED", headSha: CHILD_HEAD, headRefName: "feat/child", baseRefName: "feat/parent" }));
  await observeClosedStackChildren(seam(g), ctx, () => "/repo", 20_000);
  assert.equal(row(key).stack!.observation!.parentState, "MERGED");
  assert.deepEqual(stackStandingFor(row(key), [owner()], FOREMAN_ON)!.actions, ["reopen-against-main"]);
  assert.deepEqual(g.retargets, [], "reads only: a closed pull request is never retargeted");
  // Once replaced by a later pull request of the same task and episode, it is no longer read.
  nextNumber += 1;
  const replacement = adoptRow(`https://github.com/acme/repo/pull/${nextNumber}`, "child-session", 30_000);
  adoptStackLineage(replacement, { task: CHILD_TASK, episodeId: "ep-child" }, 30_000);
  g.refs.set(P1, refs({ state: "CLOSED" }));
  await observeClosedStackChildren(seam(g), ctx, () => "/repo", 40_000);
  assert.equal(row(key).stack!.observation!.parentState, "MERGED", "the replaced row is left alone");
});

test("a recovery prompt is sent only if the parent still matches what the offer was based on", async () => {
  const key = stackedChild();
  const g = gh();
  g.refs.set(P1, refs());
  await observe(key, g, { state: "CLOSED", baseRefName: "feat/parent" });
  db.updateInspectorPr(key, { state: "closed" }, 1);
  // Still open on the same branch: the offer stands.
  assert.equal((await recheckStackParent(row(key), "reopen-on-parent", seam(g))).error, undefined);
  // It merged since the last check: refused, rather than naming a branch that may be gone.
  g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  assert.match((await recheckStackParent(row(key), "reopen-on-parent", seam(g))).error ?? "", /#7 changed since it was last checked/);
  // Its branch changed: refused for Reopen on #7's branch.
  g.refs.set(P1, refs({ headRefName: "feat/parent-renamed" }));
  assert.match((await recheckStackParent(row(key), "reopen-on-parent", seam(g))).error ?? "", /changed since it was last checked/);
  // Unreadable: refused.
  g.refs.delete(P1);
  assert.match((await recheckStackParent(row(key), "reopen-on-parent", seam(g))).error ?? "", /could not be read from GitHub/);
});

test("closed stacked children are read in round-robin pages, so none is starved", async () => {
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  // Three closed, unreplaced children of three different tasks.
  const keys: string[] = [];
  for (const id of ["task-a", "task-b", "task-c"]) {
    nextNumber += 1;
    const url = `https://github.com/acme/repo/pull/${nextNumber}`;
    const key = adoptRow(url, "child-session", 2_000);
    db.recordInspectorPrLineage(key, { taskId: id, episode: "ep", adoptedAt: 2_000, parentPrUrl: P1, baseSha: CUT, history: [] });
    await observe(key, g, { state: "CLOSED", baseRefName: "feat/parent" }, 3_000);
    db.updateInspectorPr(key, { state: "closed", observedState: "CLOSED" }, 3_000);
    g.refs.set(url, refs({ state: "CLOSED", headSha: CHILD_HEAD, headRefName: "feat/child", baseRefName: "feat/parent" }));
    keys.push(key);
  }
  const observedAt = () => keys.map((key) => row(key).stack!.observation!.observedAt);
  // A page of two per sweep: the first two, then the third, then back to the first.
  await observeClosedStackChildren(seam(g), ctx, () => "/repo", 10_000, 2);
  assert.deepEqual(observedAt(), [10_000, 10_000, 3_000]);
  await observeClosedStackChildren(seam(g), ctx, () => "/repo", 20_000, 2);
  assert.deepEqual(observedAt(), [10_000, 10_000, 20_000], "the oldest-read row is reached next");
  await observeClosedStackChildren(seam(g), ctx, () => "/repo", 30_000, 2);
  assert.deepEqual(observedAt(), [30_000, 30_000, 20_000], "and the walk wraps around");
});

test("a child that closes or merges on a tick whose parent read fails is recorded as such, and recovered", async () => {
  const g = gh();
  g.refs.set(P1, refs());
  g.ancestry.set(`${P1_HEAD}..${CHILD_HEAD}`, true);
  // The child closes on the same tick GitHub fails to answer for its parent.
  const closing = stackedChild();
  await observe(closing, g, {}, 5_000);
  g.refs.delete(P1);
  const marked = await observe(closing, g, { state: "CLOSED", baseRefName: "feat/parent" }, 6_000);
  assert.equal(marked?.childState, "CLOSED", "the child's own facts come from the snapshot that WAS read");
  assert.equal(marked?.parentUnreadSince, 6_000);
  db.updateInspectorPr(closing, { state: "closed", observedState: "CLOSED" }, 6_000);
  // GitHub recovers: the retired row is still read, and its recovery action appears.
  g.refs.set(P1, refs());
  g.refs.set(row(closing).url, refs({ state: "CLOSED", headSha: CHILD_HEAD, headRefName: "feat/child", baseRefName: "feat/parent" }));
  await observeClosedStackChildren(seam(g), ctx, () => "/repo", 7_000);
  assert.equal(row(closing).stack!.observation!.parentUnreadSince ?? null, null);
  assert.deepEqual(stackStandingFor(row(closing), [owner()], FOREMAN_ON)!.actions, ["reopen-on-parent"]);

  // A child that MERGES on such a tick is released, never left "checking" for ever.
  const merging = stackedChild(3_000);
  await observe(merging, g, {}, 5_000);
  g.refs.delete(P1);
  await observe(merging, g, { state: "MERGED", baseRefName: "main" }, 6_000);
  assert.equal(row(merging).stack!.observation!.childState, "MERGED");
  const standing = stackStandingFor(row(merging), [owner()], FOREMAN_ON)!;
  assert.equal(standing.state, "released");
  assert.equal(standing.label, null);
});

test("a closed child whose parent is confirmed merged is not read again: its offer cannot change", async () => {
  const key = stackedChild();
  const reads: string[] = [];
  const g = gh();
  g.refs.set(P1, refs({ state: "MERGED", mergeCommitSha: MERGE }));
  await observe(key, g, { state: "CLOSED", baseRefName: "feat/parent" });
  db.updateInspectorPr(key, { state: "closed", observedState: "CLOSED" }, 1);
  assert.deepEqual(stackStandingFor(row(key), [owner()], FOREMAN_ON)!.actions, ["reopen-against-main"]);
  const counting: StackGitHub = { ...seam(g), prRefs: async (cwd, url) => { reads.push(url); return seam(g).prRefs(cwd, url); } };
  await observeClosedStackChildren(counting, ctx, () => "/repo", 20_000);
  assert.deepEqual(reads, [], "no GitHub reads for a settled stack");
  // An unconfirmed merged parent (the last read failed) is still read until confirmed.
  recordStackObservation(key, { ...row(key).stack!.observation!, parentUnreadSince: 15_000 }, 15_000);
  g.refs.set(row(key).url, refs({ state: "CLOSED", headSha: CHILD_HEAD, headRefName: "feat/child", baseRefName: "feat/parent" }));
  await observeClosedStackChildren(counting, ctx, () => "/repo", 30_000);
  assert.ok(reads.length > 0);
});
