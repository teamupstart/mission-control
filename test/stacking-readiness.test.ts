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
  /** The checkout's primary repository; by default its only GitHub remote, as the daemon reads it. */
  primary?: { owner: string; repo: string } | null;
  tip: { ok: true; value: string } | { ok: false; reason: string; outcomeUnknown: boolean };
  ancestry: Map<string, boolean>;
  /** Run during the parent read, to model the world moving while GitHub answers. */
  duringRead?: () => void | Promise<void>;
  /** Run during an ancestry (compare) call, to model the world moving while GitHub answers. */
  duringAncestry?: () => void | Promise<void>;
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
    compare: async () => ({ ok: false, error: "unused" }),
    prRefs: async (_cwd, url) => {
      s.reads += 1;
      await s.duringRead?.();
      const refs = s.refs.get(url);
      return refs ? { ok: true, value: refs } : { ok: false, error: "no such pull request" };
    },
    isAncestor: async (_cwd, _owner, _repo, ancestor, head) => {
      await s.duringAncestry?.();
      const answer = s.ancestry.get(`${ancestor}..${head}`);
      return answer === undefined ? { ok: false, error: "compare failed" } : { ok: true, value: answer };
    },
    mergeBase: async () => ({ ok: false, error: "unused" }),
    branchSha: async (_root, branch) => {
      s.fetches.push(branch);
      return s.tip;
    },
    repositories: async () => s.repositories,
    primaryRepository: async () => (s.primary !== undefined ? s.primary : s.repositories.length === 1 ? s.repositories[0]! : null),
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
    (w: World) => { w.config = ShippingConfigSchema.parse({ stacking: "merge" }); },
    (w: World) => { w.tasks.set("C", { ...w.tasks.get("C")!, dependencies: [edge("A", { mode: "merge" })] }); w.config = ShippingConfigSchema.parse({ stacking: "stack" }); },
    // The shipped default is Stack: an After merge edge still waits under it.
    (w: World) => { w.tasks.set("C", { ...w.tasks.get("C")!, dependencies: [edge("A", { mode: "merge" })] }); w.config = ShippingConfigSchema.parse({}); },
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
    ["turn started mid-read", (w, s) => { s.duringRead = () => { w.sessions.set("sA", mkSession({ id: "sA", state: "working" })); }; }, /working again/],
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

/** A fake clock and timer table that honours `clear`, so only live timers can fire. */
function fakeTimers(start: number) {
  let clock = start;
  let next = 0;
  const live = new Map<number, { run: () => void; due: number }>();
  return {
    now: () => clock,
    timers: {
      set: (run: () => void, ms: number) => { next += 1; live.set(next, { run, due: clock + ms }); return next; },
      clear: (handle: unknown) => { live.delete(handle as number); },
    },
    live,
    advance(to: number) { clock = to; },
    /** Fire every live timer due by now. */
    fireDue() {
      // A snapshot: a timer armed while these run is not due in this same pass.
      for (const [id, timer] of Array.from(live)) {
        if (timer.due <= clock) { live.delete(id); timer.run(); }
      }
    },
  };
}

test("a parent that moves to another refused pull request rearms the re-check for the new refusal", async () => {
  const w = world();
  const s = script();
  const PR_B = "https://github.com/acme/repo/pull/8";
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: true });
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  assert.equal(t.live.size, 1, "PR A's refusal arms one re-check");
  const timerForA = [...t.live.values()][0]!.due;

  // Thirty seconds later the parent's episode is on PR B, also a draft: refused too.
  t.advance(31_000);
  w.bindings.set("A", { episodeId: "ep1", sessionId: "sA", prUrl: PR_B });
  s.refs.set(PR_B, { ...s.refs.get(PARENT_PR)!, isDraft: true });
  r.reconcile();
  await settle();
  assert.equal(t.live.size, 1, "still one timer per prerequisite");
  assert.ok([...t.live.values()][0]!.due > timerForA, "the timer now follows B's refusal, not A's");

  // B is marked ready on GitHub only. Nothing local happens; at A's old due time no read is
  // possible (B's memo is still live), and B's own timer then picks it up.
  s.refs.set(PR_B, { ...s.refs.get(PR_B)!, isDraft: false });
  t.advance(timerForA);
  t.fireDue();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null);
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, t.now(), "the dependent is stamped once B's memo expires");
  assert.equal(childEdge(w).stackPrUrl, PR_B);
  r.stop();
});

test("a pass that lands inside the refusal memo window leaves a re-check behind", async () => {
  const w = world();
  const s = script();
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: true });
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  // The pending timer is lost (fired early, say) while the memo still holds.
  const [id, early] = Array.from(t.live)[0]!;
  t.live.delete(id);
  t.advance(30_000);
  early.run();
  await settle();
  assert.equal(t.live.size, 1, "the skipped pass arms a re-check for when the memo expires");
  assert.ok([...t.live.values()][0]!.due > 61_000, "after the memo window");
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: false });
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  assert.equal(typeof childEdge(w).stackReadyAt, "number", "the now-ready pull request is stamped");
  r.stop();
});

