import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ELECTRON_GUI_LAUNCHER } from "./helpers/electron-gui.ts";
import { acquireElectronStartupSlot, ELECTRON_STARTUP_MAX_HOLD_MS, electronStarted, withElectronStartupSlot } from "./helpers/electron-startup-slot.mjs";
import { SYSTEM_TMP_ENV, tempDir } from "./temp-root.mjs";

// The startup slot lives in the machine temp dir so every worker shares it. Each case points
// that at a private directory, so nothing here contends with a real Electron launch.
function privateMachineTemp(t: test.TestContext): string {
  const dir = tempDir("electron-slot-machine-");
  const previous = process.env[SYSTEM_TMP_ENV];
  process.env[SYSTEM_TMP_ENV] = dir;
  t.after(() => {
    if (previous === undefined) delete process.env[SYSTEM_TMP_ENV];
    else process.env[SYSTEM_TMP_ENV] = previous;
  });
  return dir;
}

const slotIn = (dir: string) => join(dir, `mission-electron-startup-${process.getuid?.() ?? "user"}.lock`);

test("one startup holds the slot at a time, and the next takes it when it is given back", async (t) => {
  const dir = privateMachineTemp(t);
  const order: string[] = [];
  const release = await acquireElectronStartupSlot();
  assert.ok(existsSync(slotIn(dir)));
  const second = acquireElectronStartupSlot().then((next) => {
    order.push("second acquired");
    return next;
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  order.push("first releasing");
  release();
  (await second)();
  assert.deepEqual(order, ["first releasing", "second acquired"]);
  assert.equal(existsSync(slotIn(dir)), false, "the slot is gone once nobody holds it");
});

test("a slot whose holder died is taken over rather than waited on", async (t) => {
  const dir = privateMachineTemp(t);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  mkdirSync(slotIn(dir));
  writeFileSync(join(slotIn(dir), "owner.json"), JSON.stringify({ pid: dead, startedAt: Date.now() - 60_000, acquiredAt: Date.now() }));
  const started = Date.now();
  const release = await acquireElectronStartupSlot();
  assert.ok(Date.now() - started < 5_000, "waited on a dead holder");
  release();
});

test("a live holder that outstays the hold cap is taken over, and not before", async (t) => {
  // A startup whose Electron never spawns a helper must not block every later launch. The
  // holder here is alive throughout, so only the cap can free the slot. Its stamp is set just
  // short of the real 45 seconds, so the waiter has to wait out the remainder.
  const dir = privateMachineTemp(t);
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => holder.kill("SIGKILL"));
  const remaining = 1_500;
  mkdirSync(slotIn(dir));
  writeFileSync(join(slotIn(dir), "owner.json"), JSON.stringify({
    pid: holder.pid, startedAt: Date.now(), acquiredAt: Date.now() - ELECTRON_STARTUP_MAX_HOLD_MS + remaining,
  }));
  const started = Date.now();
  let acquiredAt = 0;
  const waiting = acquireElectronStartupSlot().then((release) => {
    acquiredAt = Date.now();
    return release;
  });
  await new Promise((resolve) => setTimeout(resolve, remaining - 700));
  assert.equal(acquiredAt, 0, "the waiter took the slot from a live holder before the cap");
  const release = await waiting;
  assert.ok(acquiredAt - started >= remaining - 50, `taken over after ${acquiredAt - started}ms, before the cap expired`);
  assert.ok(acquiredAt - started < remaining + 2_000, `taken over after ${acquiredAt - started}ms, long after the cap expired`);
  assert.equal(holder.exitCode, null, "the holder was still alive when the slot was taken over");
  assert.ok(existsSync(slotIn(dir)), "the waiter holds the slot");
  release();
});

test("the slot is held until the launched process spawns its first child", async (t) => {
  privateMachineTemp(t);
  // Stands in for Electron: a parent that starts a helper after a delay, as the browser
  // process starts its GPU helper once startup is through.
  const script = "setTimeout(() => { require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)'], { stdio: 'ignore' }); }, 800); setTimeout(() => {}, 2500);";
  const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
  const started = Date.now();
  await electronStarted(child);
  const waited = Date.now() - started;
  assert.ok(waited >= 700, `released after ${waited}ms, before the helper existed`);
  assert.ok(waited < 2_400, `held for ${waited}ms, until exit rather than until the helper`);
  child.kill();
});

test("the launcher passes output and exit status through, and forwards a timeout's SIGTERM", (t) => {
  privateMachineTemp(t);
  const fake = join(tempDir("electron-slot-fake-"), "fake-electron.mjs");
  writeFileSync(fake, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(3);\n", { mode: 0o755 });
  const failed = spawnSync(process.execPath, [ELECTRON_GUI_LAUNCHER, fake, "--a", "b"], { encoding: "utf8", env: process.env });
  assert.equal(failed.status, 3);
  assert.equal(failed.stdout, JSON.stringify(["--a", "b"]));

  const hang = join(tempDir("electron-slot-hang-"), "hang.mjs");
  writeFileSync(hang, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", { mode: 0o755 });
  assert.throws(
    () => execFileSync(process.execPath, [ELECTRON_GUI_LAUNCHER, hang], { timeout: 1_500, env: process.env }),
    (error: NodeJS.ErrnoException & { signal?: string }) => error.code === "ETIMEDOUT" && error.signal === "SIGTERM",
  );
  const leftover = spawnSync("pgrep", ["-f", hang], { encoding: "utf8" }).stdout.trim();
  assert.equal(leftover, "", "the launcher left the launched process running after its own timeout");
});

test("a launch that reports its own readiness holds the slot only until it resolves", async (t) => {
  const dir = privateMachineTemp(t);
  const value = await withElectronStartupSlot(async () => {
    assert.ok(existsSync(slotIn(dir)), "the slot is held during the launch");
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(existsSync(slotIn(dir)), false);
});
