import { test } from "node:test";
import assert from "node:assert/strict";
import { kill, type KillDeps } from "../src/server/actions.ts";
import {
  FAIL,
  OK,
  fakeEmulator,
  fakeMultiplexer,
  fakeTerminals,
} from "./helpers/terminal-fakes.ts";
import type { MuxSessions, TerminalResult } from "../src/server/terminal/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import type { Session, SessionState } from "../src/shared/types.ts";

// What is at stake: that "this terminal home is a killable group" is a capability a backend
// DECLARES, and not the else-branch of a vendor check.
//
// Kill signals the leaf agent and then tears down the group its home is. That second half
// used to be `if (session.tmux)`, which quietly gave every other backend the no-group path -
// correct for wezterm, where a tab is not a group and closing the window is the human's to
// do, and wrong the moment a second multiplexer appears: its windows would be left running
// with nothing anywhere saying why. `MuxSessions.kill` is that question asked out loud, and
// these tests drive both of its answers plus the race between the two steps.

function mkSession(over: Partial<Session> = {}): Session {
  return {
    id: "s",
    agent: "claude",
    name: "sess",
    nameSource: "process",
    state: "working" as SessionState,
    cwd: null,
    gitBranch: null,
    gitRoot: null,
    repoRoot: null,
    nomistakesGated: false,
    pid: 4242,
    tty: null,
    permissionMode: null,
    terminals: [],
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    stateConfirmed: true,
    hooksSeen: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesFixes: [],
    nomistakesNarration: null,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null, cost: null, goal: null,
    queue: null,
    orphanedQueue: null,
    inspector: null,
    paneDialog: null,
    ...over,
  };
}

/** A session hosted on a named multiplexer session - the handle Kill tears down. */
const onMux = { terminals: [mkMuxHandle({ session: "work", windowName: "0", paneId: "%3" })] };

/** The named-session half of a multiplexer, with only `kill` varying between tests. */
function sessions(kill: ((name: string) => Promise<TerminalResult>) | null): MuxSessions {
  return {
    spawnDetached: async () => OK,
    attachArgv: (name: string) => ["fake", "attach", name],
    rename: async () => OK,
    kill,
    names: { validate: () => null, sanitize: (t: string) => t },
  };
}

/** Records what `kill` drove: which pid was signalled and which home group was killed. */
function spyDeps(
  over: { signal?: KillDeps["signal"]; killGroup?: ((name: string) => Promise<TerminalResult>) | null } = {},
): { deps: KillDeps; signalled: number[]; killedGroups: string[] } {
  const signalled: number[] = [];
  const killedGroups: string[] = [];
  const killGroup = over.killGroup === undefined ? async () => OK : over.killGroup;
  const wrapped = killGroup
    ? async (name: string) => {
        killedGroups.push(name);
        return killGroup(name);
      }
    : null;
  return {
    deps: {
      signal:
        over.signal ??
        ((pid) => {
          signalled.push(pid);
          return { ok: true };
        }),
      terminals: fakeTerminals(
        fakeMultiplexer({ sessions: sessions(wrapped) }),
        fakeEmulator(),
      ),
    },
    signalled,
    killedGroups,
  };
}

test("kill: a session with no terminal handle signals the pid and touches no backend", async () => {
  const { deps, signalled, killedGroups } = spyDeps();
  const r = await kill(mkSession({ pid: 4242 }), deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(signalled, [4242]);
  assert.deepEqual(killedGroups, [], "no multiplexer handle -> no group to kill");
});

test("kill: a handleless session surfaces a failed signal", async () => {
  const { deps } = spyDeps({ signal: () => ({ ok: false, error: "kill ESRCH" }) });
  const r = await kill(mkSession(), deps);

  assert.deepEqual(r, { ok: false, error: "kill ESRCH" });
});

test("kill: a multiplexer-hosted session signals the pid AND kills the whole group", async () => {
  const { deps, signalled, killedGroups } = spyDeps();
  const r = await kill(mkSession({ pid: 99, ...onMux }), deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(signalled, [99]);
  assert.deepEqual(killedGroups, ["work"], "kills the session, not just the pane");
});

test("kill: a multiplexer that declares no killable group leaves the signal to stand alone", async () => {
  // The capability null this test exists for. Before it, "no group" was reachable only by
  // not being tmux, so a second multiplexer would have inherited the wezterm path - its
  // other panes still running, and nothing anywhere saying so. Now it is a declaration, and
  // the signal is the complete answer rather than half of a missing one.
  const { deps, signalled, killedGroups } = spyDeps({ killGroup: null });
  const r = await kill(mkSession({ pid: 7, ...onMux }), deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(signalled, [7]);
  assert.deepEqual(killedGroups, []);
});

test("kill: succeeds when the process is already gone but the group kill lands", async () => {
  // Race: the pid was already reaped, but the home is still standing.
  const { deps } = spyDeps({ signal: () => ({ ok: false, error: "kill ESRCH" }) });
  const r = await kill(mkSession(onMux), deps);

  assert.deepEqual(r, { ok: true }, "killing the group is enough");
});

test("kill: succeeds when the group is already gone but the signal lands", async () => {
  // Race the other way: the agent's exit already collapsed its session.
  const { deps } = spyDeps({ killGroup: async () => FAIL("can't find session: work") });
  const r = await kill(mkSession(onMux), deps);

  assert.deepEqual(r, { ok: true }, "signalling the process is enough");
});

test("kill: fails only when BOTH the signal and the group kill fail", async () => {
  const { deps } = spyDeps({
    signal: () => ({ ok: false, error: "kill EPERM" }),
    killGroup: async () => FAIL("can't find session: work"),
  });
  const r = await kill(mkSession(onMux), deps);

  assert.equal(r.ok, false);
  // The backend's own words, not ours: it is the half that knows what went wrong.
  assert.equal(r.error, "can't find session: work");
});
