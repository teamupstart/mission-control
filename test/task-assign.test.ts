import { test, after } from "node:test";
import { mkMuxHandle, mkTask as baseTask } from "./helpers/session-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import { writeMcpFixture } from "./helpers/mcp-fixture.ts";
import type { ResetResult, Task } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { muxHandle } from "../src/shared/pane.ts";

// Throwaway state dir, set before anything reads config - see tasks-db.test.ts.
const home = mkdtempSync(join(tmpdir(), "mission-assign-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { MISSION_MCP_TOOLS } = await import("../src/server/mission-mcp.ts");

/** Every git fixture this file built, removed together - they are whole checkouts. */
const roots: string[] = [];

after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/**
 * Assigning a backlog task to an agent that is ALREADY running - what the board's
 * drag-onto-an-idle-agent gesture calls.
 *
 * The refusals are the point. Assign is the one path that types a prompt into a
 * session the harness did not launch, very often the operator's own, so every way it
 * can pick the wrong target has to be a refusal rather than a best effort.
 */

/** The shared task fixture with this file's defaults on top. */
const mkTask = (over: Partial<Task> = {}): Task =>
  baseTask({ ...over });

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "agent",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: null,
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 0,
    ...over,
  };
}

/**
 * A registry holding one IDLE agent in /repo, plus a TaskManager over it.
 *
 * Discovery alone leaves a session `working` (a bare `ps` sweep can't know better), so
 * the agent is driven idle through the same hook a real one fires when it finishes a
 * turn. Without this every case below would stop at the busy check and pass without
 * ever reaching the rule it means to test.
 */
let agentN = 0;

function setup(session: Partial<DiscoveredSession> = {}) {
  const r = new Registry();
  const disc = mkDiscovered(session);
  // A fresh agent session id per fixture, because the work queue is stored against it -
  // reusing one would hand the next fixture the previous test's queue, on real rows in
  // a real database, and a case about an agent holding nothing would silently be about
  // an agent holding two things.
  const agentSessionId = `agent-${++agentN}`;
  r.applyDiscovery([disc]);
  r.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: agentSessionId,
    cwd: disc.cwd,
    transcriptPath: null,
    env: {},
  });
  const live = r.snapshot().sessions[0]!;
  assert.equal(live.state, "idle", "fixture must actually be idle");
  return { r, tasks: new TaskManager(r), sessionId: live.id, agentSessionId };
}

test("a task that isn't in the backlog is refused", async () => {
  const { r, tasks, sessionId } = setup();
  r.upsertTask(mkTask({ status: "running" }));
  const res = await tasks.assign("t1", sessionId);
  assert.equal(res.ok, false);
  assert.match(res.error!, /not in the backlog/);
});

