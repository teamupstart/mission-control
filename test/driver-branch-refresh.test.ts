import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-driver-branch-"));
const { Registry } = await import("../src/server/registry.ts");
const { refreshDriverBranches } = await import("../src/server/discovery/poller.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");

/**
 * What is at stake: a driver-run session's PR chip.
 *
 * A pane-backed session's `gitBranch` is re-read from its cwd on every discovery sweep, so
 * it follows the agent onto whatever branch it cuts. A driver-run session never passes
 * through that sweep - it is registered once, from `wt.branch` at dispatch - and a pooled
 * worktree is routinely leased with NO branch. So the field stayed null for the life of the
 * session while the agent worked on, and opened a pull request from, a branch nobody could
 * see. `prPollTargets` reported `branch: null`, the poller never spent a `gh` call on it,
 * and the chip never appeared.
 *
 * The retraction is the half that makes it worse than a missing decoration: a session that
 * is in neither `found` nor `skip` is read by `reconcilePrs` as "provably no PR", so a chip
 * the hook had set optimistically was actively wiped ~20s later.
 */

const PR = "https://github.com/o/r/pull/264";
const BRANCH = "mancej/topbar-responsive-ladder";

function sdkSession(reg: InstanceType<typeof Registry>, over: { gitBranch?: string | null } = {}) {
  return reg.registerSdkSession({
    id: "sdk:one",
    agent: "claude",
    name: "embedded",
    cwd: "/wt/pooled",
    gitBranch: over.gitBranch ?? null,
  });
}

test("a driver-run session adopts a branch cut after it launched", () => {
  const reg = new Registry();
  sdkSession(reg);
  assert.equal(reg.snapshot().sessions[0]?.gitBranch, null, "leased with no branch");

  // The agent cuts its feature branch mid-run; the next sweep re-reads the checkout.
  refreshDriverBranches(reg, () => BRANCH);

  assert.equal(reg.snapshot().sessions[0]?.gitBranch, BRANCH);
});

test("the adopted branch is what makes the PR poller ask, and the chip appear", async () => {
  const reg = new Registry();
  sdkSession(reg);

  const asked: string[] = [];
  const lookup = async (_cwd: string, branch: string) => {
    asked.push(branch);
    return {
      url: PR,
      number: 264,
      state: "open" as const,
      checks: null,
      createdAt: 1,
      mergedAt: null,
      headSha: "abc",
      worktreeHeadSha: "abc",
    };
  };

  // Before the refresh: branch is null, so the poller has nothing to ask about.
  await pollAndReconcilePrs(reg, lookup, async () => null);
  assert.deepEqual(asked, [], "no gh call for a session with no branch");
  assert.equal(reg.snapshot().sessions[0]?.prUrl, null);

  // After it: the branch is real, so the PR is found and the chip is set.
  refreshDriverBranches(reg, () => BRANCH);
  await pollAndReconcilePrs(reg, lookup, async () => null);

  assert.deepEqual(asked, [BRANCH], "the adopted branch is what gets queried");
  const s = reg.snapshot().sessions[0];
  assert.equal(s?.prUrl, PR);
  assert.equal(s?.prNumber, 264);
  assert.equal(s?.prState, "open");
});

test("a detached HEAD reads as no branch, and does not invent one", () => {
  const reg = new Registry();
  sdkSession(reg, { gitBranch: BRANCH });

  // `branchFromHead` returns null for a detached checkout - every `git rebase` passes
  // through one. Null must overwrite, exactly as it does for a pane-backed session, so the
  // first REAL branch is later adopted in place rather than looking like a branch change.
  refreshDriverBranches(reg, () => null);

  assert.equal(reg.snapshot().sessions[0]?.gitBranch, null);
});

test("the refresh is scoped to driver-run sessions and never touches a pane-backed one", () => {
  const reg = new Registry();
  reg.applyDiscovery([
    {
      syntheticId: "proc:ttys1:1:0",
      agent: "claude",
      name: "paned",
      nameSource: "process",
      cwd: "/wt/paned",
      gitBranch: "mancej/from-the-sweep",
      gitRoot: null,
      repoRoot: null,
      nomistakesGated: false,
      pid: 1,
      tty: "ttys1",
      terminals: [],
      startedAt: 0,
    },
  ]);
  sdkSession(reg);

  const read = (cwd: string): string | null => {
    // The sweep already answered for the pane-backed session; asking again here would be a
    // second answer to the same question, on a different cadence.
    assert.equal(cwd, "/wt/pooled", "only the driver-run session's checkout is re-read");
    return BRANCH;
  };
  refreshDriverBranches(reg, read);

  const byId = new Map(reg.snapshot().sessions.map((s) => [s.id, s]));
  assert.equal(byId.get("proc:ttys1:1:0")?.gitBranch, "mancej/from-the-sweep");
  assert.equal(byId.get("sdk:one")?.gitBranch, BRANCH);
});

test("an unchanged branch emits nothing", () => {
  const reg = new Registry();
  sdkSession(reg, { gitBranch: BRANCH });

  let emitted = 0;
  reg.on("event", (e: { type: string }) => {
    if (e.type === "session_upsert") emitted++;
  });
  refreshDriverBranches(reg, () => BRANCH);

  assert.equal(emitted, 0, "a steady branch must not churn SSE on every 1.5s tick");
});
