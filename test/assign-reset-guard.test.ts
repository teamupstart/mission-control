import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { resetWouldDestroyWork } from "../src/server/actions.ts";
import { gitIn, mkOriginAndClone } from "./helpers/git-fixture.ts";
import type { Session } from "../src/shared/types.ts";

// The guard standing in front of the reset `TaskManager.assign` runs before it hands a
// backlog task to an agent that is already running.
//
// What is at stake is work nobody agreed to lose. The Reset button has a confirm dialog
// and a loss preview in front of it; this reset happens on Foreman's loop with nobody
// looking, on a checkout that is very often the operator's own. So the contract is not
// "usually right" - it is that every uncertain answer refuses. A false refusal costs one
// worktree; a false clearance runs `reset --hard` and `clean -fd` over someone's work.
//
// It also must not fetch. This runs per candidate agent on a 4s tick, and reading the
// local `origin/*` ref can only ever over-report, which is the safe direction.

const fixture = (): string => mkOriginAndClone("harness-assign-guard-").clone;

/** A minimal Session over `cwd`. No pane, so nothing here can type anywhere. */
function sess(cwd: string | null): Session {
  return {
    id: "s1", agent: "claude", name: "work", nameSource: "process", state: "idle",
    cwd, gitBranch: "main", gitRoot: null, repoRoot: null, nomistakesGated: false, pid: 1, tty: null,
    permissionMode: null, wezterm: null, tmux: null, agentSessionId: null, transcriptPath: null,
    instrumented: false, hooksSeen: false, activity: null, startedAt: null, firstSeen: 0, lastSeen: 0,
    lastActivity: null, pendingReviews: 0, nomistakes: null, nomistakesFixes: [], task: null,
    nomistakesNarration: null, prUrl: null, prNumber: null, prState: null, prChecks: null,
    meta: null, note: null, cost: null, goal: null, queue: null, orphanedQueue: null, paneDialog: null,
  };
}

test("a checkout that matches origin holds nothing, so the assign may reset it", async () => {
  assert.equal(await resetWouldDestroyWork(sess(fixture())), null);
});

test("an uncommitted edit refuses, and says how many files are in the way", async () => {
  const clone = fixture();
  writeFileSync(join(clone, "keep.txt"), "base\nhalf-finished\n");
  const why = await resetWouldDestroyWork(sess(clone));
  assert.match(why ?? "", /1 uncommitted file/);
});

test("an UNTRACKED file refuses too - git clean -fd takes those as surely as reset does", async () => {
  const clone = fixture();
  writeFileSync(join(clone, "scratch.txt"), "notes the agent left behind\n");
  assert.match((await resetWouldDestroyWork(sess(clone))) ?? "", /uncommitted file/);
});

test("a commit that never reached origin refuses, and names the branch it compared against", async () => {
  // The case the fleet actually produces: an agent committed, the push failed or was
  // never asked for, and the session went idle looking finished.
  const clone = fixture();
  writeFileSync(join(clone, "keep.txt"), "base\nshipped locally\n");
  gitIn(clone, "commit", "-qam", "work nobody pushed");
  const why = await resetWouldDestroyWork(sess(clone));
  assert.match(why ?? "", /1 commit\(s\) not on origin\/main/);
});

test("a commit origin already has is not lost work, even though HEAD moved", async () => {
  const clone = fixture();
  writeFileSync(join(clone, "keep.txt"), "base\nshipped\n");
  gitIn(clone, "commit", "-qam", "work");
  // Advance the remote-tracking ref rather than pushing: the fixture's origin is a
  // non-bare repo with main checked out, and this is the state a real fetch would leave
  // behind anyway - which is the only state this function reads, since it does not fetch.
  gitIn(clone, "update-ref", "refs/remotes/origin/main", "HEAD");
  assert.equal(await resetWouldDestroyWork(sess(clone)), null);
});

test("a directory that is not a repo refuses rather than being treated as clean", async () => {
  // "Nothing to lose" and "I cannot tell" must never collapse into the same answer: this
  // is the one that decides whether an unattended `clean -fd` runs.
  const { root } = mkOriginAndClone("harness-assign-guard-norepo-");
  assert.match((await resetWouldDestroyWork(sess(root))) ?? "", /not a git repository/);
});

test("a session with no working directory refuses", async () => {
  assert.match((await resetWouldDestroyWork(sess(null))) ?? "", /no working directory/);
});