test("a pipeline task cannot be typed into an existing harness session", async () => {
  const { r, tasks, sessionId } = setup();
  r.upsertTask(mkTask({ kind: "pipeline", title: "Run the release pipeline" }));
  const res = await tasks.assign("t1", sessionId);
  assert.equal(res.ok, false);
  assert.match(res.error!, /must be dispatched.*pipeline provider/);
  assert.equal(res.scope, "task");
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("an unknown task or session is refused rather than half-applied", async () => {
  const { r, tasks, sessionId } = setup();
  r.upsertTask(mkTask());
  assert.equal((await tasks.assign("nope", sessionId)).ok, false);
  const res = await tasks.assign("t1", "no-such-session");
  assert.equal(res.ok, false);
  assert.match(res.error!, /no such session/);
  // Neither attempt may have moved the task out of the backlog.
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("a reset task retaining resources blocks replacement work", async () => {
  const { r, tasks, sessionId } = setup();
  r.upsertTask(mkTask({
    id: "old-task",
    title: "Old task",
    status: "running",
    sessionId,
    repoRoot: "/repo",
    worktreePath: "/repo",
    branch: "harness/old-task",
    provider: "git",
    homeName: "agent",
  }));
  r.bindTaskToWorkEpisode("old-task", sessionId);
  r.resetWorkEpisode(sessionId);
  r.upsertTask(mkTask({ id: "replacement", repoRoot: "/repo" }));
  let resetCalled = false;
  let injected = false;

  const res = await tasks.assign("replacement", sessionId, {
    paneReady,
    reset: async () => {
      resetCalled = true;
      return cleanReset();
    },
    inject: async () => {
      injected = true;
      return { ok: true, pasted: true, submitVerified: true };
    },
  });

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /clean up.*before reusing/);
  assert.equal(resetCalled, false);
  assert.equal(injected, false);
  assert.equal(r.getTask("replacement")?.status, "backlog");
  assert.equal(r.getTask("old-task")?.status, "cancelled");
  assert.equal(r.getTask("old-task")?.worktreePath, "/repo");
  assert.equal(r.getTask("old-task")?.homeName, "agent");
});

test("a busy agent is refused - the prompt would land mid-turn", async () => {
  const { r, tasks, agentSessionId } = setup();
  r.upsertTask(mkTask());
  // Back to working: the agent picked something up between the hover and the drop,
  // which is exactly the race the server-side re-check exists for.
  r.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: agentSessionId,
    cwd: "/repo",
    transcriptPath: null,
    env: {},
    prompt: "something else",
  });
  const live = r.snapshot().sessions[0]!;
  assert.equal(live.state, "working");
  const res = await tasks.assign("t1", live.id);
  assert.equal(res.ok, false);
  assert.match(res.error!, /drop onto an idle one/);
  assert.equal(r.getTask("t1")?.status, "backlog");
});


test("passively confirmed idle cannot bypass the live-hook handover gate", async () => {
  const r = new Registry();
  const disc = mkDiscovered({
    agent: "codex",
    terminals: [mkMuxHandle({ session: "codex", windowName: "agent", paneId: "%9" })],
  });
  r.applyDiscovery([disc]);
  r.applyPassiveActivity(r.getSession(disc.syntheticId)!, {
    state: "idle",
    lastActivity: Date.now(),
  });
  r.applyDiscovery([disc]);
  const live = r.getSession(disc.syntheticId)!;
  assert.equal(live.state, "idle");
  assert.equal(live.stateConfirmed, true);
  assert.equal(live.instrumented, false);

  r.upsertTask(mkTask());
  let probedPane = false;
  let reset = false;
  const res = await new TaskManager(r).assign("t1", live.id, {
    paneReady: async () => {
      probedPane = true;
      return { ok: true };
    },
    reset: async () => {
      reset = true;
      return cleanReset();
    },
  });

  assert.equal(res.ok, false);
  assert.match(res.error!, /live hook instrumentation/);
  assert.equal(probedPane, false);
  assert.equal(reset, false);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("an agent in a different repo is refused - the one unrecoverable mistake", async () => {
  // Typing a task's intent at an agent sitting in someone else's checkout is not
  // something the operator can undo from the dashboard, so it is never best-efforted.
  const { r, tasks, sessionId } = setup({ repoRoot: "/other", gitRoot: "/other", cwd: "/other" });
  r.upsertTask(mkTask({ repoRoot: "/repo" }));
  const res = await tasks.assign("t1", sessionId);
  assert.equal(res.ok, false);
  assert.match(res.error!, /different repo/);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("an agent with no repo at all is refused", async () => {
  const { r, tasks, sessionId } = setup({ repoRoot: null, gitRoot: null, cwd: "/tmp" });
  r.upsertTask(mkTask());
  assert.equal((await tasks.assign("t1", sessionId)).ok, false);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

/**
 * The same fixture over a REAL checkout, which the reset in `assign` needs.
 *
 * `setup()`'s `/repo` is a path that does not exist, so every case above stops at the
 * reset guard - fine for those, since they are all asserting an EARLIER refusal. Any
 * test that means to reach the pane has to hand `assign` a directory git can answer
 * questions about, or it passes for the wrong reason.
 */
function setupInRepo(prefix: string, over: Partial<DiscoveredSession> = {}) {
  const { root, clone } = mkOriginAndClone(prefix);
  roots.push(root);
  return { clone, ...setup({ cwd: clone, gitRoot: clone, repoRoot: clone, ...over }) };
}

/** The same, hosted on a tmux session - the handle a rename actually moves. */
function setupOnTmux(prefix: string, session: string) {
  return setupInRepo(prefix, {
    name: session,
    nameSource: "tmux",
    terminals: [mkMuxHandle({ session, windowName: "agent" })],
  });
}

/**
 * A pane that says yes to the readiness probe. The fixture sessions hold no terminal
 * handle, so the real probe refuses them BEFORE the reset - which is the point of the
 * probe, and the reason every case that means to reach the reset has to stub it.
 */
const paneReady = async (): Promise<{ ok: boolean }> => ({ ok: true });

/**
 * A reset that landed AND was seen to clear the agent. Stubbed wherever the case is
 * about what happens after the handover: the real one sends `/clear` to a pane these
 * fixtures do not have, so it can never report the clear confirmed - which is itself
 * pinned, below.
 */
const cleanReset = async (): Promise<ResetResult> => ({
  ok: true,
  error: null,
  root: null,
  cleared: true,
  detached: true,
});

test("a parked task can still be assigned manually, when the caller says so", async () => {
  // The drag-onto-an-idle-agent gesture, which claims the override the same way the
  // launch button does. The hold is on the autopilot; a human dropping a card on a pane
  // has said everything that needs saying.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-disabled-");
  r.upsertTask(mkTask({ repoRoot: clone, enabled: false }));

  const manual = await tasks.assign("t1", sessionId, {
    overrideDisabled: true,
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
  });
  assert.equal(manual.ok, true);
  assert.equal(r.getTask("t1")?.status, "running");
});

test("a parked task is NOT assigned to a caller that claims nothing", async () => {
  // The same call with the flag left off - which is what a Foreman worker predating the
  // toggle sends. It is refused before the session is even looked at, and critically
  // before `assignReserved` types anything into that agent's pane.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-disabled-off-");
  r.upsertTask(mkTask({ repoRoot: clone, enabled: false }));

  let typed = false;
  const refused = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => {
      typed = true;
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error ?? "", /disabled/);
  assert.equal(typed, false, "nothing may be typed into the agent");
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("a pane that cannot take a prompt is refused BEFORE the agent is touched", async () => {
  // The fixture session has neither a tmux nor a wezterm handle, so the readiness probe
  // refuses it. The ordering is what is pinned here: this used to be discovered only
  // after the reset had detached the checkout, dropped the work queue and cleared the
  // agent's context - stripping an agent for a task that then went straight back to the
  // backlog. Nothing may be done to an agent we cannot type into.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-pane-");
  gitIn(clone, "checkout", "-qb", "feature/mine");
  r.upsertTask(mkTask({ repoRoot: clone }));
  const res = await tasks.assign("t1", sessionId);
  assert.equal(res.ok, false);
  const after = r.getTask("t1")!;
  assert.equal(after.status, "backlog");
  assert.equal(after.sessionId, null);
  assert.equal(after.dispatchedAt, null);
  assert.equal(
    gitIn(clone, "rev-parse", "--abbrev-ref", "HEAD"),
    "feature/mine",
    "the checkout must be untouched - nothing was typed, so nothing was reset",
  );
});

test("a retriage made while the prompt is being typed survives the assignment", async () => {
  // Typing into a pane is a real round-trip - a bracketed paste, a settle, a pane read
  // back - and priority and labels stay editable in EVERY status, so a retriage can
  // land inside that window. Merging onto the task as it was read before the injection
  // would write the old priority back over the new one, on a gesture that was only
  // meant to hand the task to an agent, with nothing failing to say so.
  //
  // It runs over a REAL checkout because assign resets one before it types: moved back
  // onto `setup()`'s non-existent /repo, the reset guard refuses first and this stops
  // reaching the injection window it exists to pin, with nothing saying so.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-retriage-");
  r.upsertTask(mkTask({ repoRoot: clone, priority: "low", labels: ["infra"] }));
  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => {
      await tasks.update("t1", { priority: "blocker", labels: ["infra", "urgent"] });
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  assert.equal(res.ok, true);
  const after = r.getTask("t1")!;
  assert.equal(after.status, "running", "the assignment still lands");
  assert.equal(after.sessionId, sessionId);
  assert.equal(after.priority, "blocker");
  assert.deepEqual(after.labels, ["infra", "urgent"]);
});

test("dependency edits cannot enter while assignment owns the task", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-dependency-lock-");
  r.upsertTask(mkTask({ id: "lock-pre", repoRoot: clone, title: "Merge first" }));
  r.upsertTask(mkTask({ id: "lock-target", repoRoot: clone }));
  let releasePane!: () => void;
  let paneReached!: () => void;
  const atPane = new Promise<void>((resolve) => {
    paneReached = resolve;
  });
  const holdPane = new Promise<void>((resolve) => {
    releasePane = resolve;
  });
  const assigning = tasks.assign("lock-target", sessionId, {
    paneReady: async () => {
      paneReached();
      await holdPane;
      return { ok: true };
    },
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
  });
  await atPane;

  const edit = await tasks.update("lock-target", {
    dependencies: [{ type: "task", taskId: "lock-pre" }],
  });
  assert.equal(edit.ok, false);
  assert.match(edit.error ?? "", /being assigned/);

  releasePane();
  assert.equal((await assigning).ok, true);
  assert.equal(r.getTask("lock-target")?.status, "running");
});

test("assignment revalidates dependencies at the prompt boundary", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-dependency-cas-");
  r.upsertTask(mkTask({ id: "cas-pre", repoRoot: clone, title: "Merge first" }));
  r.upsertTask(mkTask({ id: "cas-target", repoRoot: clone }));
  let injected = false;
  const result = await tasks.assign("cas-target", sessionId, {
    paneReady,
    reset: async () => {
      const target = r.getTask("cas-target")!;
      r.upsertTask({
        ...target,
        dependencies: [
          {
            type: "task",
            taskId: "cas-pre",
            title: "Merge first",
            sessionId: null,
            episodeId: null,
            agentSessionId: null,
            branch: null,
            prUrl: null,
            selectedAt: null,
            satisfiedAt: null,
          },
        ],
      });
      return cleanReset();
    },
    inject: async () => {
      injected = true;
      return { ok: true, pasted: true, submitVerified: true };
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /Merge first/);
  assert.equal(injected, false);
  assert.equal(r.getTask("cas-target")?.status, "backlog");
});

test("a reused session attributes its merged PR only to the current task after restart", async () => {
  const { r, tasks, sessionId, clone, agentSessionId } = setupInRepo(
    "mission-assign-current-binding-",
  );
  r.upsertTask(
    mkTask({
      id: "binding-previous",
      repoRoot: clone,
      title: "Previous task",
      status: "done",
      sessionId,
      dispatchedAt: 1,
      completedAt: 2,
      updatedAt: 2,
    }),
  );
  r.upsertTask(mkTask({ id: "binding-current", repoRoot: clone, title: "Current task" }));
  r.upsertTask(
    mkTask({
      id: "wait-current",
      repoRoot: clone,
      dependencies: [
        {
          type: "task",
          taskId: "binding-current",
          title: "Current task",
          sessionId: null,
          episodeId: null,
          agentSessionId: null,
          branch: null,
          prUrl: null,
          selectedAt: null,
          satisfiedAt: null,
        },
      ],
    }),
  );
  r.upsertTask(
    mkTask({
      id: "wait-previous",
      repoRoot: clone,
      dependencies: [
        {
          type: "task",
          taskId: "binding-previous",
          title: "Previous task",
          sessionId: null,
          episodeId: null,
          agentSessionId: null,
          branch: null,
          prUrl: null,
          selectedAt: null,
          satisfiedAt: null,
        },
      ],
    }),
  );

  const assigned = await tasks.assign("binding-current", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
  });
  assert.equal(assigned.ok, true);
  assert.equal(r.getTask("binding-previous")?.sessionId, null);
  const completed = (await tasks.complete("binding-current", "opened pull request"))!;
  for (let i = 0; i < 60; i++) {
    r.upsertTask(
      mkTask({
        id: `binding-newer-terminal-${i}`,
        repoRoot: clone,
        status: "done",
        completedAt: completed.updatedAt + i + 1,
        updatedAt: completed.updatedAt + i + 1,
      }),
    );
  }
  assert.equal(r.getTask("binding-current"), undefined);

  const restarted = new Registry();
  assert.equal(restarted.getTask("binding-current"), undefined);
  restarted.applyDiscovery([
    mkDiscovered({
      syntheticId: sessionId,
      cwd: clone,
      gitBranch: "feat/current-binding",
      gitRoot: clone,
      repoRoot: clone,
    }),
  ]);
  const currentEpisode = restarted.workEpisodeForSession(sessionId)!;
  restarted.reconcilePrs(
    new Map([
      [
        sessionId,
        {
          url: "https://github.com/example/repo/pull/99",
          number: 99,
          state: "merged" as const,
          checks: "passing" as const,
          branch: "feat/current-binding",
          agentSessionId,
          episodeId: currentEpisode.episodeId,
          createdAt: currentEpisode.startedAt,
          mergedAt: Date.now(),
          headSha: "current-head",
          worktreeHeadSha: "current-head",
        },
      ],
    ]),
    new Set(),
  );

  assert.ok(restarted.getTask("wait-current")?.dependencies[0]?.satisfiedAt);
  assert.equal(restarted.getTask("wait-previous")?.dependencies[0]?.satisfiedAt, null);
});

test("assignment binds only after reset identity is resolved", async () => {
  const { r, tasks, sessionId, clone, agentSessionId } = setupInRepo(
    "mission-assign-late-clear-",
    { gitBranch: "main" },
  );
  r.upsertTask(mkTask({ repoRoot: clone, title: "Assigned after clear" }));

  const assigned = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
  });
  assert.equal(assigned.ok, true, assigned.error);
  const assignedEpisode = r.workEpisodeForSession(sessionId)!;
  assert.equal(assignedEpisode.agentSessionId, agentSessionId);
  assert.equal(assignedEpisode.awaitingAgentRebind, false);
  assert.equal(r.getTask("t1")?.sessionId, sessionId);

  const reboundAgentSessionId = `${agentSessionId}-after-clear`;
  r.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: reboundAgentSessionId,
    cwd: clone,
    transcriptPath: null,
    env: {},
  });
  const reboundEpisode = r.workEpisodeForSession(sessionId)!;
  assert.notEqual(reboundEpisode.episodeId, assignedEpisode.episodeId);
  assert.equal(reboundEpisode.agentSessionId, reboundAgentSessionId);
  assert.equal(reboundEpisode.awaitingAgentRebind, false);
  assert.equal(r.getTask("t1")?.sessionId, null);
});

test("an agent that went busy between the checks and the reset is not reset anyway", async () => {
  // The idle check happens several git invocations before the reset, and the reset
  // itself spends up to 30s in a fetch. An agent a human woke up inside that window
  // must not have its checkout taken apart under them.
  const { r, tasks, sessionId, clone, agentSessionId } = setupInRepo("mission-assign-woke-");
  r.upsertTask(mkTask({ repoRoot: clone }));
  const res = await tasks.assign("t1", sessionId, {
    confirmReset: true,
    reset: cleanReset,
    paneReady: async () => {
      // The human types at their agent while we are still deciding.
      r.applyHook({
        agent: "claude",
        event: "UserPromptSubmit",
        sessionId: agentSessionId,
        cwd: clone,
        transcriptPath: null,
        env: {},
        prompt: "actually, do this instead",
      });
      return { ok: true };
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.error!, /stopped being idle/);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("a /clear the agent was never seen acting on fails the assign rather than claiming it", async () => {
  // `sendText` returns as soon as tmux takes the keystrokes, so a `/clear` processed
  // AFTER the prompt is pasted wipes that prompt off the composer - and the pane read
  // that follows the paste then finds nothing pending and calls it a success. That is a
  // task marked running with nothing running it. Unconfirmed means unassigned.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-unclear-");
  let typed = false;
  r.upsertTask(mkTask({ repoRoot: clone }));
  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: async () => ({ ok: true, error: null, root: clone, cleared: false, detached: true }),
    inject: async () => {
      typed = true;
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  assert.equal(res.ok, false);
  assert.match(res.error!, /clear/);
  assert.equal(typed, false, "the prompt must not be typed behind an unconfirmed /clear");
  assert.equal(r.getTask("t1")?.status, "backlog");
});

// ---- the reset that hands the agent over clean -----------------------------------------
//
// A reused agent keeps its own checkout, so without this it inherits the last task's
// branch and context: the new work stacks onto a change that may still be out for
// review, and a later shipping action seeing a non-default branch can push onto it,
// putting two unrelated tasks in one PR.
//
// The reset is destructive and unattended, which is why the guard in front of it refuses
// rather than proceeding. Nobody confirmed this one.

test("a checkout holding uncommitted work refuses the assign instead of resetting over it", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-dirty-");
  writeFileSync(join(clone, "keep.txt"), "base\nwork in progress\n");
  r.upsertTask(mkTask({ repoRoot: clone }));

  const res = await tasks.assign("t1", sessionId, { paneReady, confirmReset: true });
  assert.equal(res.ok, false);
  assert.match(res.error!, /cannot be reset/);
  assert.equal(res.scope, "session", "the checkout is the agent's problem, not the task's");
  // The refusal has to be the whole story: the task is still droppable, and - the part
  // that would be unrecoverable - the work is still on disk.
  assert.equal(r.getTask("t1")?.status, "backlog");
  assert.equal(readFileSync(join(clone, "keep.txt"), "utf8"), "base\nwork in progress\n");
});

test("a commit that never reached origin is work too, and refuses the same way", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-ahead-");
  writeFileSync(join(clone, "keep.txt"), "base\nshipped locally\n");
  gitIn(clone, "commit", "-qam", "work nobody pushed");
  r.upsertTask(mkTask({ repoRoot: clone }));

  const res = await tasks.assign("t1", sessionId, { paneReady, confirmReset: true });
  assert.equal(res.ok, false);
  assert.match(res.error!, /cannot be reset/);
  assert.equal(gitIn(clone, "log", "-1", "--format=%s"), "work nobody pushed");
});

test("a clean agent is reset onto origin's default branch and released from its own", async () => {
  // The state a recycled agent is actually in: it shipped, the branch is pushed, and it
  // went idle still standing on it. Assign must hand the next task a checkout that looks
  // like a freshly dispatched one - on origin's commit, holding no branch.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-clean-");
  gitIn(clone, "checkout", "-qb", "feature/shipped");
  const originHead = gitIn(clone, "rev-parse", "origin/main");

  r.upsertTask(mkTask({ repoRoot: clone }));
  // Confirmed, because releasing that branch is a loss the drop has to be told about -
  // see the confirmation cases below. The REAL reset runs here, which is the point.
  const res = await tasks.assign("t1", sessionId, { paneReady, confirmReset: true });

  assert.equal(gitIn(clone, "rev-parse", "HEAD"), originHead);
  // `--abbrev-ref` answers the literal string "HEAD" on a detached checkout, which is
  // the state a pooled worktree is handed out in.
  assert.equal(
    gitIn(clone, "rev-parse", "--abbrev-ref", "HEAD"),
    "HEAD",
    "the finished branch must be released, or the next task commits onto its PR",
  );
  // These fixtures have no pane, so the `/clear` cannot be sent, let alone confirmed -
  // and an unconfirmed clear stops the assign rather than typing behind it.
  assert.equal(res.ok, false);
  assert.match(res.error!, /clear/);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("assignment does not type before reset identity proof arrives", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-identity-proof-");
  r.upsertTask(mkTask({ repoRoot: clone }));
  let typed = false;

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: async () => ({
      ...(await cleanReset()),
      workIdentityReady: false,
    }),
    inject: async () => {
      typed = true;
      return { ok: true, pasted: true, submitVerified: true };
    },
  });

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /work identity/);
  assert.equal(typed, false);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

// ---- asking before spending what the reset cannot give back ------------------------------
//
// `resetWouldDestroyWork` only covers what git holds. The work queue, the agent's context
// and the branch name are losses origin cannot undo, and the drag gesture used to spend
// all three with no dialog at all - while the identical operation behind the card's reset
// control has a confirm and a loss preview. So the daemon refuses and says what it would
// cost; saying yes is the same POST with the flag set.

test("an agent holding a work queue refuses the drop, and changes nothing while it asks", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-queue-");
  const queues = new QueueManager(r);
  assert.ok(queues.add(sessionId, "finish the migration"), "the fixture must hold a queue");
  gitIn(clone, "checkout", "-qb", "feature/held");
  r.upsertTask(mkTask({ repoRoot: clone }));

  const res = await tasks.assign("t1", sessionId, { paneReady });
  assert.equal(res.ok, false);
  assert.equal(res.scope, "session");
  // The breakdown travels WITH the refusal, so the dialog and the action cannot disagree
  // about a queue that moved in between.
  assert.equal(res.resetConfirm?.queuedItems, 1);
  assert.equal(res.resetConfirm?.branch, "feature/held");
  assert.equal(res.resetConfirm?.clearsContext, false, "this fixture has no pane to clear");
  // Nothing may have happened while it was only asking.
  assert.equal(r.getSession(sessionId)?.queue?.openCount, 1, "the queue is intact");
  assert.equal(r.getTask("t1")?.status, "backlog");
  assert.equal(gitIn(clone, "rev-parse", "--abbrev-ref", "HEAD"), "feature/held");
});

test("the same drop with the confirmation goes through", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-queue-yes-");
  const queues = new QueueManager(r);
  assert.ok(queues.add(sessionId, "finish the migration"));
  r.upsertTask(mkTask({ repoRoot: clone }));

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    confirmReset: true,
  });
  assert.equal(res.ok, true);
  assert.equal(r.getTask("t1")?.status, "running");
});

test("a clean, queue-less agent takes the drop with no confirmation at all", async () => {
  // The gesture must stay one gesture where there is nothing to lose: a pooled worktree
  // is handed out detached with an empty queue, which is exactly this shape.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-nothing-");
  gitIn(clone, "checkout", "-q", "--detach");
  r.upsertTask(mkTask({ repoRoot: clone }));

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
  });
  assert.equal(res.ok, true, res.error);
  assert.equal(res.resetConfirm, undefined);
  assert.equal(r.getTask("t1")?.status, "running");
});

/**
 * The handover renames the terminal, so a reused agent is titled by its work the way a
 * freshly dispatched one is.
 *
 * The bug this pins: a backlog item scheduled onto an idle agent left the card reading
 * whatever the agent was called before - the pooled worktree it was handed out as, or the
 * task it finished ten minutes ago - while it ran something else entirely. Everything else
 * about an assign already says "fresh start" (branch back to origin's default, queue
 * dropped, context cleared); the name was the one thing left behind.
 */
test("a handover names the agent's terminal after the task it just took", async () => {
  const { r, tasks, sessionId, clone } = setupOnTmux("mission-assign-rename-", "pool-worktree-3");
  gitIn(clone, "checkout", "-q", "--detach");
  r.upsertTask(mkTask({ repoRoot: clone, title: "Fix flaky worktree cleanup" }));

  const renamed: Array<{ from: string; to: string }> = [];
  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    rename: async (s, name) => {
      renamed.push({ from: muxHandle(s)!.session, to: name });
      return { ok: true };
    },
  });

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(renamed, [{ from: "pool-worktree-3", to: "Fix flaky worktree cleanup" }]);
  // Applied to the live card too, not just to tmux - the whole point is the board.
  const s = r.getSession(sessionId)!;
  assert.equal(s.name, "Fix flaky worktree cleanup");
  assert.equal(muxHandle(s)?.session, "Fix flaky worktree cleanup");
});

