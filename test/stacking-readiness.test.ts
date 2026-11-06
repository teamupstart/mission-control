import { test } from "node:test";
import assert from "node:assert/strict";
import { mkSession, mkTask } from "./helpers/session-fixture.ts";
import { StackReadiness, type StackRegistry } from "../src/server/stacking/readiness.ts";
import type { StackGitHub } from "../src/server/stacking/github.ts";
import type { PrRefs } from "../src/server/inspector/github.ts";
import { ShippingConfigSchema, type ShippingConfig } from "../src/shared/protocol.ts";
import { declaredBlockers } from "../src/shared/backlog.ts";
import type { Session, Task, TaskDependency } from "../src/shared/types.ts";

// The daemon's half of a stacked start: the readiness stamp written on a dependency edge, the
// clearing that keeps it honest, and the revalidation a stacked dispatch runs before it pins
// the prerequisite's head. GitHub and git are a scripted seam; nothing touches the network.

type TaskEdge = Extract<TaskDependency, { type: "task" }>;

const PARENT_PR = "https://github.com/acme/repo/pull/7";
const SECONDARY_PR = "https://github.com/acme/second/pull/9";
const HEAD = "a".repeat(40);
const NEWER = "b".repeat(40);

function edge(taskId: string, over: Partial<TaskEdge> = {}): TaskEdge {
  return {
    type: "task", taskId, title: taskId, sessionId: null, episodeId: null, agentSessionId: null,
    branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null, ...over,
  };
}

interface World {
  tasks: Map<string, Task>;
  sessions: Map<string, Session>;
  /** Session id -> current episode id. */
  episodes: Map<string, string>;
  /** Task id -> binding. */
  bindings: Map<string, {
    episodeId: string;
    sessionId: string;
    prUrl: string | null;
    repoChanges?: Array<{ repoRoot: string; verdict: "changed" | "unchanged" | "unknown" }> | null;
  }>;
  config: ShippingConfig;
  writes: number;
}

function world(): World {
  const parent = mkTask({ id: "A", title: "Phase 1", status: "running", sessionId: "sA", repoRoot: "/repo" });
  const child = mkTask({ id: "C", title: "Phase 2", repoRoot: "/repo", dependencies: [edge("A")] });
  return {
    tasks: new Map([[parent.id, parent], [child.id, child]]),
    sessions: new Map([["sA", mkSession({ id: "sA", state: "idle" })]]),
    episodes: new Map([["sA", "ep1"]]),
    bindings: new Map([["A", { episodeId: "ep1", sessionId: "sA", prUrl: PARENT_PR }]]),
    config: ShippingConfigSchema.parse({ stacking: "stack" }),
    writes: 0,
  };
}

function registryOf(w: World): StackRegistry {
  return {
    listTasks: () => [...w.tasks.values()],
    getTask: (id) => w.tasks.get(id),
    getSession: (id) => w.sessions.get(id),
    workEpisodeForSession: (id) => (w.episodes.has(id) ? { episodeId: w.episodes.get(id)! } : null),
    workEpisodeForTask: (id) => w.bindings.get(id) ?? null,
    upsertTask: (task) => {
      w.writes += 1;
      w.tasks.set(task.id, task);
    },
  };
}

interface Script {
  refs: Map<string, PrRefs>;
  repositories: { owner: string; repo: string }[];
  tip: { ok: true; value: string } | { ok: false; reason: string; outcomeUnknown: boolean };
  ancestry: Map<string, boolean>;
  /** Run during the parent read, to model the world moving while GitHub answers. */
  duringRead?: () => void;
  reads: number;
  fetches: string[];
}

function script(): Script {
  return {
    refs: new Map([[PARENT_PR, {
      state: "OPEN", isDraft: false, headSha: HEAD, headRefName: "feat/a", baseRefName: "main",
      defaultBranch: "main", mergeCommitSha: null,
    }]]),
    repositories: [{ owner: "acme", repo: "repo" }],
    tip: { ok: true, value: NEWER },
    ancestry: new Map(),
    reads: 0,
    fetches: [],
  };
}

