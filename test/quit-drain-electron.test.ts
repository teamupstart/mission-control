// A real Electron quit through the SHIPPED quit handler (`holdQuitUntilDrained`), the shipped
// background supervisor and ownership, and a utility-process daemon running a REAL workflow
// check: `spawnCheckProcess`'s supervisor shim, which in a utility process runs from the
// Electron bundle's own Helper executable in its own detached process group - the processes
// that held the bundle on 2026-11-03.
//
// The daemon's shutdown keeps the shape that matters and nothing else: it awaits other
// subsystems first (as `sdkSessions.stopAll()` precedes `workflows.stop()`), then runs the
// teardown `WorkflowEngine.stop()` runs - `killLiveCheckGroups()` - and waits for the attempt to
// prove its group empty through the ordinary `terminateCheckGroup` path.
//
// What is asserted is what the update helper's bundle-exit wait needs: once the app process has
// exited, no process carrying this attempt's supervisor marker is left and the check's process
// group is empty. The `send-only` mode is the pre-fix quit ordering and is kept as the control,
// which is what proves this fixture can see the leak at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHECK_SUPERVISOR_MARKER } from "../src/shared/owned-runtime.mjs";
import { assertElectronGuiLaunchAllowed } from "./helpers/electron-gui.ts";

const require = createRequire(import.meta.url);

/** Only `ESRCH` proves the group is gone; `EPERM` means it may well still exist. */
function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Processes still carrying this attempt's supervisor marker - what would hold the bundle. */
function supervisorsFor(attemptId: string): number[] {
  const rows = execFileSync("/bin/ps", ["-axww", "-o", "pid=,args="], {encoding: "utf8"}).split("\n");
  return rows.filter((row) => row.includes(CHECK_SUPERVISOR_MARKER) && row.includes(attemptId))
    .map((row) => Number(row.trim().split(/\s+/)[0]));
}

function bundle(stdin: string, outfile: string): void {
  buildSync({
    stdin: {contents: stdin, resolveDir: resolve("."), loader: "ts"},
    bundle: true, platform: "node", format: "cjs", external: ["electron"],
    alias: {"@shared": "./src/shared"}, outfile, logLevel: "silent",
  });
}

function fixtureApp(root: string): string {
  const app = join(root, "app");
  mkdirSync(app, {recursive: true});
  bundle(`
    export { superviseUtilityProcess } from "./src/main/utility-supervisor.ts";
    export { ownElectronBackgroundStart, drainBackgroundStart } from "./src/main/daemon-policy.ts";
    export { holdQuitUntilDrained } from "./src/main/quit-drain.ts";
  `, join(app, "background.cjs"));
  bundle(`
    import { writeFileSync } from "node:fs";
    import { spawnCheckProcess } from "./src/server/workflows/check-spawn.ts";
    import { killLiveCheckGroups } from "./src/server/workflows/check-group.ts";
    const out = process.env.FIXTURE_OUT!;
    const running = spawnCheckProcess({
      attemptId: process.env.FIXTURE_ATTEMPT!,
      command: ["/bin/sh", "-c", "printf ready > check-started; exec /bin/sleep 600"], cwd: out,
      env: {PATH: "/usr/bin:/bin"}, timeoutMs: 600_000,
      onSupervisorReady: (supervisor) => {
        writeFileSync(out + "/supervisor.json", JSON.stringify(supervisor));
        // Keep the command gate closed across several main-process polls. Registration is
        // deliberately observable before the check starts, as it can be under suite load.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      },
    });
    process.on("SIGTERM", async () => {
      await new Promise((r) => setTimeout(r, 5000));
      killLiveCheckGroups();
      const outcome = await running;
      writeFileSync(out + "/check-outcome.json", JSON.stringify({emptiness: outcome.emptiness, kind: outcome.result.kind}));
      process.exit(0);
    });
    setInterval(() => {}, 1000);
  `, join(app, "daemon.cjs"));
  writeFileSync(join(app, "package.json"), JSON.stringify({name: "quit-drain-fixture", main: "main.cjs"}));
  writeFileSync(join(app, "main.cjs"), `
    const {app} = require("electron");
    const {existsSync} = require("node:fs");
    const {join} = require("node:path");
    const bg = require("./background.cjs");
    const out = process.env.FIXTURE_OUT;
    const drain = process.env.FIXTURE_MODE === "drain";
    app.on("window-all-closed", () => {});
    app.whenReady().then(() => {
      const start = bg.ownElectronBackgroundStart(undefined, async () => {
        const controller = bg.superviseUtilityProcess({entry: join(__dirname, "daemon.cjs"), serviceName: "fixture-daemon",
          logPath: join(out, "daemon.log"), env: {...process.env}});
        return {adopted: false, stop: () => controller.stop()};
      }, async () => ({stop: async () => {}}));
      // The shipped handler. The control sends the stop and lets the quit proceed, which is
      // what the app did before this fix.
      bg.holdQuitUntilDrained(app, {
        beforeQuit: () => { if (!drain) void start.stop(); },
        owned: () => drain,
        drain: () => bg.drainBackgroundStart(start, 30000).then(() => {}),
      });
      const ready = setInterval(() => {
        // onSupervisorReady precedes gate release. Quitting on supervisor.json can kill the
        // daemon before branch code starts, so the control has no running check to leak.
        if (!existsSync(join(out, "check-started"))) return;
        clearInterval(ready);
        app.quit();
      }, 50);
    });
  `);
  return app;
}