test("a rename that fails does not un-run a task the agent is already working on", async () => {
  // The prompt has been typed by the time the rename is attempted. Failing the assign
  // here would send a task an agent is actively working on back to the backlog, to be
  // handed to a second agent - a far worse outcome than a stale name.
  const { r, tasks, sessionId, clone } = setupOnTmux("mission-assign-rename-fail-", "old-name");
  gitIn(clone, "checkout", "-q", "--detach");
  r.upsertTask(mkTask({ repoRoot: clone, title: "Add dark mode" }));

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    rename: async () => {
      throw new Error("tmux went away");
    },
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(r.getTask("t1")?.status, "running");
  assert.equal(r.getSession(sessionId)?.name, "old-name", "the old name simply stands");
});

test("a name another task's teardown still aims at is not taken", async () => {
  // `Task.homeName` aims the home teardown (`killHome`). Renaming onto a name a task still
  // records - a multiplexer frees a dead session's name for immediate reuse, so this is
  // reachable without any collision among live sessions - would point that task's teardown at this
  // live agent. Answered the way `spawnUniquely` answers it: retry under a unique name.
  const { r, tasks, sessionId, clone } = setupOnTmux("mission-assign-rename-taken-", "old-name");
  gitIn(clone, "checkout", "-q", "--detach");
  r.upsertTask(mkTask({ repoRoot: clone, title: "Ship the thing" }));
  r.upsertTask(
    mkTask({
      id: "t2",
      status: "done",
      homeName: "Ship the thing",
      worktreePath: "/some/other/worktree",
    }),
  );

  const tried: string[] = [];
  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    rename: async (_s, name) => {
      tried.push(name);
      return { ok: true };
    },
  });

  assert.equal(res.ok, true, res.error);
  assert.deepEqual(tried, ["Ship the thing-t1"], "the contested name was never attempted");
  assert.equal(r.getSession(sessionId)?.name, "Ship the thing-t1");
});

