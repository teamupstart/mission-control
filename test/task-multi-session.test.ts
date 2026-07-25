import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mkMuxHandle, mkTask as baseTask } from "./helpers/session-fixture.ts";
import { mkOriginAndClone } from "./helpers/git-fixture.ts";
import { agentIsFree } from "../src/server/foreman/backlog-machine.ts";
import type { BacklogConfig } from "../src/server/foreman/backlog-machine.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { PrMatch } from "../src/server/registry.ts";
import type { ResetResult, Session, Task } from "../src/shared/types.ts";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { SessionTile } from "../src/web/components/layouts/SessionTile.tsx";
import { RailRow } from "../src/web/components/layouts/RailRow.tsx";

const home = mkdtempSync(join(tmpdir(), "mission-task-multi-session-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");
const { setShippingConfig } = await import("../src/server/shipping/config.ts");
const { openDb } = await import("../src/server/db.ts");

/** Every git fixture built here, removed together - they are whole checkouts. */
const roots: string[] = [];

after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * What is at stake: an agent that finished one task and took another.
 *
 * `Task.sessionId` used to be read as if it were a biography - "the task this session
 * runs", for the life of the session. It is not: a session runs tasks SERIALLY, so the
 * field is a pointer at whatever is executing on that agent right now, and it MOVES. Every
 * reader that treated it as 1:1-for-life goes wrong at exactly the same moment - the second
 * assignment - and each goes wrong quietly. The card would keep showing the finished task
 * while the agent works on the next one; a completion drawn from idleness could reopen the
 * FIRST task because the agent is busy with the SECOND; and completion evidence looked up
 * through the session rather than through the task would hand task B task A's pull request.
 *
 * So these pin the model rather than the mechanism: what the pointer means and that it is
 * EXCLUSIVE, that each task's record is its own across a handover, that the four session
 * surfaces follow the CURRENT task, and that "serially" is enforced rather than hoped for -
 * two enforcement points, `agentIsFree` and `TaskManager.assign`.
 */

const CFG: BacklogConfig = {
  enabled: true,
  maxSessions: 3,
  allowlist: [],
  mayActLive: true,
  settleMs: 10_000,
  respectOpenPrs: true,
  planExhausted: false,
};

/** A moment comfortably past the settle window, so `agentIsFree` is about the tasks. */
const LATER = (): number => Date.now() + 60_000;

const BRANCH = "feat/serial-work";

function discovered(id: string, cwd: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "tmux",
    cwd,
    gitBranch: BRANCH,
    gitRoot: cwd,
    repoRoot: cwd,
    nomistakesGated: false,
    pid: 4242,
    tty: "ttys9",
    terminals: [mkMuxHandle({ session: id, windowName: "agent" })],
    startedAt: 0,
  };
}

// Every fixture gets its own session and task ids: they share one database, and a reused
// id would hydrate the previous case's row into the next case's registry - so a test about
// one agent holding nothing would silently be about an agent holding somebody else's task.
let fleetN = 0;

/**
 * One live, idle, instrumented agent in a REAL checkout, already executing task A.
 *
 * A real checkout because the second assignment resets one before it types, and the
 * reset guard refuses a directory that is not a repository - moved onto a fictional path
 * every multi-task case below would stop there and pass without reaching what it is about.
 *
 * Task A owns no worktree of its own, which is what an ASSIGNED task looks like (the agent
 * keeps its own checkout) and is also the only shape that can be followed by a second task
 * on the same agent: a DISPATCHED task holds a worktree and a terminal home, and `assign`
 * refuses to reuse an agent still holding another task's resources until Clean up frees them.
 */