function githubOf(s: Script): StackGitHub {
  return {
    prRefs: async (_cwd, url) => {
      s.reads += 1;
      s.duringRead?.();
      const refs = s.refs.get(url);
      return refs ? { ok: true, value: refs } : { ok: false, error: "no such pull request" };
    },
    isAncestor: async (_cwd, _owner, _repo, ancestor, head) => {
      const answer = s.ancestry.get(`${ancestor}..${head}`);
      return answer === undefined ? { ok: false, error: "compare failed" } : { ok: true, value: answer };
    },
    mergeBase: async () => ({ ok: false, error: "unused" }),
    branchSha: async (_root, branch) => {
      s.fetches.push(branch);
      return s.tip;
    },
    repositories: async () => s.repositories,
    retarget: async () => ({ ok: true }),
  };
}

function readiness(w: World, s: Script): StackReadiness {
  return new StackReadiness(registryOf(w), () => w.config, githubOf(s), () => 1_000);
}

function childEdge(w: World): TaskEdge {
  return w.tasks.get("C")!.dependencies[0] as TaskEdge;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

test("a finished prerequisite with an open primary pull request stamps its stack-mode dependents", async () => {
  const w = world();
  const s = script();
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.deepEqual(
    { at: childEdge(w).stackReadyAt, branch: childEdge(w).stackBaseBranch, sha: childEdge(w).stackBaseSha, url: childEdge(w).stackPrUrl },
    { at: 1_000, branch: "feat/a", sha: HEAD, url: PARENT_PR },
  );
  assert.equal(childEdge(w).satisfiedAt, null, "stacking never satisfies the edge");
  assert.deepEqual(declaredBlockers(w.tasks.get("C")!, [...w.tasks.values()]), []);
});

test("a wait-for-merge default or an After merge edge is never stamped", async () => {
  for (const setup of [
    (w: World) => { w.config = ShippingConfigSchema.parse({}); },
    (w: World) => { w.tasks.set("C", { ...w.tasks.get("C")!, dependencies: [edge("A", { mode: "merge" })] }); w.config = ShippingConfigSchema.parse({ stacking: "stack" }); },
  ]) {
    const w = world();
    setup(w);
    const s = script();
    readiness(w, s).reconcile();
    await settle();
    assert.equal(childEdge(w).stackReadyAt ?? null, null);
    assert.equal(s.reads, 0, "no GitHub read for an edge that cannot stack");
  }
});

test("a prerequisite still working, with queued work, or on another episode is not stamped", async () => {
  for (const setup of [
    (w: World) => w.sessions.set("sA", mkSession({ id: "sA", state: "working" })),
    (w: World) => w.sessions.set("sA", mkSession({ id: "sA", state: "idle", queue: { openCount: 1 } as Session["queue"] })),
    (w: World) => w.episodes.set("sA", "ep2"),
    (w: World) => w.bindings.set("A", { episodeId: "ep1", sessionId: "sA", prUrl: null }),
  ]) {
    const w = world();
    setup(w);
    const s = script();
    readiness(w, s).reconcile();
    await settle();
    assert.equal(childEdge(w).stackReadyAt ?? null, null);
  }
});

test("a draft, a closed pull request, or one only in a secondary repository stamps nothing", async () => {
  const draft = script();
  draft.refs.set(PARENT_PR, { ...draft.refs.get(PARENT_PR)!, isDraft: true });
  const closed = script();
  closed.refs.set(PARENT_PR, { ...closed.refs.get(PARENT_PR)!, state: "CLOSED" });
  for (const s of [draft, closed]) {
    const w = world();
    readiness(w, s).reconcile();
    await settle();
    assert.equal(childEdge(w).stackReadyAt ?? null, null);
  }
  // The prerequisite's only open pull request is in its secondary repository.
  const w = world();
  w.bindings.set("A", { episodeId: "ep1", sessionId: "sA", prUrl: SECONDARY_PR });
  const s = script();
  s.refs.set(SECONDARY_PR, { ...s.refs.get(PARENT_PR)!, headRefName: "feat/second" });
  readiness(w, s).reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "a secondary-repository PR cannot release the dependent");
  assert.notDeepEqual(declaredBlockers(w.tasks.get("C")!, [...w.tasks.values()]), []);
});

test("the stamp is cleared when the prerequisite starts a new turn, or the setting turns off", async () => {
  const w = world();
  const s = script();
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);
  w.sessions.set("sA", mkSession({ id: "sA", state: "working" }));
  r.reconcile();
  assert.equal(childEdge(w).stackReadyAt ?? null, null);
  assert.equal(childEdge(w).stackPrUrl ?? null, null);

  w.sessions.set("sA", mkSession({ id: "sA", state: "idle" }));
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);
  w.config = ShippingConfigSchema.parse({ stacking: "merge" });
  r.reconcile();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "switching the default off un-releases a dependent that has not started");
});