// ---- Inspector review 4: a standing stamp is read again ----------------------------------

test("a parent pull request turned back into a draft on GitHub unstamps its dependent with no local event", async () => {
  const w = world();
  const s = script();
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);
  assert.deepEqual(declaredBlockers(w.tasks.get("C")!, [...w.tasks.values()]), []);
  assert.equal(t.live.size, 1, "a standing stamp keeps one re-check armed");
  assert.ok([...t.live.values()][0]!.due > 61_000, "after the recheck interval");

  // On GitHub only: the parent is marked draft. Nothing local happens.
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: true });
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "the stamp no longer stands and is withdrawn");
  assert.equal(declaredBlockers(w.tasks.get("C")!, [...w.tasks.values()]).length, 1, "the board shows the dependent waiting again");
  r.stop();
});

test("a re-read that confirms the stamp writes nothing; a failed read keeps it; a closed parent clears it", async () => {
  const w = world();
  const s = script();
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  const writes = w.writes;
  const reads = s.reads;

  // Inside the interval a local event re-reads nothing.
  t.advance(30_000);
  r.reconcile();
  await settle();
  assert.equal(s.reads, reads, "a fresh stamp is not read again on every event");

  // The interval passes: read again, same facts, no write, still stamped since 1_000.
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  assert.equal(s.reads, reads + 1);
  assert.equal(w.writes, writes, "an unchanged stamp raises no task write");
  assert.equal(childEdge(w).stackReadyAt, 1_000, "the stamp keeps the time it first became ready");

  // GitHub cannot be read: the stamp stays (the dispatch revalidates anyway).
  const parentRefs = s.refs.get(PARENT_PR)!;
  s.refs.delete(PARENT_PR);
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000, "a failed read is not a refusal");

  // The parent closes: a definite answer withdraws the stamp.
  s.refs.set(PARENT_PR, { ...parentRefs, state: "CLOSED" });
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null);
  r.stop();
});

test("a stamp found on start is read again before it is trusted", async () => {
  const w = world();
  const s = script();
  const first = readiness(w, s);
  first.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);
  first.stop();
  // A fresh process (a daemon restart) with the parent now a draft.
  s.refs.set(PARENT_PR, { ...s.refs.get(PARENT_PR)!, isDraft: true });
  const t = fakeTimers(2_000);
  const restarted = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  restarted.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null);
  restarted.stop();
});

// ---- CodeRabbit: a dispatch-only refusal defers the next stamp ---------------------------

test("a fork-tip refusal is not stamped again until the deferral's re-check, so the dispatch is not retried every tick", async () => {
  const w = world();
  const s = script(); // origin's tip (NEWER) is not the pull request's head (HEAD)
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);
  const refused = await r.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(refused?.ok, false);
  assert.match(!refused?.ok ? refused!.error : "", /not #7's head/);
  assert.equal(childEdge(w).stackReadyAt ?? null, null);

  // Foreman's next ticks and any local event: the read is deferred, nothing is re-stamped.
  const reads = s.reads;
  for (const at of [2_000, 20_000, 50_000]) {
    t.advance(at);
    r.reconcile();
    await settle();
  }
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "the dependent is not offered again inside the deferral");
  assert.equal(s.reads, reads, "and the prerequisite is not re-read");
  assert.equal(t.live.size, 1, "one re-check is pending");

  // Origin catches up with the pull request's head; the re-check stamps and the dispatch pins.
  s.tip = { ok: true, value: HEAD };
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  assert.equal(typeof childEdge(w).stackReadyAt, "number", "stamped again after the deferral");
  const plan = await r.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(plan?.ok && plan.baseSha, HEAD);
  r.stop();
});

test("a dispatch refused while a readiness read is in flight is not overwritten by that read", async () => {
  const w = world();
  const s = script();
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);

  // The recheck's read is answered only after a dispatch of the child was refused on the
  // fork-tip check.
  const midRead: { plan: Awaited<ReturnType<StackReadiness["planStackedDispatch"]>> } = { plan: null };
  let once = true;
  s.duringRead = async () => {
    if (!once) return;
    once = false;
    midRead.plan = await r.planStackedDispatch(w.tasks.get("C")!);
  };
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  await settle();
  assert.equal(midRead.plan?.ok, false, "the dispatch was refused during the read");
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "the in-flight read does not stamp over the newer refusal");
  r.stop();
});

// ---- Inspector review 6: the stamp is written only on evidence that still holds ----------

