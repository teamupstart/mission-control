import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkTask } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-cleanup-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");

after(() => rmSync(home, { recursive: true, force: true }));

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