test("an agent with no terminal handle is left alone rather than failed", async () => {
  // Its card is named after its process, and there is nothing to rename. The task still
  // lands - a session we cannot title is not a session we refuse work to.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-rename-none-");
  gitIn(clone, "checkout", "-q", "--detach");
  r.upsertTask(mkTask({ repoRoot: clone, title: "Name me" }));

  let called = false;
  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    reset: cleanReset,
    inject: async () => ({ ok: true, pasted: true, submitVerified: true }),
    rename: async () => {
      called = true;
      return { ok: true };
    },
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(called, false);
  assert.equal(r.getSession(sessionId)?.name, "agent");
});

test("a refusal says whether the TASK or the SESSION was the problem", async () => {
  // The autopilot parks a session for ten minutes after a session-scoped refusal. A
  // human dispatching a task between the machine's decision and its request must not
  // cost a perfectly free agent that parking - so a task-scoped refusal says so.
  const { r, tasks, sessionId } = setup();
  r.upsertTask(mkTask({ status: "running" }));
  assert.equal((await tasks.assign("t1", sessionId)).scope, "task");
  assert.equal((await tasks.assign("nope", sessionId)).scope, "task");
  // A backlog task, so the refusal below is about the session and nothing else.
  r.upsertTask(mkTask({ id: "t2" }));
  assert.equal((await tasks.assign("t2", "no-such-session")).scope, "session");
});