for (const mode of ["send-only", "drain"] as const) {
  test(`quitting the app ${mode === "drain" ? "tears a real check group down before the app exits" : "without waiting leaves a real check running from the bundle (control)"}`, {
    skip: process.platform !== "darwin", timeout: 90_000,
  }, async (t) => {
    assertElectronGuiLaunchAllowed();
    const root = realpathSync(mkdtempSync(join(tmpdir(), "quit-drain-electron-")));
    const attemptId = `quit-drain-${mode}-${process.pid}-${Date.now()}`;
    let supervisor: {pid: number} | null = null;
    t.after(() => {
      if (supervisor && groupAlive(supervisor.pid)) { try { process.kill(-supervisor.pid, "SIGKILL"); } catch { /* gone */ } }
      rmSync(root, {recursive: true, force: true});
    });
    const out = join(root, "out"); mkdirSync(out);
    const app = fixtureApp(root);
    const env: NodeJS.ProcessEnv = {...process.env, FIXTURE_OUT: out, FIXTURE_MODE: mode, FIXTURE_ATTEMPT: attemptId};
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = spawn(require("electron") as string, [app], {env, stdio: ["ignore", "pipe", "pipe"]});
    let output = "";
    electron.stdout.on("data", (chunk) => { output += chunk; });
    electron.stderr.on("data", (chunk) => { output += chunk; });
    const code = await new Promise<number | null>((done) => electron.once("exit", done));
    assert.equal(code, 0, output);
    assert.ok(existsSync(join(out, "supervisor.json")), `the daemon never started its check\n${output}`);
    assert.ok(existsSync(join(out, "check-started")), "the check command never crossed its supervisor gate");
    supervisor = JSON.parse(readFileSync(join(out, "supervisor.json"), "utf8")) as {pid: number};
    // The helper's wait starts only after the app process has exited - which is now.
    if (mode === "drain") {
      assert.deepEqual(JSON.parse(readFileSync(join(out, "check-outcome.json"), "utf8")).emptiness, "empty",
        "the lease teardown could not prove the check's group empty before the app exited");
      assert.equal(groupAlive(supervisor.pid), false, `check group ${supervisor.pid} outlived the app that drained its daemon`);
      assert.deepEqual(supervisorsFor(attemptId), [], "a check supervisor still holds the bundle");
    } else {
      assert.equal(existsSync(join(out, "check-outcome.json")), false, "Electron let the daemon finish its teardown unwaited");
      assert.equal(groupAlive(supervisor.pid), true, "the control no longer reproduces the leak, so it no longer proves the drain matters");
      assert.deepEqual(supervisorsFor(attemptId), [supervisor.pid], "the leaked check is the marked supervisor the helper names");
    }
  });
}