/** C stacks on A and also depends on merged A2, whose merge commit A's head carries. */
function withMergedSibling(w: World, s: Script): void {
  const A2_URL = "https://github.com/acme/repo/pull/5";
  const MERGE_A2 = "c".repeat(40);
  w.tasks.set("A2", mkTask({ id: "A2", title: "Phase A", status: "done", repoRoot: "/repo" }));
  w.tasks.set("C", mkTask({ id: "C", title: "Phase 2", repoRoot: "/repo", dependencies: [
    edge("A"),
    edge("A2", { satisfiedAt: 3, prUrl: A2_URL }),
  ] }));
  s.refs.set(A2_URL, { state: "MERGED", isDraft: false, headSha: "d".repeat(40), headRefName: "feat/a2", baseRefName: "main", defaultBranch: "main", mergeCommitSha: MERGE_A2 });
  s.ancestry.set(`${MERGE_A2}..${HEAD}`, true);
}

test("a parent that starts a new turn during the merged-sibling check is not stamped on", async () => {
  const w = world();
  const s = script();
  withMergedSibling(w, s);
  s.duringAncestry = () => { w.sessions.set("sA", mkSession({ id: "sA", state: "working" })); };
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "the read's evidence no longer holds when the stamp would be written");
  r.stop();
});

test("a stamp cleared by a new turn during a recheck's ancestry check is not written back", async () => {
  const w = world();
  const s = script();
  withMergedSibling(w, s);
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);

  // The recheck's ancestry call is answered after the parent started a new turn and the
  // ensuing reconcile cleared the stamp.
  s.duringAncestry = () => {
    s.duringAncestry = undefined;
    w.sessions.set("sA", mkSession({ id: "sA", state: "working" }));
    r.reconcile();
  };
  t.advance([...t.live.values()][0]!.due);
  t.fireDue();
  await settle();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "the cleared stamp stays cleared");
  r.stop();
});

// ---- Inspector review 16 ----------------------------------------------------------------------

test("a parent that starts a new turn during the dispatch's ancestry check is not stacked on", async () => {
  const w = world();
  const s = script();
  withMergedSibling(w, s);
  s.tip = { ok: true, value: HEAD };
  const t = fakeTimers(1_000);
  const r = new StackReadiness(registryOf(w), () => w.config, githubOf(s), t.now, t.timers);
  r.reconcile();
  await settle();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000);
  // The dispatch's merged-sibling check is answered after the parent started working again.
  s.duringAncestry = () => {
    s.duringAncestry = undefined;
    w.sessions.set("sA", mkSession({ id: "sA", state: "working" }));
  };
  const plan = await r.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(plan?.ok, false, "the plan is not returned on a parent that is working again");
  assert.match(!plan?.ok ? plan!.error : "", /working again/);
  r.stop();
});

test("a parent pull request in the checkout's secondary GitHub remote is neither stamped nor stacked on", async () => {
  const UPSTREAM_PR = "https://github.com/acme/upstream/pull/7";
  const w = world();
  w.bindings.set("A", { episodeId: "ep1", sessionId: "sA", prUrl: UPSTREAM_PR });
  const s = script();
  s.refs.set(UPSTREAM_PR, { ...s.refs.get(PARENT_PR)! });
  // Two GitHub remotes; origin names acme/repo, so that is where the child's PR opens.
  s.repositories = [{ owner: "acme", repo: "upstream" }, { owner: "acme", repo: "repo" }];
  s.primary = { owner: "acme", repo: "repo" };
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "a PR in another remote's repository is not a stack base");

  // A stamp that names it anyway (written before this check existed) is refused at dispatch.
  w.tasks.set("C", { ...w.tasks.get("C")!, dependencies: [{ ...childEdge(w), stackReadyAt: 1, stackBaseBranch: "feat/a", stackBaseSha: HEAD, stackPrUrl: UPSTREAM_PR }] });
  const plan = await r.planStackedDispatch(w.tasks.get("C")!);
  assert.equal(plan?.ok, false);
  assert.match(!plan?.ok ? plan!.error : "", /not in Phase 1's primary repository/);
  r.stop();
});

test("a checkout whose primary repository cannot be told stacks on nothing", async () => {
  const w = world();
  const s = script();
  s.repositories = [{ owner: "acme", repo: "upstream" }, { owner: "acme", repo: "repo" }];
  s.primary = null;
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null);
  r.stop();
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

test("a blocked prerequisite stamps no dependent until its blocker is cleared", async () => {
  const blocker = {
    kind: "dependency" as const, reason: "Needs #1402 merged", waitingOn: "Platform", resumeWhen: "#1402 merges",
    details: null, referenceUrl: null, startedAt: 1, updatedAt: 1, checkedAt: null, reply: null,
  };
  const w = world();
  w.sessions.set("sA", mkSession({ id: "sA", state: "idle", blocker }));
  const s = script();
  const r = readiness(w, s);
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt ?? null, null, "a parked, blocked episode is not finished");
  assert.equal(s.reads, 0, "no GitHub read for a prerequisite that is blocked");

  w.sessions.set("sA", mkSession({ id: "sA", state: "idle", blocker: null }));
  r.reconcile();
  await settle();
  assert.equal(childEdge(w).stackReadyAt, 1_000, "clearing the blocker releases the stamp");
});