function fleet(prefix: string) {
  const { root, clone } = mkOriginAndClone(prefix);
  roots.push(root);
  const n = ++fleetN;
  const sessionId = `agent-${n}`;
  const taskA = `task-a-${n}`;
  const taskB = `task-b-${n}`;
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const agentSessionId = `episode-${n}`;
  registry.applyDiscovery([discovered(sessionId, clone)]);
  // Discovery alone leaves a session `working` - a bare `ps` sweep cannot know better - so
  // the agent is driven idle through the same hook a real one fires when it finishes a turn.
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd: clone,
    transcriptPath: null,
    env: {},
  });
  assert.equal(registry.getSession(sessionId)?.state, "idle", "fixture must actually be idle");

  registry.upsertTask(baseTask({
    id: taskA,
    title: "Ship A",
    status: "running",
    sessionId,
    repoRoot: clone,
  }));
  registry.bindTaskToWorkEpisode(taskA, sessionId);
  return {
    registry,
    tasks,
    sessionId,
    taskA,
    taskB,
    clone,
    cfg: { ...CFG, allowlist: [clone] },
  };
}

type Fleet = ReturnType<typeof fleet>;

function prMatch(f: Fleet, url: string, over: Partial<PrMatch> = {}): PrMatch {
  const episode = f.registry.workEpisodeForSession(f.sessionId)!;
  return {
    url,
    number: 1,
    state: "open",
    checks: "passing",
    branch: BRANCH,
    agentSessionId: episode.agentSessionId,
    episodeId: episode.episodeId,
    createdAt: episode.startedAt,
    mergedAt: null,
    headSha: "head",
    worktreeHeadSha: "head",
    ...over,
  };
}

/**
 * Open a pull request on the agent's CURRENT episode and then merge it, through the real
 * poller both times - so the merge is recorded against the episode's binding exactly as a
 * live session's merge is, rather than by writing the row this is supposed to be testing.
 */
async function openThenMerge(f: Fleet, url: string): Promise<void> {
  const open = prMatch(f, url);
  await pollAndReconcilePrs(f.registry, async () => open, async () => null);
  const merged = prMatch(f, url, { state: "merged", mergedAt: Date.now() });
  await pollAndReconcilePrs(f.registry, async () => merged, async () => null);
}

/** A pane that says yes: the fixture holds a handle, but no pane to actually read back. */
const paneReady = async (): Promise<{ ok: boolean }> => ({ ok: true });

/** A reset that landed AND was seen to clear the agent - the handover this file assumes. */
const cleanReset = async (): Promise<ResetResult> => ({
  ok: true,
  error: null,
  root: null,
  cleared: true,
  detached: true,
});

/** Hand `task` to the fixture's agent the way the board's drag gesture does. */
async function assign(f: Fleet, task: Partial<Task>) {
  f.registry.upsertTask(baseTask({ repoRoot: f.clone, ...task }));
  return f.tasks.assign(String(task.id), f.sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    rename: async () => ({ ok: true }),
    confirmReset: true,
  });
}

// ---- the model ------------------------------------------------------------------------

