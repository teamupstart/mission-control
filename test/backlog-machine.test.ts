import { test } from "node:test";
import assert from "node:assert/strict";
import {
  activeAgentCount,
  agentIsFree,
  assignRefusalParksSession,
  decideBacklogTick,
} from "../src/server/foreman/backlog-machine.ts";
import type { BacklogConfig } from "../src/server/foreman/backlog-machine.ts";
import type { BacklogPlan, Session, Task } from "../src/shared/types.ts";
import { PLANNABLE_LIMIT, planStale } from "../src/shared/backlog.ts";
import { mkTask as baseTask, mkMuxHandle } from "./helpers/session-fixture.ts";

// The backlog autopilot's decision core. Pure with `now` injected, so the precedence is
// a table - and it has to be, because two of its steps are the difference between a
// feature and an incident: the capacity count is what stands between a ceiling of three
// and a machine with eleven agents on it, and the assign-before-capacity ordering is
// what keeps the ceiling from silently disabling the cheap path that needs no session
// at all.
//
// The other thing pinned here is that a MISSING plan never becomes permission. A stale
// plan replans and schedules nothing; a plan that cannot be made at all drops to one
// task in flight, which satisfies any dependency order by construction.

const NOW = 1_000_000;

const CFG: BacklogConfig = {
  enabled: true,
  maxSessions: 3,
  allowlist: ["/repo"],
  mayActLive: true,
  settleMs: 10_000,
  respectOpenPrs: true,
  planExhausted: false,
};

const cfg = (over: Partial<BacklogConfig> = {}): BacklogConfig => ({ ...CFG, ...over });

let taskSeq = 0;
/** A backlog item with a distinct id and arrival order, over the shared task fixture. */
function mkTask(over: Partial<Task> = {}): Task {
  const n = ++taskSeq;
  return baseTask({
    id: `t${n}`,
    title: `Task ${n}`,
    createdAt: 1000 + n,
    updatedAt: 1000 + n,
    ...over,
  });
}

let sessionSeq = 0;
function mkSession(over: Partial<Session> = {}): Session {
  const n = ++sessionSeq;
  return {
    id: `s${n}`,
    agent: "claude",
    name: `agent-${n}`,
    runtime: "terminal",
    // The assignment targets these tests model are Mission Control's own dispatched
    // agents - which is also what keeps their meaning when phase 2 gates `agentIsFree`.
    foremanInvite: "dispatch",
    nameSource: "tmux",
    state: "idle",
    cwd: "/repo",
    gitBranch: "main",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 100 + n,
    tty: `ttys00${n}`,
    permissionMode: null,
    terminals: [mkMuxHandle({ session: `agent-${n}`, paneId: `%${n}` })],
    agentSessionId: `agent-session-${n}`,
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: "idle",
    startedAt: 0,
    firstSeen: 0,
    lastSeen: NOW,
    // Settled well past settleMs by default, so a test opts INTO un-settled.
    lastActivity: NOW - 60_000,
    pendingReviews: 0,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    inspector: null,
    meta: null,
    effortBaselineReady: false,
    pendingEffort: null,
    note: null,
    cost: null,
    goal: null,
    queue: null,
    pendingTurns: [],
    orphanedQueue: null,
    pipeline: null,
    paneDialog: null,
    ...over,
  };
}

/** A plan that names exactly these tasks, in order, with the given edges. */
function mkPlan(entries: Array<[string, string[]]>): BacklogPlan {
  return {
    entries: entries.map(([taskId, dependsOn]) => ({ taskId, dependsOn, reason: null })),
    note: null,
    generatedAt: NOW,
  };
}

const decide = (over: {
  tasks?: Task[];
  sessions?: Session[];
  plan?: BacklogPlan | null;
  cfg?: BacklogConfig;
  unassignable?: ReadonlySet<string>;
}) =>
  decideBacklogTick({
    tasks: over.tasks ?? [],
    sessions: over.sessions ?? [],
    plan: over.plan ?? null,
    cfg: over.cfg ?? CFG,
    now: NOW,
    unassignable: over.unassignable,
  });

