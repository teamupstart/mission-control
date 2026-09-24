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
const { MULTIPLEXERS } = await import("../src/server/terminal/registry.ts");
const { fakeMultiplexer, muxPane, FAIL } = await import("./helpers/terminal-fakes.ts");
const { WORKTREES_DIR } = await import("../src/server/config.ts");
const { getTask } = await import("../src/server/db.ts");

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

test("cancellation before discovery retains the identity captured by terminal launch", async () => {
  const repo = join(home, "capture-before-discovery");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const registry = new Registry();
  const id = "capture-before-discovery";
  registry.upsertTask(mkTask({ id, status: "dispatching", repoRoot: repo }));
  const captured = { homeName: "launched", homeBackend: "tmux" as const, terminalResourceId: "multiplexer:tmux:captured-address" };
  let cleanupResource: string | null | undefined;
  const dispatcher = new Dispatcher(registry, async (task) => {
    cleanupResource = task.terminalResourceId;
    assert.equal(getTask(id)?.terminalResourceId, captured.terminalResourceId, "saved before cancellation cleanup");
    throw new Error("fixture preserves the launch for manual cleanup");
  }, {
    resolveRuntime: () => "terminal",
    resolveBases: async () => ({ primary: base, extras: [] }),
    missionMcpDescriptor: async () => null,
    spawn: async () => {
      registry.upsertTask({ ...registry.getTask(id)!, status: "cancelled" });
      return captured;
    },
  });
  await dispatcher.dispatch(id);
  assert.equal(cleanupResource, captured.terminalResourceId);
  assert.equal(registry.getTask(id)?.homeBackend, "tmux", "Automatic must retain the actual creator");
  assert.equal(registry.getTask(id)?.terminalResourceId, captured.terminalResourceId);
});

for (const state of ["absent", "live", "unknown"] as const) {
  test(`failed close with a verified ${state} multiplexer home ${state === "absent" ? "releases" : "preserves"} the worktree`, async () => {
    const repo = join(home, `home-${state}`);
    const worktree = join(home, `worktree-${state}`);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
    execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "task", worktree]);
    const original = MULTIPLEXERS.tmux;
    const attempts: string[] = [];
    MULTIPLEXERS.tmux = fakeMultiplexer({
      bin: { env: null, candidates: [process.execPath], dropEnv: [] },
      // The old label has been reused. Absence must be about the recorded identity.
      list: async () => [muxPane({ session: state === "live" ? "captured-id" : "replacement-id", sessionName: "task" })],
      sessions: {
        ...original.sessions!,
        alive: state === "unknown" ? async () => null : null,
        kill: async (address) => { attempts.push(address); return FAIL("no such resource"); },
      },
    });
    const task = {
      repoRoot: repo, worktreePath: worktree, branch: "task", provider: "git" as const,
      homeName: "task", homeBackend: "tmux", terminalResourceId: "multiplexer:tmux:captured-id",
    };
    try {
      if (state === "absent") {
        await teardownWorktree(task);
        assert.equal(existsSync(worktree), false);
      } else {
        await assert.rejects(teardownWorktree(task), /worktree preserved/);
        assert.equal(existsSync(worktree), true);
      }
      assert.deepEqual(attempts, ["captured-id"], "never retry against the replacement name");
    } finally {
      MULTIPLEXERS.tmux = original;
    }
  });
}

test("a renamed legacy cmux home keeps its worktree when cleanup has no captured identity", async () => {
  const repo = join(home, "legacy-cmux-repo");
  const worktree = join(home, "legacy-cmux-worktree");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "fixture"]);
  execFileSync("git", ["-C", repo, "worktree", "add", "-qb", "legacy-task", worktree]);
  writeFileSync(join(worktree, "unfinished.txt"), "keep this work\n");
  const original = MULTIPLEXERS.cmux;
  MULTIPLEXERS.cmux = fakeMultiplexer({
    id: "cmux",
    bin: { env: null, candidates: [process.execPath], dropEnv: [] },
    list: async () => [muxPane({ session: "owned-uuid", sessionName: "renamed" })],
    sessions: {
      ...original.sessions!,
      kill: async () => { throw new Error("no identity authorizes a close"); },
    },
  });
  try {
    await assert.rejects(teardownWorktree({
      repoRoot: repo, worktreePath: worktree, branch: "legacy-task", provider: "git",
      homeName: "original", homeBackend: "cmux", terminalResourceId: null,
    }), /identity.*unknown.*worktree preserved/);
    assert.equal(existsSync(join(worktree, "unfinished.txt")), true);
  } finally {
    MULTIPLEXERS.cmux = original;
  }
});