test("an agent that finished one task takes the next, and each keeps its own provenance", async () => {
  // The headline flow, end to end: task A merges and lands through the completion path
  // (Phase 2's), which is what frees the agent; the SAME agent then takes task B; and B's
  // completion is decided from B's own pull request. The two tasks share a session id over
  // the session's life and share nothing else.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("mission-multi-serial-");
  const urlA = "https://github.com/example/repo/pull/500";
  const urlB = "https://github.com/example/repo/pull/501";

  // While A is executing, the agent is not free - that clause IS the serial invariant.
  assert.equal(
    agentIsFree(f.registry.getSession(f.sessionId)!, [], f.registry.listTasks(), f.cfg, LATER()),
    false,
    "an agent with a running task is not free",
  );

  await openThenMerge(f, urlA);

  const a = f.registry.getTask(f.taskA)!;
  assert.equal(a.status, "done", "the merged task lands while its agent is idle");
  assert.equal(a.outcomeUrl, urlA);
  // A terminal row KEEPS the pointer until the agent takes its next task - that is the
  // recorded rule, and it is what lets the card go on showing the outcome just produced.
  assert.equal(a.sessionId, f.sessionId);
  assert.equal(
    f.registry.getSession(f.sessionId)?.task?.id,
    f.taskA,
    "and the card still shows it",
  );

  // The completion is what frees the agent: nothing non-terminal is bound to it any more.
  assert.equal(
    agentIsFree(f.registry.getSession(f.sessionId)!, [], f.registry.listTasks(), f.cfg, LATER()),
    true,
    "a finished agent is eligible for its next task",
  );

  const assigned = await assign(f, { id: f.taskB, title: "Ship B" });
  assert.equal(assigned.ok, true, assigned.error ?? "");

  const b = f.registry.getTask(f.taskB)!;
  assert.equal(b.status, "running");
  assert.equal(b.sessionId, f.sessionId, "the pointer moved onto B");
  assert.equal(
    f.registry.getTask(f.taskA)?.sessionId,
    null,
    "and off A - a session names at most one task at a time",
  );
  assert.equal(
    f.registry.getTask(f.taskA)?.status,
    "done",
    "the pointer moving is not a status change",
  );

  // B's binding is B's own: the handover rotated the session's work identity, so the
  // episode B is bound to is not the one A shipped from, and the pull request recorded
  // against it is B's.
  const bindingB = f.registry.workEpisodeForTask(f.taskB)!;
  assert.equal(bindingB.sessionId, f.sessionId);
  assert.equal(bindingB.prUrl, null, "B has opened nothing yet - A's pull request is not its");

  await openThenMerge(f, urlB);

  const landedB = f.registry.getTask(f.taskB)!;
  assert.equal(landedB.status, "done");
  assert.equal(landedB.outcomeUrl, urlB, "B's completion reads B's pull request, never A's");
  assert.equal(f.registry.getTask(f.taskA)?.outcomeUrl, urlA, "and A's outcome is untouched");
});

test("a second task cannot be assigned while the first is still running", async () => {
  // The serial invariant, server-side. `agentIsFree` refuses the autopilot's selection, but
  // a session can pick up a task between that decision and the POST that acts on it - and
  // the manual drag gesture never asked `agentIsFree` at all. Landing a second live task on
  // one agent does not merely double-book it: the exclusive pointer would silently unbind
  // the first, leaving it `running` with nothing left that could ever settle it.
  const f = fleet("mission-multi-refuse-");
  const res = await assign(f, { id: f.taskB, title: "Ship B" });

  assert.equal(res.ok, false);
  assert.equal(res.scope, "session");
  assert.match(res.error ?? "", /already running Ship A - it takes one task at a time/);
  assert.equal(f.registry.getTask(f.taskB)?.status, "backlog", "B stays droppable");
  assert.equal(f.registry.getTask(f.taskA)?.sessionId, f.sessionId, "A keeps its agent");
  assert.equal(f.registry.getTask(f.taskA)?.status, "running");
});

test("one session can name only one task, and the pointer moves rather than multiplying", () => {
  // The pointer's exclusivity, at the layer that actually guarantees it. `activeTaskFor`
  // reads `Task.sessionId` without deduplicating, and it is entitled to: `idx_tasks_session`
  // is a partial UNIQUE index, so a second row naming the same session is not a state the
  // reader has to cope with - it is one the database refuses outright. Worth a test rather
  // than a comment, because "the card follows the current task" rests on it and the index
  // sits three thousand lines away in another file.
  const f = fleet("mission-multi-pick-");
  f.registry.upsertTask(baseTask({
    id: f.taskB,
    title: "Ship B",
    status: "running",
    repoRoot: f.clone,
  }));
  assert.throws(
    () =>
      openDb()
        .prepare(`UPDATE tasks SET session_id = ? WHERE id = ?`)
        .run(f.sessionId, f.taskB),
    /UNIQUE constraint failed: tasks.session_id/,
  );

  // Which is why writing the pointer onto B is what takes it OFF A - one statement, not a
  // race between two rows either of which the card might have drawn.
  f.registry.upsertTask({ ...f.registry.getTask(f.taskB)!, sessionId: f.sessionId });
  assert.equal(f.registry.getTask(f.taskA)?.sessionId, null);
  assert.equal(f.registry.getSession(f.sessionId)?.task?.id, f.taskB);
  assert.equal(f.registry.getSession(f.sessionId)?.task?.title, "Ship B");
});