test("pipeline tasks never enter backlog autopilot", () => {
  const pipeline = mkTask({ kind: "pipeline" });
  assert.deepEqual(decide({ tasks: [pipeline], plan: mkPlan([[pipeline.id, []]]) }), {
    kind: "none",
    why: "no backlog item allows unattended scheduling",
  });
});

// ---- the switch, and the empty cases -------------------------------------------------

test("autopilot off decides nothing, whatever is waiting", () => {
  const t = mkTask();
  const a = decide({ tasks: [t], cfg: cfg({ enabled: false }) });
  assert.equal(a.kind, "none");
});

test("an empty backlog says so rather than planning nothing", () => {
  const a = decide({ tasks: [mkTask({ status: "done" })] });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /empty/);
});

// ---- planning ------------------------------------------------------------------------

test("a backlog with no plan is READ first, and nothing is scheduled that tick", () => {
  const a = decide({ tasks: [mkTask(), mkTask()], sessions: [] });
  assert.equal(a.kind, "plan");
  assert.equal(a.kind === "plan" ? a.tasks.length : 0, 2);
});

test("a plan that misses one new backlog item is stale - acting on it could start conflicting work", () => {
  const t1 = mkTask();
  const t2 = mkTask();
  const a = decide({ tasks: [t1, t2], plan: mkPlan([[t1.id, []]]) });
  assert.equal(a.kind, "plan");
});

test("a plan that no longer names a DISPATCHED task is still current - a task leaving the backlog invalidates nothing", () => {
  const t1 = mkTask({ status: "running" });
  const t2 = mkTask();
  // Only t2 is in the backlog and only t2 needs an entry.
  const a = decide({ tasks: [t1, t2], plan: mkPlan([[t2.id, []]]) });
  assert.equal(a.kind, "dispatch");
});

test("an oversized backlog is planned to the limit, and that plan is not stale forever", () => {
  // Only the head is read, so asking for coverage of the whole backlog would leave the
  // plan stale the moment it was written - a replan every tick that never schedules
  // anything. The tail falls to "unnamed items go last, oldest first", which is what
  // readyBacklog already does.
  const tasks = Array.from({ length: PLANNABLE_LIMIT + 20 }, () => mkTask());
  const a = decide({ tasks });
  assert.equal(a.kind, "plan");
  assert.equal(a.kind === "plan" ? a.tasks.length : 0, PLANNABLE_LIMIT);

  const covered = mkPlan((a.kind === "plan" ? a.tasks : []).map((t) => [t.id, []]));
  assert.equal(planStale(tasks, covered), false);
  const next = decide({ tasks, plan: covered });
  assert.equal(next.kind, "dispatch");
  assert.equal(next.kind === "dispatch" ? next.task.id : "", tasks[0]!.id);
});

// ---- dependencies --------------------------------------------------------------------

test("an item waiting on an unfinished task is not scheduled; the one it waits for is", () => {
  const first = mkTask();
  const second = mkTask();
  const a = decide({
    tasks: [first, second],
    plan: mkPlan([
      [first.id, []],
      [second.id, [first.id]],
    ]),
  });
  assert.equal(a.kind, "dispatch");
  assert.equal(a.kind === "dispatch" ? a.task.id : "", first.id);
});

test("a dependency that reached done stops blocking", () => {
  const first = mkTask({ status: "done" });
  const second = mkTask();
  const a = decide({
    tasks: [first, second],
    plan: mkPlan([
      [first.id, []],
      [second.id, [first.id]],
    ]),
  });
  assert.equal(a.kind === "dispatch" && a.task.id, second.id);
});