test("a stamped dependent is pinned to the parent branch's CURRENT head", async () => {
  const w = world();
  const s = script();
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  // The parent pushed again after the stamp: GitHub reports the new head, and origin has it.
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, headSha: NEWER });
  const plan = await r.planStackedDispatch(w.tasks.get("C")!);
  assert.deepEqual(plan, {
    ok: true,
    baseSha: NEWER,
    fields: { stackParentTaskId: "A", stackBaseBranch: "feat/a", stackBaseSha: NEWER, stackPrUrl: PARENT_PR },
  });
  assert.deepEqual(s.fetches, ["feat/a"]);
});

test("a dependent not starting on a stack is dispatched unstacked", async () => {
  const w = world();
  w.config = ShippingConfigSchema.parse({});
  const plain = mkTask({ id: "D", repoRoot: "/repo" });
  w.tasks.set("D", plain);
  assert.equal(await readiness(w, script()).planStackedDispatch(plain), null);
});

test("a failed fetch refuses the dispatch and never falls back to the default branch", async () => {
  const w = world();
  const s = script();
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  s.tip = { ok: false, reason: "git fetch origin feat/a failed: network down", outcomeUnknown: false };
  const plan = await r.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(plan?.ok, false);
  assert.match(!plan?.ok ? plan!.error : "", /could not fetch feat\/a.*network down/);
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "the refusal clears the stamp");
  assert.notDeepEqual(declaredBlockers(w.tasks.get("C")!, [...w.tasks.values()]), []);
});

test("dispatch revalidates a stale stamp: draft, closed, moved branch, new turn, queued work", async () => {
  const cases: [string, (w: World, s: Script) => void, RegExp][] = [
    ["became a draft", (_w, s) => s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: true }), /draft/],
    ["closed", (_w, s) => s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, state: "CLOSED" }), /closed/],
    ["moved branch", (_w, s) => s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, headRefName: "feat/renamed" }), /another branch/],
    ["new turn", (w) => w.sessions.set("sA", mkSession({ id: "sA", state: "working" })), /working again/],
    ["queued work", (w) => w.sessions.set("sA", mkSession({ id: "sA", state: "idle", queue: { openCount: 2 } as Session["queue"] })), /working again/],
    ["new episode", (w) => w.episodes.set("sA", "ep2"), /working again/],
    ["new pull request", (w) => w.bindings.set("A", { episodeId: "ep1", sessionId: "sA", prUrl: "https://github.com/acme/repo/pull/8" }), /pull request changed/],
    ["turn started mid-read", (w, s) => { s.duringRead = () => w.sessions.set("sA", mkSession({ id: "sA", state: "working" })); }, /working again/],
  ];
  for (const [name, spoil, why] of cases) {
    const w = world();
    const s = script();
    const r = readiness(w, s);
    r.reconcile();
    await settle();
    assert.equal(childEdge(w).stackReadyAt, 1_000, name);
    spoil(w, s);
    const plan = await r.planStackedDispatch(w.tasks.get("C")!);
    assert.equal(plan?.ok, false, name);
    assert.match(!plan?.ok ? plan!.error : "", why, name);
    assert.equal(childEdge(w).stackReadyAt ?? null, null, `${name}: the stamp is cleared in the same step`);
  }
});

