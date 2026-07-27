import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the daemon's SQLite DB before anything reads config/db.
process.env.HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-driver-git-"));
const { Registry } = await import("../src/server/registry.ts");
const { pollOnce, refreshDriverGit } = await import("../src/server/discovery/poller.ts");
const { pollAndReconcilePrs } = await import("../src/server/pr.ts");

/**
 * What is at stake: a driver-run session's PR chip and no-mistakes pipeline.
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
 *
 * `nomistakesGated` had the same runtime split: terminal discovery re-read it on every
 * sweep, while an SDK registration defaulted it to false forever. The status poller skips
 * ungated checkouts, so an SDK-only session's real run stayed invisible. A terminal sibling
 * sharing the checkout accidentally hid the defect by polling that branch on its behalf.
 */

const PR = "https://github.com/o/r/pull/264";
const BRANCH = "mancej/topbar-responsive-ladder";

function gitSnapshot(branch: string | null, nomistakesGated = false) {
  return { branch, nomistakesGated };
}

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
  refreshDriverGit(reg, () => gitSnapshot(BRANCH));

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
  refreshDriverGit(reg, () => gitSnapshot(BRANCH));
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
  refreshDriverGit(reg, () => gitSnapshot(null));

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

  const read = (cwd: string) => {
    // The sweep already answered for the pane-backed session; asking again here would be a
    // second answer to the same question, on a different cadence.
    assert.equal(cwd, "/wt/pooled", "only the driver-run session's checkout is re-read");
    return gitSnapshot(BRANCH);
  };
  refreshDriverGit(reg, read);

  const byId = new Map(reg.snapshot().sessions.map((s) => [s.id, s]));
  assert.equal(byId.get("proc:ttys1:1:0")?.gitBranch, "mancej/from-the-sweep");
  assert.equal(byId.get("sdk:one")?.gitBranch, BRANCH);
});

test("an unchanged Git snapshot emits nothing", () => {
  const reg = new Registry();
  sdkSession(reg, { gitBranch: BRANCH });

  let emitted = 0;
  reg.on("event", (e: { type: string }) => {
    if (e.type === "session_upsert") emitted++;
  });
  refreshDriverGit(reg, () => gitSnapshot(BRANCH));

  assert.equal(emitted, 0, "steady Git state must not churn SSE on every 1.5s tick");
});

test("a driver-run session adopts no-mistakes gating and becomes a poll target", () => {
  const reg = new Registry();
  sdkSession(reg, { gitBranch: BRANCH });

  let emitted = 0;
  reg.on("event", (e: { type: string }) => {
    if (e.type === "session_upsert") emitted++;
  });
  refreshDriverGit(reg, () => gitSnapshot(BRANCH, true));

  assert.equal(reg.snapshot().sessions[0]?.nomistakesGated, true);
  assert.deepEqual(reg.nomistakesPollCwds(), ["/wt/pooled"]);
  assert.equal(emitted, 1, "a gate-only change must reach the card");

  refreshDriverGit(reg, () => gitSnapshot(BRANCH, false));
  assert.equal(reg.snapshot().sessions[0]?.nomistakesGated, false);
  assert.deepEqual(reg.nomistakesPollCwds(), []);
  assert.equal(emitted, 2, "removing the remote must also reach the card");
});

test("a failed terminal sweep does not skip the driver Git refresh", async () => {
  const reg = new Registry();
  sdkSession(reg);

  const previousError = console.error;
  console.error = () => {};
  try {
    await pollOnce(
      reg,
      async () => {
        throw new Error("terminal backend unavailable");
      },
      (registry) => refreshDriverGit(registry, () => gitSnapshot(BRANCH, true)),
    );
  } finally {
    console.error = previousError;
  }

  assert.equal(reg.snapshot().sessions[0]?.gitBranch, BRANCH);
  assert.equal(reg.snapshot().sessions[0]?.nomistakesGated, true);
});