test("an assigned task never claims a worktree - cancel must not remove one", () => {
  // The invariant behind the whole feature: an assigned task borrows an agent that
  // already had a checkout, so it owns no worktree. If `worktreePath` were ever set
  // to the agent's own cwd, cancelling the task would run
  // `git worktree remove --force` over a directory the harness did not create - very
  // possibly the operator's real working copy.
  const r = new Registry();
  r.upsertTask(mkTask({ status: "running", sessionId: "sid", dispatchedAt: 2000 }));
  const t = r.getTask("t1")!;
  assert.equal(t.worktreePath, null);
  assert.equal(t.provider, null);
  // And no terminal home of ours, which is what stops `cancel` killing the agent.
  assert.equal(t.homeName, null);
});

test("a task assigned to a session decorates that session's card, with no worktree to match on", () => {
  // Dispatched tasks correlate to their agent by worktree path. An assigned one has
  // none, so it must correlate by session id instead - otherwise the board would
  // show an agent working with no sign of what it was given.
  const r = new Registry();
  r.applyDiscovery([mkDiscovered()]);
  const id = r.snapshot().sessions[0]!.id;
  r.upsertTask(mkTask({ status: "running", sessionId: id, title: "Wire it up" }));
  const s = r.snapshot().sessions.find((x) => x.id === id);
  assert.equal(s?.task?.id, "t1");
  assert.equal(s?.task?.title, "Wire it up");
});

