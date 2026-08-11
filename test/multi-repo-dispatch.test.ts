import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";
import type { TaskRepoEntry } from "@shared/types.ts";

// Dispatching a task that attaches secondary repositories, and the two rules that make it
// safe rather than merely working:
//
//  - **All or nothing.** A task whose second repo cannot be provisioned has already taken a
//    real tree for its first, and nothing downstream would ever reclaim it: the dispatch
//    throws before any of it reaches the task row, and teardown and startup reconciliation
//    both read the row. Left alone, the pool loses a slot per failed dispatch.
//  - **Pins cover the secondaries.** The reaper spares only what is pinned, so a secondary
//    worktree missing from the pin set is a tree it may `reset --hard` under a live agent.
//    That is the one destructive edge in this feature, which is why the pins ship in the
//    same change as the loop that creates the trees.

const home = mkdtempSync(join(tmpdir(), "mission-multirepo-dispatch-"));
process.env.HARNESS_HOME = home;
// A binary that exists, so bin resolution cannot be what fails below.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";

const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { poolPins } = await import("../src/server/pool.ts");
const { WORKTREES_DIR } = await import("../src/server/config.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
});

function mkRepo(name: string): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), `${name}\n`);
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "first"]);
  return repo;
}

function entry(repoRoot: string): TaskRepoEntry {
  return {
    repoRoot,
    worktreePath: null,
    branch: null,
    provider: null,
    baseSha: null,
    prUrl: null,
    prState: null,
    mergedAt: null,
  };
}

// ---- all-or-nothing --------------------------------------------------------------------

test("a secondary that cannot be provisioned unwinds the primary's tree", async () => {
  const api = mkRepo("rollback-api");
  // Not a git repository at all, so `provisionWorktree` refuses it in its preflight - the
  // most faithful stand-in for the real cases (a repo deleted since it was attached, a
  // path that stopped resolving) and the only one that needs no injection.
  const broken = join(home, "rollback-not-a-repo");
  mkdirSync(broken, { recursive: true });

  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "rollback-task",
      status: "dispatching",
      repoRoot: api,
      extraRepos: [entry(broken)],
    }),
  );
  const dispatcher = new Dispatcher(registry);

  await dispatcher.dispatch("rollback-task");

  const failed = registry.getTask("rollback-task");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /is not a git repository/);
  // The primary's tree was really taken and really given back. Asserting the DISK, not the
  // row: the row never learned about it, which is exactly why nothing else could clean up.
  assert.equal(
    existsSync(join(WORKTREES_DIR, "rollback-task")),
    false,
    "the primary tree provisioned before the failure is gone",
  );
  // And the throwaway branch with it, so a retry of the same task can cut it again.
  assert.equal(
    execFileSync("git", ["-C", api, "branch", "--list", "harness/t-rollba"], { stdio: "pipe" })
      .toString()
      .trim(),
    "",
  );
  // Nothing half-recorded: a task that provisioned nothing names nothing.
  assert.equal(failed?.worktreePath, null);
  assert.deepEqual(
    failed?.extraRepos.map((e) => e.worktreePath),
    [null],
    "the repo set survives the failure; only its provisioning facts are absent",
  );
});

test("the unwind is provider-aware in every ordering", async () => {
  // Mixed providers on one task are ordinary - a treehouse repo takes a lease while a plain
  // repo does not - and the two are UNWOUND by different commands. A lease must be RETURNED
  // (a `git worktree remove` would delete a pooled tree the pool still believes it owns);
  // a fallback tree must be removed. `teardownWorktree` is what knows the difference, so
  // what this pins is that every taken tree reaches it carrying its OWN provider, whichever
  // position in the set failed.
  const broken = join(home, "mixed-not-a-repo");
  mkdirSync(broken, { recursive: true });

  // The teardown is STUBBED here (that is the whole point - we are watching what it is
  // asked to do), so nothing it is handed is actually reclaimed. Each case therefore gets
  // its own primary repo and an id with its own six-character prefix: the branch name is
  // `harness/<slug>-<taskId.slice(0,6)>`, and two cases sharing either would have the
  // second one fail on a leftover branch instead of on the repo this test is about.
  const cases = [
    { id: "aaa-fails-first", primary: mkRepo("mixed-a"), extras: [entry(broken)], taken: 1 },
    {
      id: "bbb-fails-second",
      primary: mkRepo("mixed-b"),
      extras: [entry(mkRepo("mixed-b-web")), entry(broken)],
      taken: 2,
    },
  ];

  for (const { id, primary, extras, taken } of cases) {
    const seen: Array<{ path: string | null; provider: string | null }> = [];
    const registry = new Registry();
    registry.upsertTask(mkTask({ id, status: "dispatching", repoRoot: primary, extraRepos: extras }));
    const dispatcher = new Dispatcher(registry, async (task) => {
      seen.push({ path: task.worktreePath, provider: task.provider });
    });

    await dispatcher.dispatch(id);

    assert.equal(registry.getTask(id)?.status, "failed", id);
    // Filtered to the calls that name a tree. The dispatch's own error path also runs
    // teardown against the task ROW, which by then records nothing - that call is a
    // deliberate no-op and not what this test is about.
    const unwound = seen.filter((call) => call.path !== null);
    assert.equal(unwound.length, taken, `${id}: every tree taken before the failure is offered back`);
    for (const call of unwound) {
      assert.equal(call.provider, "git", `${id}: unwound as the provider it was taken as`);
    }
  }
});

// ---- pins ------------------------------------------------------------------------------

test("pool pins name every worktree a task holds, and only real ones", () => {
  // The destructive edge, and the reason the pins ship in the same change as the loop that
  // creates the trees. `poolPins.taskWorktrees` is the only thing standing between a
  // secondary worktree and a `reset --hard` return-to-pool while an agent is writing in it.
  //
  // All three cases share one registry deliberately: pins are a fold over the WHOLE task
  // list, so asserting the union is what actually proves a multi-repo task contributes its
  // secondaries while a backlog task and a single-repo task contribute what they always did.
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: "pins-multi",
      status: "running",
      repoRoot: "/repo/api",
      worktreePath: "/wt/pins-multi",
      extraRepos: [
        { ...entry("/repo/web"), worktreePath: "/wt/pins-multi-1" },
        { ...entry("/repo/docs"), worktreePath: "/wt/pins-multi-2" },
      ],
    }),
  );
  // A backlog task has provisioned nothing. Its null must not reach the spared set AS a
  // null: the reaper compares paths, and a null there is a rung that silently matches
  // nothing while looking like it matches something.
  registry.upsertTask(
    mkTask({
      id: "pins-backlog",
      status: "backlog",
      repoRoot: "/repo/api",
      worktreePath: null,
      extraRepos: [entry("/repo/web")],
    }),
  );
  registry.upsertTask(
    mkTask({ id: "pins-solo", status: "running", repoRoot: "/repo/api", worktreePath: "/wt/pins-solo" }),
  );

  assert.deepEqual(
    [...poolPins(registry).taskWorktrees].sort(),
    ["/wt/pins-multi", "/wt/pins-multi-1", "/wt/pins-multi-2", "/wt/pins-solo"],
  );
});