test("a dependency that FAILED keeps blocking - the work it was to lay never happened", () => {
  const first = mkTask({ status: "failed" });
  const second = mkTask();
  const a = decide({
    tasks: [first, second],
    plan: mkPlan([
      [first.id, []],
      [second.id, [first.id]],
    ]),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /waiting on another task/);
});

test("a backlog where everything is blocked says THAT, not 'at capacity'", () => {
  const gone = mkTask({ status: "cancelled" });
  const a = decide({
    tasks: [gone, mkTask(), mkTask()],
    plan: mkPlan([
      [gone.id, []],
      ["t-unused", []],
    ]),
  });
  // Both backlog items depend on the cancelled one.
  const t = [mkTask(), mkTask()];
  const blocked = decide({
    tasks: [gone, ...t],
    plan: mkPlan([
      [t[0]!.id, [gone.id]],
      [t[1]!.id, [gone.id]],
    ]),
  });
  assert.equal(blocked.kind, "none");
  assert.match(blocked.kind === "none" ? blocked.why : "", /waiting on another task/);
  // (the first `a` only exists to prove a stale plan would have short-circuited first)
  assert.equal(a.kind, "plan");
});

// ---- the allowlist -------------------------------------------------------------------

test("a task in an untrusted repo is never scheduled, and is not blamed on dependencies", () => {
  const t = mkTask({ repoRoot: "/elsewhere" });
  const a = decide({ tasks: [t], plan: mkPlan([[t.id, []]]) });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /trusted/);
});