// ---- a scout assigned to an agent that was already running -------------------------------
//
// Assignment types into a LIVE process, so it cannot change what that process's launch
// pre-approved. A scout finishes by calling `submit_scout_artifacts`, and the two things that
// can go wrong here are opposite: handing a scout to an agent that provably cannot submit
// (the bundle is not on this machine), and handing one the report requirement never reached.
// Both are checked before the destructive reset, because after it the agent's checkout, queue
// and context are already gone.

test("a scout is refused before the reset when the MCP bundle cannot be launched", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-scout-nomcp-");
  gitIn(clone, "checkout", "-qb", "feature/mine");
  r.upsertTask(mkTask({ repoRoot: clone, kind: "scout" }));
  let reset = false;

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    confirmReset: true,
    // The one honest question an assignment can ask: is our MCP bundle on this machine at
    // all? Whether THAT process registered it is a property of a launch we did not make.
    missionMcpDescriptor: async () => null,
    reset: async () => {
      reset = true;
      return cleanReset();
    },
  });

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /scout/);
  assert.match(res.error ?? "", /MCP server is not built/);
  assert.equal(reset, false, "nothing may be done to an agent that cannot finish the task");
  assert.equal(r.getTask("t1")?.status, "backlog");
  assert.equal(
    gitIn(clone, "rev-parse", "--abbrev-ref", "HEAD"),
    "feature/mine",
    "the checkout is untouched - the refusal happens before the reset",
  );
});