test("a task settled before the handover keeps the outcome it was settled with", async () => {
  // What the pointer moving must NOT disturb. The handover rotates the session's work
  // identity, which drops the bindings that session held - so a task that had already been
  // settled has to be readable from its own row afterwards, and it is: `complete` records
  // the outcome there, and nothing in the handover rewrites a task it is not handing over.
  //
  // The unsettled case is a known gap rather than a claim this file makes: a task whose
  // pull request merges only AFTER its session's identity rotated has no binding left to
  // read it from - see `invalidateTaskOwnershipInTransaction`.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("mission-multi-settled-");
  const url = "https://github.com/example/repo/pull/510";
  await openThenMerge(f, url);
  assert.equal(f.registry.getTask(f.taskA)?.status, "done");

  const assigned = await assign(f, { id: f.taskB, title: "Ship B" });
  assert.equal(assigned.ok, true, assigned.error ?? "");

  const a = f.registry.getTask(f.taskA)!;
  assert.equal(a.status, "done", "still done");
  assert.equal(a.outcomeUrl, url, "still pointing at the work that landed");
  assert.equal(a.sessionId, null, "and no longer claiming an agent that has moved on");
});

test("all four session surfaces show the task being executed after a second assignment", async () => {
  // The layout-parity rule: a session is drawn by FOUR components, and only one of them is
  // SessionCard. They all read `Session.task`, so the fix lives in the registry rather than
  // in any of them - which is exactly the claim worth pinning, because a change made in the
  // card alone would look right in one layout of three.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("mission-multi-surfaces-");
  // A carries a recurring-mission origin and B a different one, because the rail is the one
  // surface with no room for a task title: it draws the task ONLY through its schedule-origin
  // glyph, so distinct origins are what make "the rail followed B" an observable fact.
  f.registry.upsertTask({
    ...f.registry.getTask(f.taskA)!,
    scheduleId: "sched-a",
    scheduleOccurrenceId: "occ-a",
  });
  await openThenMerge(f, "https://github.com/example/repo/pull/502");
  const assigned = await assign(f, {
    id: f.taskB,
    title: "Ship B",
    scheduleId: "sched-b",
    scheduleOccurrenceId: "occ-b",
  });
  assert.equal(assigned.ok, true, assigned.error ?? "");

  const session = f.registry.getSession(f.sessionId)!;
  assert.equal(session.task?.id, f.taskB, "the summary the four surfaces read");

  const card = renderToStaticMarkup(
    createElement(SessionCard, { session, gateNeedsYou: false, onOpenReviews: () => {} }),
  );
  const detail = renderToStaticMarkup(
    createElement(ConsoleDetail, { session, view: viewFor(session) }),
  );
  const tile = renderToStaticMarkup(
    createElement(SessionTile, {
      session,
      gateNeedsYou: false,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
      onDropConfirm: () => {},
    }),
  );
  const rail = renderToStaticMarkup(
    createElement(RailRow, { session, selected: false, gateNeedsYou: false, onSelect: () => {} }),
  );

  for (const [name, html] of [["card", card], ["console detail", detail], ["board tile", tile]] as const) {
    assert.ok(html.includes("Ship B"), `${name} should show the task now executing`);
    assert.ok(!html.includes("Ship A"), `${name} should not show the finished task`);
  }
  assert.ok(rail.includes("sched-b"), "the rail's task glyph should follow the current task");
  assert.ok(!rail.includes("sched-a"), "and not the finished one's");
});