test("an untrusted backlog is never blamed on a dependency graph that is fine", () => {
  // Caught live: with an empty allowlist and one genuinely blocked item out of three,
  // asking "is anything blocked?" first reported "waiting on another task" while the
  // real answer was that Foreman was trusted nowhere - a refusal pointing the operator
  // at the one thing they could not fix.
  const first = mkTask({ repoRoot: "/untrusted" });
  const second = mkTask({ repoRoot: "/untrusted" });
  const a = decide({
    tasks: [first, second],
    plan: mkPlan([
      [first.id, []],
      [second.id, [first.id]],
    ]),
    cfg: cfg({ allowlist: [] }),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /trusted/);
});

test("the blocked count is over TRUSTED items, so it matches the chips on the board", () => {
  const dep = mkTask({ status: "failed" });
  const blocked = mkTask();
  const outOfScope = mkTask({ repoRoot: "/untrusted" });
  const a = decide({
    tasks: [dep, blocked, outOfScope],
    plan: mkPlan([
      [blocked.id, [dep.id]],
      [outOfScope.id, [dep.id]],
    ]),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /\(1 blocked\)/);
});

test("a repo that merely PREFIXES an allowlisted one does not clear the bar", () => {
  const t = mkTask({ repoRoot: "/repo-backup" });
  const a = decide({ tasks: [t], plan: mkPlan([[t.id, []]]) });
  assert.equal(a.kind, "none");
});

// ---- assign vs dispatch --------------------------------------------------------------

test("a free agent in the right repo is preferred over cutting a new worktree", () => {
  const t = mkTask();
  const free = mkSession();
  const a = decide({ tasks: [t], sessions: [free], plan: mkPlan([[t.id, []]]) });
  assert.equal(a.kind, "assign");
  assert.equal(a.kind === "assign" ? a.session.id : "", free.id);
});

test("a multi-repo task is never offered for assignment, and does not park the tick", () => {
  // The livelock this closes. `TaskManager.assign` always refuses a task with attached
  // repos (`scope: "task"`), and that refusal teaches the tick nothing: the worker clears
  // the task from `recentlyActed` on the 409, and `assignRefusalParksSession("task")` is
  // false so the session is not parked either. Offering the pair once means offering it
  // every tick, forever.
  //
  // Worse than looping on itself: the assign search RETURNS on its first match, so the tick
  // would never reach the dispatch fallback - one such task would park the whole backlog.
  // Both halves are asserted here, which is why the free session and the second task are in
  // the input at all.
  const spanning = mkTask({ extraRepos: [{
    repoRoot: "/repo/web",
    worktreePath: null,
    branch: null,
    provider: null,
    worktreeLeaseId: null,
    baseSha: null,
    prUrl: null,
    prState: null,
    mergedAt: null,
  }] });
  const free = mkSession();
  const a = decide({ tasks: [spanning], sessions: [free], plan: mkPlan([[spanning.id, []]]) });

  // Dispatch, not assign: the one path that can actually start it.
  assert.equal(a.kind, "dispatch");
  assert.equal(a.kind === "dispatch" ? a.task.id : "", spanning.id);
});

test("a multi-repo task at the head does not block an assignable item behind it", () => {
  // The blast radius half, stated separately because it is the expensive one: the head is
  // unassignable by construction, and the tick still has to find the item that is not.
  const spanning = mkTask({ extraRepos: [{
    repoRoot: "/repo/web",
    worktreePath: null,
    branch: null,
    provider: null,
    worktreeLeaseId: null,
    baseSha: null,
    prUrl: null,
    prState: null,
    mergedAt: null,
  }] });
  const ordinary = mkTask();
  const free = mkSession();
  const a = decide({
    tasks: [spanning, ordinary],
    sessions: [free],
    plan: mkPlan([[spanning.id, []], [ordinary.id, []]]),
  });

  assert.equal(a.kind, "assign");
  assert.equal(a.kind === "assign" ? a.task.id : "", ordinary.id);
});

test("assignment still happens AT the ceiling - it consumes no new session", () => {
  const t = mkTask();
  const free = mkSession();
  const others = [mkSession({ state: "working" }), mkSession({ state: "working" })];
  const a = decide({
    tasks: [t],
    sessions: [free, ...others],
    plan: mkPlan([[t.id, []]]),
    cfg: cfg({ maxSessions: 1 }),
  });
  assert.equal(a.kind, "assign");
});

test("a later ready item with a home wins over launching a worktree for the head", () => {
  const head = mkTask({ repoRoot: "/other-repo" });
  const later = mkTask();
  const free = mkSession();
  const a = decide({
    tasks: [head, later],
    sessions: [free],
    plan: mkPlan([
      [head.id, []],
      [later.id, []],
    ]),
    cfg: cfg({ allowlist: ["/repo", "/other-repo"] }),
  });
  assert.equal(a.kind, "assign");
  assert.equal(a.kind === "assign" ? a.task.id : "", later.id);
});

test("an idle agent in a DIFFERENT repo is not a home for the task", () => {
  const t = mkTask();
  const elsewhere = mkSession({ cwd: "/other", repoRoot: "/other" });
  const a = decide({
    tasks: [t],
    sessions: [elsewhere],
    plan: mkPlan([[t.id, []]]),
    cfg: cfg({ allowlist: ["/repo", "/other"] }),
  });
  assert.equal(a.kind, "dispatch");
});

test("a codex task is not typed into a claude agent - it launches its own instead", () => {
  // A dispatch honours `task.agent`, so an assign that ignored it would make the same
  // task mean two different things depending on which path won the tick. The board's
  // drag gesture is permissive here on purpose; nobody picked this pane.
  const t = mkTask({ agent: "codex" });
  const wrongHarness = mkSession({ agent: "claude" });
  const a = decide({ tasks: [t], sessions: [wrongHarness], plan: mkPlan([[t.id, []]]) });
  assert.equal(a.kind, "dispatch");
});

test("a codex task IS handed to a free codex agent", () => {
  const t = mkTask({ agent: "codex" });
  const right = mkSession({ agent: "codex", name: "codex-1" });
  const a = decide({ tasks: [t], sessions: [right], plan: mkPlan([[t.id, []]]) });
  assert.equal(a.kind, "assign");
  assert.equal(a.kind === "assign" ? a.session.name : "", "codex-1");
});

// ---- tasks the caller just acted on ---------------------------------------------------

test("a task just acted on is skipped, and the next ready item is taken instead", () => {
  // Head-of-line blocking is the failure here: the machine is deterministic, so parking
  // on the one task whose request we never saw land would stall the whole backlog for
  // as long as the caller remembers it.
  const first = mkTask();
  const second = mkTask();
  const a = decideBacklogTick({
    tasks: [first, second],
    sessions: [],
    plan: mkPlan([
      [first.id, []],
      [second.id, []],
    ]),
    cfg: CFG,
    now: NOW,
    recentlyActed: new Set([first.id]),
  });
  assert.equal(a.kind, "dispatch");
  assert.equal(a.kind === "dispatch" ? a.task.id : "", second.id);
});

test("when every ready item was just acted on, the pause says so", () => {
  const t = mkTask();
  const a = decideBacklogTick({
    tasks: [t],
    sessions: [],
    plan: mkPlan([[t.id, []]]),
    cfg: CFG,
    now: NOW,
    recentlyActed: new Set([t.id]),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /just acted on/);
});

// ---- what counts as free -------------------------------------------------------------

test("an agent that has not settled is not free yet - a pause between turns is not being finished", () => {
  const s = mkSession({ lastActivity: NOW - 1000 });
  assert.equal(agentIsFree(s, [s], [], CFG, NOW), false);
});

test("an UNINSTRUMENTED agent is never handed a task, however idle it looks", () => {
  // reportBucket files it under idle by default; that is right for a readout and wrong
  // for an autopilot, which would have no way to tell it was mid-thought.
  const s = mkSession({ hooksSeen: false, instrumented: false });
  assert.equal(agentIsFree(s, [s], [], CFG, NOW), false);
});

test("an agent with a review waiting on you is not free", () => {
  const s = mkSession({ pendingReviews: 1 });
  assert.equal(agentIsFree(s, [s], [], CFG, NOW), false);
});

test("an agent with an open work queue is already being fed", () => {
  const s = mkSession({
    queue: {
      openCount: 1,
      totalCount: 2,
      inFlightState: "in_progress",
      inFlightIntent: "x",
      round: 0,
      blockingGaps: 0,
      verifiedCount: 0,
      escalatedCount: 0,
      drained: false,
      wrapupAskedAt: null,
      wrapupAnswered: false,
      updatedAt: NOW,
    },
  });
  assert.equal(agentIsFree(s, [s], [], CFG, NOW), false);
});

test("an agent already executing one of our tasks is not free for a second", () => {
  const s = mkSession();
  const running = mkTask({ status: "running", sessionId: s.id });
  assert.equal(agentIsFree(s, [s], [running], CFG, NOW), false);
});

test("an agent in an un-allowlisted checkout is not typed into", () => {
  const s = mkSession({ cwd: "/untrusted", repoRoot: "/untrusted" });
  assert.equal(agentIsFree(s, [s], [], CFG, NOW), false);
});

test("a pane-less agent has nowhere to be typed at", () => {
  const s = mkSession({ terminals: [] });
  assert.equal(agentIsFree(s, [s], [], CFG, NOW), false);
});

// ---- who consented to be given a whole task ------------------------------------------
//
// The strictest clause, and the only one that is about CONSENT rather than readiness.
// Everywhere else in Foreman a non-null invite is enough, because everything else is help
// with work the session is already doing. Assignment starts something new, so approved
// decision 2 reserves it for the sessions Mission Control created.

test("the autopilot only assigns into sessions Mission Control created", () => {
  // One table, because the interesting fact is the BOUNDARY between "operator" and the
  // other two non-null values - a matrix is the only shape that shows it.
  const table = [
    { invite: "sdk", free: true },
    { invite: "dispatch", free: true },
    { invite: "operator", free: false },
    { invite: null, free: false },
  ] as const;
  for (const { invite, free } of table) {
    const s = mkSession({ foremanInvite: invite });
    assert.equal(
      agentIsFree(s, [s], [], CFG, NOW),
      free,
      `foremanInvite ${String(invite)} should ${free ? "" : "not "}be assignable`,
    );
  }
});

test("an operator invite is help with current work, not consent to a new task", () => {
  // The distinction is invisible in `agentIsFree` alone, so it is stated where it bites:
  // the same session that Foreman WILL triage and follow PRs in is one the autopilot must
  // still refuse. Inviting Foreman to help must never drop a fresh task into your pane.
  const helped = mkSession({ foremanInvite: "operator" });
  assert.equal(agentIsFree(helped, [helped], [], CFG, NOW), false);
  const a = decide({
    tasks: [mkTask()],
    sessions: [helped],
    plan: mkPlan([[mkTask().id, []]]),
  });
  assert.notEqual(a.kind, "assign", "an operator-invited session is never selected for a task");
});

test("an uninvited session still counts toward the ceiling", () => {
  // `activeAgentCount` deliberately keeps counting it: the cap is a claim about machine
  // load, not about participation. A personal Claude chat is still a Claude chat burning
  // this laptop's CPU, so it occupies a slot even though nothing may be assigned into it.
  const personal = mkSession({ id: "personal", foremanInvite: null });
  const ours = mkSession({ id: "ours", state: "working" });
  assert.equal(activeAgentCount([personal, ours], []), 2);
});

// ---- work still out for review -------------------------------------------------------
//
// The gap this closes is the one every other clause above misses by design. An agent
// that opened a PR and stopped is idle, settled, instrumented, queue-empty and - once
// its task is marked done - bound to nothing. On every signal the machine had, it was
// free; the only thing saying otherwise was a PR nobody had reviewed yet.

test("an agent whose branch still has an OPEN pr is not free", () => {
  const s = mkSession({ prUrl: "https://x/pr/1", prNumber: 1, prState: "open" });
  assert.equal(agentIsFree(s, [s], [], CFG, NOW), false);
});

test("a MERGED pr does not hold an agent - the work landed", () => {
  // It lingers on the card so you can see the work shipped, which is exactly why the
  // clause has to read `prState` and not `prUrl`.
  const s = mkSession({ prUrl: "https://x/pr/1", prNumber: 1, prState: "merged" });
  assert.equal(agentIsFree(s, [s], [], CFG, NOW), true);
});

test("an open pr stops holding the agent once the operator turns the knob off", () => {
  const s = mkSession({ prUrl: "https://x/pr/1", prNumber: 1, prState: "open" });
  assert.equal(agentIsFree(s, [s], [], cfg({ respectOpenPrs: false }), NOW), true);
});

test("an agent holding an open pr is passed over for a fresh worktree, not skipped", () => {
  // The distinction that matters to the fleet: the TASK is still schedulable. Refusing
  // the agent must cost a worktree, not the item.
  const t = mkTask();
  const busy = mkSession({ prUrl: "https://x/pr/1", prNumber: 1, prState: "open" });
  const a = decide({ tasks: [t], sessions: [busy], plan: mkPlan([[t.id, []]]) });
  assert.equal(a.kind, "dispatch");
  assert.equal(a.kind === "dispatch" ? a.task.id : "", t.id);
});

test("another agent without a pr still takes the task while one holds an open one", () => {
  const t = mkTask();
  const busy = mkSession({ prUrl: "https://x/pr/1", prNumber: 1, prState: "open" });
  const free = mkSession();
  const a = decide({ tasks: [t], sessions: [busy, free], plan: mkPlan([[t.id, []]]) });
  assert.equal(a.kind, "assign");
  assert.equal(a.kind === "assign" ? a.session.id : "", free.id);
});

// ---- a session that has already refused -----------------------------------------------
//
// What is at stake is the whole backlog, not one pairing. An assign refusal is sticky by
// nature - a checkout holding uncommitted work stays that way until a human acts - so a
// machine that kept choosing the same free-looking agent would return the same refused
// action every tick and never reach the dispatch that would have made progress.

test("a session that refused an assign is not offered again", () => {
  const t = mkTask();
  const refused = mkSession();
  const a = decide({
    tasks: [t],
    sessions: [refused],
    plan: mkPlan([[t.id, []]]),
    unassignable: new Set([refused.id]),
  });
  assert.equal(a.kind, "dispatch");
});

test("excluding one refusing session does not exclude the next agent along", () => {
  const t = mkTask();
  const refused = mkSession();
  const other = mkSession();
  const a = decide({
    tasks: [t],
    sessions: [refused, other],
    plan: mkPlan([[t.id, []]]),
    unassignable: new Set([refused.id]),
  });
  assert.equal(a.kind, "assign");
  assert.equal(a.kind === "assign" ? a.session.id : "", other.id);
});

// ---- the ceiling ---------------------------------------------------------------------

test("live sessions and tasks mid-provision are both agents", () => {
  const live = [mkSession(), mkSession({ state: "working" })];
  const provisioning = mkTask({ status: "dispatching" });
  assert.equal(activeAgentCount(live, [provisioning]), 3);
});

test("an exited session is not an agent", () => {
  assert.equal(activeAgentCount([mkSession({ state: "exited" })], []), 0);
});

test("a dispatching task whose session was already discovered is not counted twice", () => {
  const s = mkSession();
  const t = mkTask({ status: "dispatching", sessionId: s.id });
  assert.equal(activeAgentCount([s], [t]), 1);
});

test("the ceiling refuses a launch and says which ceiling it was", () => {
  const t = mkTask();
  const busy = [mkSession({ state: "working" }), mkSession({ state: "working" })];
  const a = decide({
    tasks: [t],
    sessions: busy,
    plan: mkPlan([[t.id, []]]),
    cfg: cfg({ maxSessions: 2 }),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /2\/2/);
});

test("a task still being provisioned holds the slot it is about to fill", () => {
  // The window this closes: dispatch has been accepted, the worktree is being cut, and
  // no session exists yet. Counting sessions alone would launch a second agent here.
  const t = mkTask();
  const inFlight = mkTask({ status: "dispatching" });
  const a = decide({
    tasks: [t, inFlight],
    sessions: [],
    plan: mkPlan([[t.id, []]]),
    cfg: cfg({ maxSessions: 1 }),
  });
  assert.equal(a.kind, "none");
});

// ---- the mode gate -------------------------------------------------------------------

test("dry-run reports the decision it would have taken rather than staying silent", () => {
  const t = mkTask();
  const a = decide({ tasks: [t], plan: mkPlan([[t.id, []]]), cfg: cfg({ mayActLive: false }) });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /would launch/);
});

test("dry-run names the agent it would have handed the task to", () => {
  const t = mkTask();
  const free = mkSession({ name: "spare" });
  const a = decide({
    tasks: [t],
    sessions: [free],
    plan: mkPlan([[t.id, []]]),
    cfg: cfg({ mayActLive: false }),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /would hand.*spare/);
});

// ---- serial fallback -----------------------------------------------------------------

test("when planning has failed its cap the machine schedules anyway, one at a time", () => {
  const t1 = mkTask();
  const t2 = mkTask();
  const a = decide({ tasks: [t1, t2], plan: null, cfg: cfg({ planExhausted: true }) });
  assert.equal(a.kind, "dispatch");
  // Oldest first: with no dependency read, authored order is the only signal left.
  assert.equal(a.kind === "dispatch" ? a.task.id : "", t1.id);
});

test("serial mode launches nothing while a task is still in flight", () => {
  const inFlight = mkTask({ status: "running", homeName: "harness-x" });
  const waiting = mkTask();
  const a = decide({
    tasks: [inFlight, waiting],
    plan: null,
    cfg: cfg({ planExhausted: true }),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /one at a time/);
});

test("serial mode counts a task that is still being provisioned", () => {
  // The window between the dispatch POST answering and the home spawn. The loop skips
  // its sleep after a successful dispatch, so this is the tick that would launch again -
  // and counting only tasks that already hold a terminal home would let it.
  const provisioning = mkTask({ status: "dispatching", homeName: null, sessionId: null });
  const waiting = mkTask();
  const a = decide({
    tasks: [provisioning, waiting],
    plan: null,
    cfg: cfg({ planExhausted: true }),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /one at a time/);
});

test("serial mode holds the ASSIGN path too, not just the launch path", () => {
  // Typing a task into an idle agent starts it exactly as thoroughly as cutting a
  // worktree does, so an assign that skipped the cap would hand out the whole backlog
  // at once - the failure the cap exists to prevent, by the other door.
  const busy = mkSession({ state: "working" });
  const inFlight = mkTask({ status: "running", sessionId: busy.id, homeName: null });
  const waiting = mkTask();
  const free = mkSession();
  const a = decide({
    tasks: [inFlight, waiting],
    sessions: [busy, free],
    plan: null,
    cfg: cfg({ planExhausted: true }),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /one at a time/);
});

// The dead end this fallback used to be, and the reason serial mode is worth having at
// all. A `running` task is only ever reconciled when the DAEMON restarts, so an agent
// whose terminal was closed leaves a row that stays `running` for as long as the daemon
// lives. Counting it meant one dead row parked the entire backlog - not "slow", stopped -
// and the operator's only signal was a board full of ready items and an idle fleet.
test("serial mode does not stall behind a task whose agent is gone", () => {
  const gone = mkTask({ status: "running", sessionId: "s-vanished", homeName: null });
  const waiting = mkTask();
  const a = decide({
    tasks: [gone, waiting],
    sessions: [],
    plan: null,
    cfg: cfg({ planExhausted: true }),
  });
  assert.equal(a.kind, "dispatch");
  assert.equal(a.kind === "dispatch" ? a.task.id : "", waiting.id);
});

test("an exited session does not keep its task in flight either", () => {
  const dead = mkSession({ state: "exited" });
  const gone = mkTask({ status: "running", sessionId: dead.id, homeName: null });
  const waiting = mkTask();
  const a = decide({
    tasks: [gone, waiting],
    sessions: [dead],
    plan: null,
    cfg: cfg({ planExhausted: true }),
  });
  assert.equal(a.kind, "dispatch");
});

// The other half of the same predicate: a task we cut a terminal home for but that
// discovery has not bound yet has NO sessionId to look up, and it is the one case serial
// mode must still hold for - it is the window a sub-second next tick would launch into.
test("serial mode still holds for a task whose agent has not been discovered yet", () => {
  const undiscovered = mkTask({ status: "running", homeName: "harness-x", sessionId: null });
  const waiting = mkTask();
  const a = decide({
    tasks: [undiscovered, waiting],
    sessions: [],
    plan: null,
    cfg: cfg({ planExhausted: true }),
  });
  assert.equal(a.kind, "none");
  assert.match(a.kind === "none" ? a.why : "", /one at a time/);
});

test("a plan that arrives after the cap is used again - exhaustion never sticks to the data", () => {
  const t = mkTask();
  const a = decide({
    tasks: [t],
    plan: mkPlan([[t.id, []]]),
    cfg: cfg({ planExhausted: true }),
  });
  assert.equal(a.kind, "dispatch");
});

// ---- who a refused assign was about ------------------------------------------------------

test("a task-scoped refusal leaves the session assignable", () => {
  // A human dispatching a task between the machine's decision and the worker's request
  // is the ordinary way this happens: the daemon answers "no such task" or "task is
  // running, not in the backlog", both of which are facts about the TASK. Parking the
  // agent for ten minutes over one takes a perfectly free agent off the backlog, so the
  // next item cuts a fresh worktree instead of reusing it.
  assert.equal(assignRefusalParksSession("task"), false);
});

test("a session-scoped refusal parks it, and so does a refusal that will not say", () => {
  // The refusals worth remembering are sticky - a checkout holding uncommitted work, a
  // wedged pane - and retrying them every 4s parks the whole backlog behind one session.
  assert.equal(assignRefusalParksSession("session"), true);
  // An absent scope is a daemon older than the field. The worker is started separately,
  // so a skew between them is an ordinary upgrade-window state, and the wrong answer to
  // fail toward is the one that loops.
  assert.equal(assignRefusalParksSession(undefined), true);
});