test("a merged sibling prerequisite must already be in the parent's head", async () => {
  // C depends on A (merged) and B (open, stacked on). B's head predates A's merge commit.
  const w = world();
  const s = script();
  const A_URL = "https://github.com/acme/repo/pull/5";
  const MERGE_A = "c".repeat(40);
  const b = mkTask({ id: "B", title: "Phase B", status: "running", sessionId: "sB", repoRoot: "/repo" });
  const a = mkTask({ id: "A2", title: "Phase A", status: "done", repoRoot: "/repo" });
  w.tasks.set("B", b);
  w.tasks.set("A2", a);
  w.tasks.delete("A");
  w.tasks.set("C", mkTask({ id: "C", repoRoot: "/repo", dependencies: [
    edge("A2", { satisfiedAt: 3, prUrl: A_URL }),
    edge("B"),
  ] }));
  w.sessions.set("sB", mkSession({ id: "sB", state: "idle" }));
  w.episodes.set("sB", "epB");
  w.bindings.set("B", { episodeId: "epB", sessionId: "sB", prUrl: PARENT_PR });
  s.refs.set(A_URL, { state: "MERGED", isDraft: false, headSha: "d".repeat(40), headRefName: "feat/a2", baseRefName: "main", defaultBranch: "main", mergeCommitSha: MERGE_A });
  s.ancestry.set(`${MERGE_A}..${HEAD}`, false);
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).satisfiedAt, 3);
  const bEdge = () => w.tasks.get("C")!.dependencies[1] as TaskEdge;
  assert.equal(bEdge().stackReadyAt ?? null, null, "not released while B lacks A's merge commit");

  // B merges the default branch in; its head now carries A's merge commit.
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, headSha: NEWER });
  s.ancestry.set(`${MERGE_A}..${NEWER}`, true);
  const fresh = readiness(w, s);
  fresh.reconcile();
  await settle();
  assert.equal(bEdge().stackReadyAt, 1_000);
  s.tip = { ok: true, value: NEWER };
  const plan = await fresh.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(plan?.ok && plan.baseSha, NEWER);

  // If B's branch moved back behind A between the stamp and the dispatch, refuse.
  const STALE = "e".repeat(40);
  s.tip = { ok: true, value: STALE };
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, headSha: STALE });
  s.ancestry.set(`${MERGE_A}..${STALE}`, false);
  const refused = await fresh.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(refused?.ok, false);
  assert.match(!refused?.ok ? refused!.error : "", /waiting for the parent to include #5/);
});

type SessionEdge = Extract<TaskDependency, { type: "session" }>;

function sessionEdge(sessionId: string, over: Partial<SessionEdge> = {}): SessionEdge {
  return {
    type: "session", sessionId, title: `session ${sessionId}`, episodeId: null, agentSessionId: null,
    branch: null, prUrl: null, selectedAt: 1, satisfiedAt: null, ...over,
  };
}

test("a merged standalone-session prerequisite must already be in the parent's head too", async () => {
  // C stacks on A's open pull request and also depends on a bare session whose pull request
  // in this repository has merged. A's head predates that merge commit.
  const w = world();
  const s = script();
  const SESSION_PR = "https://github.com/acme/repo/pull/4";
  const MERGE_S = "c".repeat(40);
  w.tasks.set("C", mkTask({ id: "C", title: "Phase 2", repoRoot: "/repo", dependencies: [
    edge("A"),
    sessionEdge("sX", { satisfiedAt: 3, prUrl: SESSION_PR }),
  ] }));
  s.refs.set(SESSION_PR, { state: "MERGED", isDraft: false, headSha: "d".repeat(40), headRefName: "fix/x", baseRefName: "main", defaultBranch: "main", mergeCommitSha: MERGE_S });
  s.ancestry.set(`${MERGE_S}..${HEAD}`, false);
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "not released while A lacks the session's merged work");
  r.stop();

  // A merges the default branch in: its head now carries the session's merge commit.
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, headSha: NEWER });
  s.ancestry.set(`${MERGE_S}..${NEWER}`, true);
  const fresh = readiness(w, s);
  fresh.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);
  s.tip = { ok: true, value: NEWER };
  const plan = await fresh.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(plan?.ok && plan.baseSha, NEWER);

  // And the dispatch-time revalidation refuses if A's branch fell behind it again.
  const STALE = "e".repeat(40);
  s.tip = { ok: true, value: STALE };
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, headSha: STALE });
  s.ancestry.set(`${MERGE_S}..${STALE}`, false);
  const refused = await fresh.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(refused?.ok, false);
  assert.match(!refused?.ok ? refused!.error : "", /waiting for the parent to include #4/);
  fresh.stop();
});

test("a merged session prerequisite in another repository is not asked about", async () => {
  const w = world();
  const s = script();
  const ELSEWHERE = "https://github.com/acme/other/pull/4";
  w.tasks.set("C", mkTask({ id: "C", title: "Phase 2", repoRoot: "/repo", dependencies: [
    edge("A"),
    sessionEdge("sX", { satisfiedAt: 3, prUrl: ELSEWHERE }),
  ] }));
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000, "an ancestry question in another repository has no answer");
  assert.equal(s.refs.has(ELSEWHERE), false);
  r.stop();
});