test("an agent working on its second task cannot reopen the first", async () => {
  // `reopenIfWorkResumed` undoes a completion INFERRED from idleness, on the evidence that
  // the agent is working on that very task again. Once the agent has moved on, that evidence
  // is about the new task: resurrecting the finished one would double-book the agent, and
  // the exclusive pointer would then unbind whichever row was written second.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("mission-multi-reopen-");
  const urlA = "https://github.com/example/repo/pull/503";
  await openThenMerge(f, urlA);
  assert.equal(f.registry.getTask(f.taskA)?.status, "done");

  const assigned = await assign(f, { id: f.taskB, title: "Ship B" });
  assert.equal(assigned.ok, true, assigned.error ?? "");

  // The agent starts working - on B, though nothing in the event says which.
  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: f.registry.getSession(f.sessionId)!.agentSessionId!,
    cwd: f.clone,
    transcriptPath: null,
    prompt: "carry on",
    env: {},
  });
  assert.equal(f.registry.getSession(f.sessionId)?.state, "working", "the agent is working again");

  assert.equal(f.registry.getTask(f.taskA)?.status, "done", "A stays done");
  assert.equal(f.registry.getTask(f.taskA)?.outcomeUrl, urlA, "with its outcome intact");
  assert.equal(f.registry.getTask(f.taskB)?.status, "running", "and B is the one being run");
});

test("a completion drawn from idleness is still reversible while it is the current task", async () => {
  // The other half of the rule above, and the reason the guard has to be about the SESSION
  // having moved on rather than about the task being terminal: with no second task, an agent
  // that starts working again is contradicting the inference, and the completion is undone.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("mission-multi-reopen-live-");
  await openThenMerge(f, "https://github.com/example/repo/pull/504");
  assert.equal(f.registry.getTask(f.taskA)?.status, "done");

  f.registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: f.registry.getSession(f.sessionId)!.agentSessionId!,
    cwd: f.clone,
    transcriptPath: null,
    prompt: "one more thing",
    env: {},
  });

  const a = f.registry.getTask(f.taskA)!;
  assert.equal(a.status, "running", "the idleness inference is undone");
  assert.equal(a.outcomeUrl, null);
});

test("the autopilot counts a finished agent as free and a re-tasked one as busy", async () => {
  // `agentIsFree` filters on STATUS, not on the bare pointer, and both directions matter: a
  // terminal row that still names its session must not retire the agent, and the moment it
  // takes another task it has to stop being offered work again.
  setShippingConfig({ closeSessionAfterMerge: false });
  const f = fleet("mission-multi-free-");
  await openThenMerge(f, "https://github.com/example/repo/pull/505");
  const finished = f.registry.getSession(f.sessionId)!;
  assert.equal(f.registry.getTask(f.taskA)?.sessionId, f.sessionId, "still named by the row");
  assert.equal(agentIsFree(finished, [], f.registry.listTasks(), f.cfg, LATER()), true);

  const assigned = await assign(f, { id: f.taskB, title: "Ship B" });
  assert.equal(assigned.ok, true, assigned.error ?? "");
  const busy = f.registry.getSession(f.sessionId)!;
  assert.equal(agentIsFree(busy, [], f.registry.listTasks(), f.cfg, LATER()), false);
});

/** The console/board detail's props, none of which this file exercises. */
function viewFor(session: Session): SessionViewProps {
  return {
    sessions: [session],
    tasks: [],
    backlog: [],
    onEditTask: () => {},
    backlogPlan: null,
    gateAlerts: new Set<string>(),
    selectedId: session.id,
    consoleZone: "rail",
    onConsoleZoneChange: () => {},
    onSelect: () => {},
    onDeselect: () => {},
    expandedId: null,
    onToggleExpand: () => {},
    onOpenReviews: () => {},
    onOpenDiff: () => {},
    onOpenFiles: () => {},
    onOpenFile: () => false,
    fileTabRequest: null,
    conversationTabRequest: null,
    diffTabRequest: null,
    files: {} as SessionFilesController,
    onReset: () => {},
    onComplete: () => {},
    onKill: () => {},
    onKilled: () => {},
    resetNonces: {},
    registerEl: () => {},
    registerActions: () => {},
    registerDetailScroll: () => {},
    registerReaderTab: () => {},
    renamingId: null,
    onRenameStart: () => {},
    onRenameClose: () => {},
    foremanMode: "dry-run",
    foremanEnabled: false,
    foremanAllowlist: [],
    inputReviewBySession: new Map<string, string>(),
    pendingReviewIds: new Set<string>(),
    onOpenSchedule: () => {},
    scheduleNameById: new Map<string, string>(),
  };
}