test("a scout is refused before the reset when the built bundle lacks its submission tool", async () => {
  // The sibling of the refusal above, for the case that reads as a HEALTHY install: the
  // bundle is on this machine, it starts, it answers - it just does not publish
  // `submit_scout_artifacts`, because `dist/mcp/server.mjs` is rebuilt only by
  // `npm run build` and ignored by git, so it sits behind the source that added the tool.
  //
  // Everything below this point strips the agent - detaches its checkout, drops its queue,
  // wipes its context - so admitting it here costs an operator their working tree for a task
  // that provably cannot finish. Existence was the honest question right up until a stale
  // bundle made "present" and "usable" different answers.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-scout-stale-mcp-");
  gitIn(clone, "checkout", "-qb", "feature/mine");
  r.upsertTask(mkTask({ repoRoot: clone, kind: "scout" }));
  let reset = false;

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    confirmReset: true,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "node",
      args: ["server.mjs"],
      env: {},
    }),
    verifyMissionMcpToolsForRunningSession: async () => ({
      ok: false as const,
      reason:
        "Mission Control's MCP server at /dist/mcp/server.mjs does not publish " +
        "submit_scout_artifacts. Run: npm run build",
    }),
    reset: async () => {
      reset = true;
      return cleanReset();
    },
  });

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /scout/);
  assert.match(res.error ?? "", /submit_scout_artifacts/, "name the tool that is missing");
  assert.match(res.error ?? "", /npm run build/, "name the fix");
  assert.equal(reset, false, "nothing may be done to an agent that cannot finish the task");
  assert.equal(r.getTask("t1")?.status, "backlog");
  assert.equal(
    gitIn(clone, "rev-parse", "--abbrev-ref", "HEAD"),
    "feature/mine",
    "the checkout is untouched - the refusal happens before the reset",
  );
});

test("a scout is refused before the reset when the agent predates the current bundle", async () => {
  // The bug a disk-only content check hides. This agent is ALREADY RUNNING: its MCP server is a
  // child it spawned at launch, holding whatever `dist/mcp/server.mjs` contained then. Rebuild
  // the bundle afterwards - which is exactly what an operator does on being told to - and a
  // probe of the file on disk answers perfectly for a process this agent is not using. The
  // assignment would proceed, reset the agent's checkout, and hand it a task it still cannot
  // submit, which is the failure the whole guard exists to prevent.
  //
  // Driven through the REAL check with a real bundle rather than an injected verdict: the claim
  // under test is the ordering of two timestamps, and stubbing it would assert nothing.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-scout-rebuilt-", {
    startedAt: Date.now() - 3_600_000,
  });
  gitIn(clone, "checkout", "-qb", "feature/mine");
  r.upsertTask(mkTask({ repoRoot: clone, kind: "scout" }));
  let reset = false;

  // A complete, healthy bundle - written NOW, so it postdates the agent by an hour. Nothing is
  // wrong with this file; it is simply not the one that agent loaded.
  const prior = process.env.MISSION_MCP_SERVER;
  process.env.MISSION_MCP_SERVER = writeMcpFixture(join(home, "rebuilt-bundle.mjs"), [
    ...MISSION_MCP_TOOLS,
  ]);
  let res;
  try {
    res = await tasks.assign("t1", sessionId, {
      paneReady,
      confirmReset: true,
      reset: async () => {
        reset = true;
        return cleanReset();
      },
    });
  } finally {
    if (prior === undefined) delete process.env.MISSION_MCP_SERVER;
    else process.env.MISSION_MCP_SERVER = prior;
  }

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /rebuilt after this agent started/);
  assert.match(res.error ?? "", /Restart the session/, "the fix is a restart, not another build");
  assert.equal(reset, false, "nothing may be done to an agent that cannot finish the task");
  assert.equal(r.getTask("t1")?.status, "backlog");
  assert.equal(
    gitIn(clone, "rev-parse", "--abbrev-ref", "HEAD"),
    "feature/mine",
    "the checkout is untouched - the refusal happens before the reset",
  );
});

test("a scout is refused before reset when its scoped submission credential cannot be provisioned", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-scout-no-credential-");
  r.upsertTask(mkTask({ repoRoot: clone, kind: "scout" }));
  let reset = false;

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    confirmReset: true,
    missionMcpDescriptor: async () => ({
      serverName: "mission-control",
      command: "node",
      args: ["server.mjs"],
      env: {},
    }),
    // That descriptor names no real bundle, because this test is about the step AFTER the
    // MCP checks. The content guard beside them would refuse to handshake with it - rightly -
    // so it is answered here. `mission-mcp.test.ts` runs the real handshake, and
    // `dispatcher-runtime.test.ts` drives a real stale bundle through a real launch.
    verifyMissionMcpToolsForRunningSession: async () => ({ ok: true as const }),
    provisionScoutCredential: () => {
      throw new Error("credential state is read-only");
    },
    reset: async () => {
      reset = true;
      return cleanReset();
    },
  });

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /could not authorize this scout's submission channel/);
  assert.equal(reset, false);
  assert.equal(r.getTask("t1")?.status, "backlog");
});

