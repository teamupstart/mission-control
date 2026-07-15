import { test } from "node:test";
import assert from "node:assert/strict";
import { kill, type KillDeps } from "../src/server/actions.ts";
import type { RunResult } from "../src/server/util/exec.ts";
import type { Session, SessionState, TmuxInfo } from "../src/shared/types.ts";

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
    nomistakesGated: false,
    pid: 4242,
    tty: null,
    permissionMode: null,
    wezterm: null,
    tmux: null,
    agentSessionId: null,
    transcriptPath: null,
    instrumented: true,
    activity: null,
    startedAt: null,
    firstSeen: 0,
    lastSeen: 0,
    lastActivity: null,
    pendingReviews: 0,
    nomistakes: null,
    nomistakesNarration: null,
    task: null,
    prUrl: null,
    prNumber: null,
    prState: null,
    prChecks: null,
    meta: null,
    note: null,
    ...over,
  };
}

const tmux: TmuxInfo = { session: "work", window: "0", windowIndex: 0, paneId: "%3" };

/** Records what `kill` drove: which pid was signalled and which tmux session was killed. */
function spyDeps(over: Partial<KillDeps> = {}): { deps: KillDeps; signalled: number[]; killedSessions: string[] } {
  const signalled: number[] = [];
  const killedSessions: string[] = [];
  const ok: RunResult = { stdout: "", stderr: "", code: 0 };
  const deps: KillDeps = {
    signal: (pid) => {
      signalled.push(pid);
      return { ok: true };
    },
    killTmuxSession: (session) => {
      killedSessions.push(session);
      return Promise.resolve(ok);
    },
    ...over,
  };
  return { deps, signalled, killedSessions };
}

test("kill: non-tmux session signals the pid and never touches tmux", async () => {
  const { deps, signalled, killedSessions } = spyDeps();
  const r = await kill(mkSession({ pid: 4242 }), deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(signalled, [4242]);
  assert.deepEqual(killedSessions, [], "no tmux handle -> no kill-session");
});

test("kill: non-tmux session surfaces a failed signal", async () => {
  const { deps } = spyDeps({ signal: () => ({ ok: false, error: "kill ESRCH" }) });
  const r = await kill(mkSession(), deps);

  assert.deepEqual(r, { ok: false, error: "kill ESRCH" });
});

test("kill: tmux session signals the pid AND kills the whole tmux session by name", async () => {
  const { deps, signalled, killedSessions } = spyDeps();
  const r = await kill(mkSession({ pid: 99, tmux }), deps);

  assert.deepEqual(r, { ok: true });
  assert.deepEqual(signalled, [99]);
  assert.deepEqual(killedSessions, ["work"], "kills the tmux session, not just the pane");
});

test("kill: tmux session succeeds when the process is already gone but kill-session lands", async () => {
  // Race: the agent's own exit collapsed nothing, but the pid is already reaped.
  const { deps } = spyDeps({ signal: () => ({ ok: false, error: "kill ESRCH" }) });
  const r = await kill(mkSession({ tmux }), deps);

  assert.deepEqual(r, { ok: true }, "kill-session succeeding is enough");
});

test("kill: tmux session succeeds when the session is already gone but the signal lands", async () => {
  // Race the other way: the agent exit already collapsed its tmux session.
  const gone: RunResult = { stdout: "", stderr: "can't find session: work", code: 1 };
  const { deps } = spyDeps({ killTmuxSession: () => Promise.resolve(gone) });
  const r = await kill(mkSession({ tmux }), deps);

  assert.deepEqual(r, { ok: true }, "signalling the process is enough");
});

test("kill: tmux session fails only when BOTH the signal and kill-session fail", async () => {
  const gone: RunResult = { stdout: "", stderr: "can't find session: work", code: 1 };
  const { deps } = spyDeps({
    signal: () => ({ ok: false, error: "kill EPERM" }),
    killTmuxSession: () => Promise.resolve(gone),
  });
  const r = await kill(mkSession({ tmux }), deps);

  assert.equal(r.ok, false);
  assert.equal(r.error, "can't find session: work");
});