// ---- review round 2 ----------------------------------------------------------------------

test("a same-named branch on origin that is not the parent pull request's head is never stacked on", async () => {
  // The parent pull request comes from a fork whose branch name also exists on this
  // repository's origin, at unrelated code. GitHub reports the fork's head; origin has another.
  const w = world();
  const s = script();
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  const UNRELATED = "9".repeat(40);
  s.tip = { ok: true, value: UNRELATED };
  const plan = await r.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(plan?.ok, false, "never pins a commit GitHub did not report as the parent's head");
  assert.match(!plan?.ok ? plan!.error : "", /origin's feat\/a is at 999999999999, not #7's head aaaaaaaaaaaa/);
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "the refusal clears the stamp");
});

type RepoChanges = Array<{ repoRoot: string; verdict: "changed" | "unchanged" | "unknown" }> | null;

function multiRepoParent(w: World, repoChanges: RepoChanges, secondary: Partial<Task["extraRepos"][number]> = {}) {
  w.tasks.set("A", { ...w.tasks.get("A")!, extraRepos: [{
    repoRoot: "/second", worktreePath: "/wt/second", branch: "feat/a", provider: null, worktreeLeaseId: null,
    baseSha: null, prUrl: null, prState: null, mergedAt: null, ...secondary,
  }] });
  w.bindings.set("A", { episodeId: "ep1", sessionId: "sA", prUrl: PARENT_PR, repoChanges });
}

test("a secondary repository the prerequisite changed holds the stack until it merges, PR or not", async () => {
  for (const [name, changes, secondary, stamps] of [
    ["changed, no pull request yet", [{ repoRoot: "/second", verdict: "changed" as const }], {}, false],
    ["never observed", null, {}, false],
    ["head unreadable", [{ repoRoot: "/second", verdict: "unknown" as const }], {}, false],
    ["observed unchanged", [{ repoRoot: "/second", verdict: "unchanged" as const }], {}, true],
    ["changed and merged", [{ repoRoot: "/second", verdict: "changed" as const }], { prUrl: "https://github.com/acme/second/pull/2", prState: "merged", mergedAt: 9 }, true],
  ] as const) {
    const w = world();
    multiRepoParent(w, changes as RepoChanges, secondary);
    const s = script();
    readiness(w, s).reconcile();
    await settle();
    assert.equal(typeof childEdge(w).stackReadyAt === "number", stamps, name);
  }
});

test("dispatch refuses a stamp whose prerequisite has since changed a secondary repository", async () => {
  const w = world();
  multiRepoParent(w, [{ repoRoot: "/second", verdict: "unchanged" }]);
  const s = script();
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.equal(typeof childEdge(w).stackReadyAt, "number");
  multiRepoParent(w, [{ repoRoot: "/second", verdict: "changed" }]);
  const plan = await r.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(plan?.ok, false);
  assert.match(!plan?.ok ? plan!.error : "", /unmerged change in \/second/);
  assert.equal(childEdge(w).stackReadyAt ?? null, null);
});

test("a draft that becomes ready on GitHub is picked up when the refusal memo expires, with no local event", async () => {
  const w = world();
  const s = script();
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: true });
  let clock = 1_000;
  const pending: { run: () => void; ms: number }[] = [];
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), () => clock, {
    set: (run, ms) => { pending.push({ run, ms }); return pending.length; },
    clear: () => {},
  });
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "a draft is not stacked on");
  assert.equal(pending.length, 1, "the refusal schedules one re-check");
  assert.ok(pending[0]!.ms > 60_000, "after the memo window, so the re-check actually re-reads");
  // On GitHub only: the draft is marked ready. Nothing local happens.
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: false });
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "inside the memo window nothing is re-read");
  assert.equal(pending.length, 1, "and no second timer piles up");
  clock += pending[0]!.ms;
  pending.shift()!.run();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, clock, "the timer's pass re-reads and stamps the now-ready pull request");
});

test("stopping readiness cancels its pending re-checks", async () => {
  const w = world();
  const s = script();
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: true });
  const cleared: unknown[] = [];
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), () => 1_000, {
    set: () => "timer-1",
    clear: (handle) => { cleared.push(handle); },
  });
  r.reconcile();
  await settle();
  r.stop();
  assert.deepEqual(cleared, ["timer-1"]);
});
