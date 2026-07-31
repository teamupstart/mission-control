import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-cleanup-"));
process.env.HARNESS_HOME = home;
// A binary that exists, so bin resolution cannot be what fails below. The dispatch under
// test never reaches a spawn.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher, teardownWorktree } = await import("../src/server/dispatcher.ts");
const { WORKTREES_DIR } = await import("../src/server/config.ts");
const { stubRun } = await import("../src/server/util/exec.ts");

type TreehouseCli = import("../src/server/pool-lease.ts").TreehouseCli;

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
});

test("a cancelled in-flight dispatch retains handles when teardown fails", async () => {
  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "dispatch-reset-race",
    status: "cancelled",
    repoRoot: "/repo",
    worktreePath: "/repo/worktree",
    branch: "harness/dispatch-reset-race",
    provider: "git",
    homeName: "dispatch-reset-race",
  }));
  const dispatcher = new Dispatcher(registry, async () => {
    throw new Error("worktree is busy");
  });

  const stopped = await (
    dispatcher as unknown as { abortIfSettled(taskId: string): Promise<boolean> }
  ).abortIfSettled("dispatch-reset-race");

  assert.equal(stopped, true);
  const retained = registry.getTask("dispatch-reset-race");
  assert.equal(retained?.worktreePath, "/repo/worktree");
  assert.equal(retained?.branch, "harness/dispatch-reset-race");
  assert.equal(retained?.provider, "git");
  assert.equal(retained?.homeName, "dispatch-reset-race");
  assert.match(retained?.error ?? "", /resource cleanup failed: worktree is busy/);
});

test("a pinned base this repo does not have fails the task and provisions nothing", async () => {
  // The pin is checked before anything is created, so the failure costs an error message
  // rather than a worktree, a terminal home and an agent that has to be torn down again.
  // Getting that ordering wrong is not visible in the happy path at all.
  const repo = join(home, "pinned-repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);

  const registry = new Registry();
  registry.upsertTask(mkTask({
    id: "pinned-missing-base",
    status: "dispatching",
    repoRoot: repo,
  }));
  const dispatcher = new Dispatcher(registry, async () => {
    throw new Error("teardown should never be reached - there is nothing to tear down");
  });

  await dispatcher.dispatch("pinned-missing-base", { baseSha: "0".repeat(40) });

  const failed = registry.getTask("pinned-missing-base");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /pinned base 0{40} is not a commit in/);
  assert.equal(failed?.worktreePath, null);
  assert.equal(failed?.branch, null);
  assert.equal(failed?.homeName, null);
  assert.equal(existsSync(join(WORKTREES_DIR, "pinned-missing-base")), false);
});

test("dispatch teardown returns a pooled tree WITHOUT --force", () => {
  // The regression this exists to catch is a silent one. Three callers now share one
  // treehouse adapter - dispatch teardown, the pool reaper, and the check lease reclaimer -
  // and the two that existed before it disagreed: dispatch returns with ["return", path],
  // the reaper with ["return", "--force", path]. `--force` means "clean, reset, and return
  // WITHOUT PROMPTING", so unifying the two spellings would silently make ordinary teardown
  // destructive in a way it has never been, on a path that runs whenever a task is torn
  // down. Extracting shared code must not change what either caller asks for.
  const calls: Array<{ path: string; force: boolean; cwd: string | null }> = [];
  const cli: TreehouseCli = {
    status: async () => stubRun({ stdout: "", stderr: "", code: 0 }),
    get: async () => stubRun({ stdout: "", stderr: "", code: 0 }),
    return: async ({ cwd, path, force }) => {
      calls.push({ cwd, path, force });
      return stubRun({ stdout: "", stderr: "", code: 0 });
    },
  };

  return teardownWorktree(
    {
      repoRoot: join(home, "pooled-repo"),
      worktreePath: join(home, "pooled-repo-tree"),
      branch: null,
      provider: "treehouse",
      homeName: null,
    },
    cli,
  ).then(() => {
    assert.deepEqual(calls, [
      // Unforced, and from the daemon's own cwd - byte for byte what this path has always
      // done. treehouse resolves the pool from the path argument.
      { cwd: null, path: join(home, "pooled-repo-tree"), force: false },
    ]);
  });
});