test("assigned scout and ship prompts keep intent first and receive the shared authorization", async () => {
  for (const kind of ["scout", "ship"] as const) {
    const { r, tasks, sessionId, clone } = setupInRepo(`mission-assign-${kind}-contract-`);
    r.upsertTask(mkTask({ repoRoot: clone, kind, intent: "look into the resume path" }));
    let typed: string | null = null;
    let credentialScope: { taskId: string; cwd: string } | null = null;

    const res = await tasks.assign("t1", sessionId, {
      paneReady,
      confirmReset: true,
      missionMcpDescriptor: async () => ({
        serverName: "mission-control",
        command: "node",
        args: ["server.mjs"],
        env: {},
      }),
      // As above: a fake bundle, so the content guard is answered rather than pointed at it.
      verifyMissionMcpToolsForRunningSession: async () => ({ ok: true as const }),
      provisionScoutCredential: (taskId, cwd) => {
        credentialScope = { taskId, cwd };
        return "test-credential";
      },
      reset: cleanReset,
      inject: async (_session, prompt) => {
        typed = prompt;
        return { ok: true, pasted: true, submitVerified: true };
      },
    });

    assert.equal(res.ok, true, res.error);
    assert.ok(typed !== null, "the task was typed");
    assert.match(typed!, /^look into the resume path/, "the operator's own words stay first");
    assert.match(typed!, /Mission Control execution authorization/);
    assert.match(typed!, /already authorized you to commit the scoped work/);
    if (kind === "scout") {
      assert.deepEqual(credentialScope, { taskId: "t1", cwd: clone });
      assert.match(typed!, /docs\/reports\/<slug>\/report\.html/);
      assert.match(typed!, /submit_scout_artifacts/);
      assert.match(typed!, /repoSlot: "repo-01"/, "the slot is issued for the session's own checkout");
    } else {
      assert.equal(credentialScope, null);
      assert.doesNotMatch(typed!, /docs\/reports\/<slug>\/report\.html/);
    }
  }
});

// A plan's contract POINTS AT the two planning skills rather than restating them, so the
// question this seam has to answer is not "is a bundle on this machine" but "could THIS
// conversation load them". Both are asked before the destructive reset, for the same reason.

test("a plan is refused before the reset when its planning skills cannot be invoked", async () => {
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-plan-noskill-");
  gitIn(clone, "checkout", "-qb", "feature/mine");
  r.upsertTask(mkTask({ repoRoot: clone, kind: "plan" }));
  let reset = false;
  let typed = false;

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    confirmReset: true,
    requirePlanSkills: () => ({
      ok: false,
      message:
        "Enable Skills and the html-plans skill before sending this instruction. "
        + "Switch them on under Settings → Skills, then dispatch again.",
    }),
    reset: async () => {
      reset = true;
      return cleanReset();
    },
    inject: async () => {
      typed = true;
      return { ok: true, pasted: true, submitVerified: true };
    },
  });

  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /Enable Skills and the html-plans skill/, "name the toggle");
  assert.match(res.error ?? "", /Settings → Skills/, "and where to find it");
  assert.equal(reset, false, "nothing may be done to an agent that cannot follow the contract");
  assert.equal(typed, false, "and nothing pointing at a skill it cannot load is pasted at it");
  assert.equal(r.getTask("t1")?.status, "backlog");
  assert.equal(
    gitIn(clone, "rev-parse", "--abbrev-ref", "HEAD"),
    "feature/mine",
    "the checkout is untouched - the refusal happens before the reset",
  );
});

test("an assigned plan is typed the invocations THAT SESSION could actually run", async () => {
  // The resolver is the session-scoped one, so what lands in the pane is what this
  // conversation can load - not what a freshly launched agent of the same harness could.
  const { r, tasks, sessionId, clone } = setupInRepo("mission-assign-plan-contract-");
  r.upsertTask(mkTask({ repoRoot: clone, kind: "plan", intent: "plan the archives reading UI" }));
  let typed: string | null = null;
  let askedAbout: string | null = null;

  const res = await tasks.assign("t1", sessionId, {
    paneReady,
    confirmReset: true,
    requirePlanSkills: (session) => {
      askedAbout = session.id;
      return { ok: true, commands: { htmlPlans: "/html-plans", phasedPlan: "/phased-plan" } };
    },
    reset: cleanReset,
    inject: async (_session, prompt) => {
      typed = prompt;
      return { ok: true, pasted: true, submitVerified: true };
    },
  });

  assert.equal(res.ok, true, res.error);
  assert.equal(askedAbout, sessionId, "resolved against the session being typed into");
  assert.ok(typed !== null, "the task was typed");
  assert.match(typed!, /^plan the archives reading UI/, "the operator's words come first, intact");
  assert.match(typed!, /--- Mission Control plan ---/);
  assert.match(typed!, /\/html-plans/, "the resolved invocation, verbatim");
  assert.match(typed!, /\/phased-plan/);
  assert.match(typed!, /request_plan_decisions/);
  assert.doesNotMatch(typed!, /submit_scout_artifacts/, "a plan is not handed a scout's contract");
});
