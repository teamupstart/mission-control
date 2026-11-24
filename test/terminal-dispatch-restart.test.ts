import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, test } from "node:test";
import { launchFailureOutcome, newLaunchFailure, UNKNOWN_TERMINAL_GUIDANCE, type PendingTerminalLaunch } from "../src/shared/launch-failure.ts";
import { mkTask } from "./helpers/session-fixture.ts";
import { originAndCloneAt } from "./helpers/git-fixture.ts";

const dir = mkdtempSync(join(tmpdir(), "terminal-restart-test-"));
process.env.MISSION_HOME = dir;
after(() => rmSync(dir, { recursive: true, force: true }));
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { recordTaskWorktreeObservation, getTaskWorktreeRetention } = await import("../src/server/db.ts");
const { taskResourceGeneration, RETENTION_WINDOW_MS } = await import("../src/server/task-worktree-retention.ts");
const { LAUNCH_PID_FILE } = await import("../src/server/terminal/launch-process.ts");
const { discardTerminalReceipt, WRAPPER_EXIT_FILE } = await import("../src/server/terminal/dispatch-observation.ts");

// A separate process really loses its open exit descriptor and deadline timer. No credentials,
// environment patch or terminal argv are persisted with the task.
const launch = `
  import { createDisposableAgentStateHome, isolatedAgentArgv, observeTerminalWrapperExit, retainPendingTerminalHome } from "./src/server/agent-subprocess-env.ts";
  const home = createDisposableAgentStateHome();
  const guard = observeTerminalWrapperExit(home);
  const argv = isolatedAgentArgv(["/bin/sh", "-c", "echo ready; read -r done || exit 0"], { stateHome: home });
  const pending = retainPendingTerminalHome(home, 120000, guard.revokeUnstarted);
  const record = guard.persist(pending.deadline);
  console.log(JSON.stringify({ home, argv, record }));
  process.stdin.resume();
`;

for (const mode of ["crash", "shutdown", "wrapper-exit", "live-wrapper", "replacement", "partial-revocation", "unmarked-claim", "unrelated-claim", "superseded"] as const) {
  test(`restart after ${mode} uses the timed-out launch's own proof and preserves checkout retention`, { timeout: 15000 }, async (t) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", launch]);
    const closed = once(child, "close");
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const lines = createInterface({ input: child.stdout });
    t.after(() => lines.close());
    const line = await lines[Symbol.asyncIterator]().next();
    assert.ok(!line.done, "the first daemon prepared its launch");
    const { home, argv, record } = JSON.parse(line.value) as { home: string; argv: string[]; record: PendingTerminalLaunch };
    assert.ok(record.receipt);
    t.after(() => { rmSync(home, { recursive: true, force: true }); discardTerminalReceipt(record.receipt); });
    const { clone } = originAndCloneAt(join(dir, mode));
    const checkoutFile = join(clone, "notes");
    if (mode === "wrapper-exit") writeFileSync(checkoutFile, "operator work");
    const original = mkTask({ id: mode, status: "failed", error: "backend timeout" + UNKNOWN_TERMINAL_GUIDANCE, repoRoot: clone, worktreePath: clone, worktreeLeaseId: "owned-slot" });
    if (mode === "live-wrapper") record.deadline = Date.now() - 1; // Its start window elapsed during downtime.
    original.launchFailure = { ...newLaunchFailure(original, Date.now(), null, true), pendingTerminal: record };
    new Registry().upsertTask(original);
    const now = Date.now() - 24 * 60 * 60 * 1000;
    recordTaskWorktreeObservation({ taskId: mode, generation: taskResourceGeneration(original), fingerprint: mode, now, retentionMs: RETENTION_WINDOW_MS });
    if (mode === "shutdown") child.stdin.end();
    else child.kill("SIGKILL");
    await closed;
    if (mode === "wrapper-exit") assert.equal(spawnSync(argv[0]!, argv.slice(1)).status, 0);
    const running = mode === "live-wrapper" ? spawn(argv[0]!, argv.slice(1)) : null;
    const exited = running && once(running, "close");
    if (running) { t.after(() => running.stdin.end()); await once(running.stdout, "data"); }
    if (mode === "replacement") {
      rmSync(home, { recursive: true }); mkdirSync(home, { mode: 0o700 });
      writeFileSync(join(home, "terminal-wrapper.exit"), "");
    }
    if (mode === "partial-revocation" || mode === "unmarked-claim" || mode === "unrelated-claim") {
      // The dying daemon removed the exit path partway through recursive removal.
      const exit = join(home, WRAPPER_EXIT_FILE);
      const claim = join(home, LAUNCH_PID_FILE);
      if (mode !== "unmarked-claim") writeFileSync(exit, "n");
      if (mode === "unrelated-claim") {
        // The receipt still has two links, but the surviving PID claim names another inode.
        linkSync(exit, join(home, "other-link"));
        writeFileSync(claim, "n");
      } else linkSync(exit, claim);
      unlinkSync(exit);
    }
    if (!running) t.mock.timers.enable({ apis: ["setTimeout"] });
    const restarted = new Registry();
    const manager = new TaskManager(restarted);
    assert.deepEqual(restarted.getTask(mode)?.launchFailure?.pendingTerminal, record);
    assert.equal(launchFailureOutcome(restarted.getTask(mode)!), "kept");
    if (mode === "superseded") restarted.upsertTask({ ...original, status: "done", launchFailure: null });
    if (!running) t.mock.timers.tick(120000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (running) {
      assert.equal(launchFailureOutcome(restarted.getTask(mode)!), "kept");
      assert.ok(existsSync(home), "restart preserved the live wrapper");
      running.stdin.end();
      await exited;
      await t.waitFor(() => assert.equal(restarted.getTask(mode)?.launchFailure?.terminalInactive, true), { timeout: 10000 });
    }
    const recovered = restarted.getTask(mode)!;
    if (mode === "superseded") {
      assert.equal(recovered.status, "done");
      assert.equal(recovered.launchFailure, null);
      assert.ok(existsSync(home), "the stale attempt took no action");
      await manager.stop();
      return;
    }
    if (mode === "replacement" || mode === "unmarked-claim" || mode === "unrelated-claim") {
      assert.equal(launchFailureOutcome(recovered), "kept", "a missing home or replacement inode is not proof");
      assert.ok(existsSync(home));
    } else {
      assert.equal(launchFailureOutcome(recovered), "worktree-kept", "retry stays blocked while the checkout is retained");
      assert.equal(recovered.launchFailure?.pendingTerminal, undefined);
      assert.equal(recovered.launchFailure?.terminalInactive, true);
      assert.equal(recovered.error, "backend timeout");
      assert.equal(existsSync(home), false);
      assert.equal(launchFailureOutcome(new Registry().getTask(mode)!), "worktree-kept", "settlement survived another reload");
    }
    assert.equal(recovered.worktreePath, clone);
    assert.equal(recovered.worktreeLeaseId, "owned-slot");
    assert.ok(existsSync(join(clone, ".git")));
    if (mode === "wrapper-exit") assert.equal(readFileSync(checkoutFile, "utf8"), "operator work");
    assert.equal(getTaskWorktreeRetention(mode)?.cleanupDueAt, now + RETENTION_WINDOW_MS);
    await manager.stop();
  });
}
