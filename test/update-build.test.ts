// The staged build, exercised against a real child process.
//
// Everything interesting here is the boundary with a spawned script: markers arriving split
// across chunks, a cancellation that has to reach the script's own children, and an install
// script too old to have the flag at all. A stubbed spawn would assert none of it, so these
// run a real `node` against a fake `scripts/install-app.mjs` in a temp clone.

import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CANCEL_EXIT_TIMEOUT_MS,
  stageInstallArgs,
  stageScriptPath,
  stageUpdateBuild,
  stagingUnsupported,
  updateChildEnvironment,
} from "../src/main/update-build.ts";
import { createRotatingUpdateLogger } from "../src/main/update-log.ts";
import {
  UPDATE_PROGRESS_MARKER,
  UPDATE_STAGED_MARKER,
  parseUpdateProgressLine,
  updatePrepareProgress,
} from "../src/shared/update.ts";

/**
 * Whether a pid is gone, waited for rather than sampled.
 *
 * A killed process exists as an unreaped zombie until its parent reaps it - and these
 * grandchildren are orphaned by the same kill that ends them, so the reaper is init. Sampling
 * `kill(pid, 0)` the instant `close` arrives therefore says "alive" on a loaded machine and
 * "gone" on an idle one, which is how this went red on one CI runner and green on the other.
 *
 * The property under test is that the group is dead and its pipes are closed - a zombie is
 * writing to nothing - so a short wait for the reaper is legitimate rather than a way of
 * hiding a real failure.
 */
async function waitForGone(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      // EPERM means alive and owned by somebody else, which is still alive.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** A clone whose install script is whatever the test needs it to be. */
function fakeClone(script: string): string {
  // Realpath, because the child reports paths from its own `process.cwd()` and macOS serves
  // the temp directory through a symlink.
  const clone = realpathSync(mkdtempSync(join(tmpdir(), "mission-stage-")));
  mkdirSync(join(clone, "scripts"), { recursive: true });
  writeFileSync(join(clone, "scripts", "install-app.mjs"), script, { encoding: "utf8" });
  return clone;
}

const BUNDLE = "release/mac-arm64/Mission Control.app";

test("the staged build asks the clone's own install script for the build alone", () => {
  const script = stageScriptPath("/state/app-src");
  assert.equal(script, "/state/app-src/scripts/install-app.mjs");
  assert.deepEqual(stageInstallArgs(script, "v1.2.4"), [
    "/state/app-src/scripts/install-app.mjs",
    "--ref",
    "v1.2.4",
    "--stage-only",
    "--progress",
  ]);
  // No --apps-dir: a staged build never reaches an installed app.
  assert.ok(!stageInstallArgs(script, "v1.2.4").includes("--apps-dir"));
});

test("the login-shell PATH reaches the build, which has to find git and npm", () => {
  assert.deepEqual(
    updateChildEnvironment({ PATH: "/usr/bin:/bin", MISSION_HOME: "/state" }, "/opt/homebrew/bin:/usr/bin"),
    { PATH: "/opt/homebrew/bin:/usr/bin", MISSION_HOME: "/state" },
  );
});

test("a staged build reports every stage it reaches and the bundle it produced", async () => {
  const clone = fakeClone(`
const bundle = process.cwd() + "/${BUNDLE}";
// Written without a trailing newline first, so the reader has to buffer a partial line.
process.stdout.write("${UPDATE_PROGRESS_MARKER} prereq");
process.stdout.write("uisites\\nnpm warn deprecated something\\n");
for (const stage of ["source", "release", "checkout", "dependencies", "build", "verify"]) {
  process.stdout.write("${UPDATE_PROGRESS_MARKER} " + stage + "\\n");
}
process.stderr.write("electron-builder  building target=macOS\\n");
process.stdout.write("${UPDATE_PROGRESS_MARKER} nonsense-from-a-future-release\\n");
process.stdout.write("${UPDATE_STAGED_MARKER} 1.7.0 4242-1700000000000 " + bundle + "\\n");
`);
  try {
    const stages: string[] = [];
    const logged: string[] = [];
    const outcome = await stageUpdateBuild({
      node: process.execPath,
      sourceClone: clone,
      targetTag: "v1.7.0",
      signal: new AbortController().signal,
      onStage: (stage) => stages.push(stage),
      log: (line) => logged.push(line),
    });

    assert.equal(outcome.ok, true);
    if (outcome.ok) {
      assert.equal(outcome.staged.version, "1.7.0");
      assert.equal(outcome.staged.bundlePath, join(clone, BUNDLE));
      // Read by the script when it verified the bundle, not by this process afterwards.
      assert.equal(outcome.staged.revision, "4242-1700000000000");
    }
    assert.deepEqual(stages, [
      "prerequisites",
      "source",
      "release",
      "checkout",
      "dependencies",
      "build",
      "verify",
    ]);
    // A stage this version does not know is logged and ignored, never mapped onto a step.
    assert.ok(logged.some((line) => line.includes("nonsense-from-a-future-release")));
    // The build's own words survive, which is the only way an npm failure is ever diagnosed.
    assert.ok(logged.some((line) => line.includes("npm warn deprecated")));
    assert.ok(logged.some((line) => line.includes("electron-builder")));
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test("cancelling a staged build takes the script's own children with it", async () => {
  // The child writes a pid file for a grandchild that would outlive a plain `child.kill()`,
  // which is exactly what npm and electron-builder are in the real run.
  const clone = fakeClone(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env.MISSION_TEST_PID_FILE, String(child.pid));
process.stdout.write("${UPDATE_PROGRESS_MARKER} dependencies\\n");
setInterval(() => {}, 1000);
`);
  const pidFile = join(clone, "grandchild.pid");
  process.env.MISSION_TEST_PID_FILE = pidFile;
  try {
    const abort = new AbortController();
    const stages: string[] = [];
    const running = stageUpdateBuild({
      node: process.execPath,
      sourceClone: clone,
      targetTag: "v1.7.0",
      signal: abort.signal,
      onStage: (stage) => {
        stages.push(stage);
        abort.abort();
      },
      log: () => {},
    });

    const outcome = await running;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "cancelled");
    assert.deepEqual(stages, ["dependencies"]);

    const grandchild = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
    assert.ok(grandchild, "the fake build should have recorded a grandchild pid");
    const gone = await waitForGone(grandchild!);
    if (!gone) process.kill(grandchild!, "SIGKILL");
    assert.equal(gone, true, "the grandchild should have been killed with the process group");
  } finally {
    delete process.env.MISSION_TEST_PID_FILE;
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a cancelled build is not reported cancelled until its process group is gone", async () => {
  // The offer used to come back the instant SIGKILL was sent, so one click on Update Now
  // could start a fresh `git checkout --force` and `npm ci` in the clone that the dying npm
  // and electron-builder were still writing to. The grandchild here stands in for them: it
  // holds the output pipes open, so `close` - and only `close` - proves they are gone.
  const clone = fakeClone(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
// Inherits this process's stdio, so it holds the pipes the parent reads.
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });
writeFileSync(process.env.MISSION_TEST_PID_FILE, String(child.pid));
process.stdout.write("${UPDATE_PROGRESS_MARKER} dependencies\\n");
setInterval(() => {}, 1000);
`);
  const pidFile = join(clone, "grandchild.pid");
  process.env.MISSION_TEST_PID_FILE = pidFile;
  try {
    const abort = new AbortController();
    let settled = false;
    const running = stageUpdateBuild({
      node: process.execPath,
      sourceClone: clone,
      targetTag: "v1.7.0",
      signal: abort.signal,
      onStage: () => abort.abort(),
      log: () => {},
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    // The signal has been sent by now, and the promise must NOT have resolved on it alone.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, "cancel must wait for the group, not for the signal");

    const outcome = await running;
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "cancelled");

    // And the group it was waiting for is dead - which is the whole point. Waited for rather
    // than sampled: the kill orphans these processes, so init reaps them, and how quickly it
    // does is not something this test gets to assert.
    const grandchild = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
    assert.ok(grandchild, "the fake build should have recorded a grandchild pid");
    const gone = await waitForGone(grandchild!);
    if (!gone) process.kill(grandchild!, "SIGKILL");
    assert.equal(gone, true, "the group must be gone before the offer comes back");
  } finally {
    delete process.env.MISSION_TEST_PID_FILE;
    rmSync(clone, { recursive: true, force: true });
  }
});

test("the wait for a cancelled build is bounded, so a wedged one still answers", () => {
  // SIGKILL cannot be caught, so this bound is not a grace period - it is for a process stuck
  // in uninterruptible I/O, where waiting forever would make cancelling itself hang.
  assert.equal(CANCEL_EXIT_TIMEOUT_MS, 10_000);
  assert.ok(CANCEL_EXIT_TIMEOUT_MS < 60_000, "a person pressing Cancel is waiting for this");
});

test("an install script without the staging flags is reported as unsupported, not as a failure", async () => {
  const clone = fakeClone(`
console.error("unknown argument: --stage-only");
process.exitCode = 1;
`);
  try {
    const outcome = await stageUpdateBuild({
      node: process.execPath,
      sourceClone: clone,
      targetTag: "v1.7.0",
      signal: new AbortController().signal,
      onStage: () => {},
      log: () => {},
    });
    assert.equal(outcome.ok, false);
    // The caller falls back to the whole-install handoff on this reason alone, so it must not
    // be reported as an ordinary build failure.
    if (!outcome.ok) assert.equal(outcome.reason, "unsupported");
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test("unsupported is recognized from either flag, and never from an unrelated failure", () => {
  assert.equal(stagingUnsupported("unknown argument: --stage-only"), true);
  assert.equal(stagingUnsupported("unknown argument: --progress"), true);
  assert.equal(stagingUnsupported("npm error unknown argument: --stage-only-ish"), false);
  assert.equal(stagingUnsupported("electron-builder failed: unknown argument"), false);
  assert.equal(stagingUnsupported(""), false);
});

test("a build that fails, and one that reports no bundle, are both refused", async () => {
  const failing = fakeClone(`
console.error("npm error code ELIFECYCLE");
process.exitCode = 1;
`);
  const silent = fakeClone(`
process.stdout.write("${UPDATE_PROGRESS_MARKER} verify\\n");
`);
  try {
    const failed = await stageUpdateBuild({
      node: process.execPath,
      sourceClone: failing,
      targetTag: "v1.7.0",
      signal: new AbortController().signal,
      onStage: () => {},
      log: () => {},
    });
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.reason, "failed");
      assert.match(failed.message, /exit 1/);
    }

    const nothing = await stageUpdateBuild({
      node: process.execPath,
      sourceClone: silent,
      targetTag: "v1.7.0",
      signal: new AbortController().signal,
      onStage: () => {},
      log: () => {},
    });
    assert.equal(nothing.ok, false);
    if (!nothing.ok) {
      assert.equal(nothing.reason, "failed");
      assert.match(nothing.message, /without reporting an app to install/);
    }
  } finally {
    rmSync(failing, { recursive: true, force: true });
    rmSync(silent, { recursive: true, force: true });
  }
});

test("a hung build settles anyway when something escapes the kill and holds the pipes", async (t) => {
  // The bound exists for the case that actually breaks the promise: a descendant in its OWN
  // process group, which the group kill cannot reach, still holding the output pipes open. The
  // child's `close` then never arrives, and waiting on it unconditionally would leave the
  // banner reading `preparing` for good - the opposite of what a documented timeout is for.
  const clone = fakeClone(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
// detached: its own process group, so the kill of ours does not touch it. It inherits stdio,
// so it holds the pipes this test's reader is attached to.
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "inherit",
});
escaped.unref();
writeFileSync(process.env.MISSION_TEST_PID_FILE, String(escaped.pid));
setInterval(() => {}, 1000);
`);
  const pidFile = join(clone, "escaped.pid");
  process.env.MISSION_TEST_PID_FILE = pidFile;
  t.after(() => {
    delete process.env.MISSION_TEST_PID_FILE;
    if (existsSync(pidFile)) {
      const escaped = Number(readFileSync(pidFile, "utf8").trim());
      try {
        process.kill(escaped, "SIGKILL");
      } catch {
        // Already gone, which is the only other acceptable state.
      }
    }
    rmSync(clone, { recursive: true, force: true });
  });

  const logged: string[] = [];
  const outcome = await stageUpdateBuild({
    node: process.execPath,
    sourceClone: clone,
    targetTag: "v1.7.0",
    signal: new AbortController().signal,
    onStage: () => {},
    log: (line) => logged.push(line),
    // Leave enough time for the nested Node process to start under the suite's eight-way CI
    // contention. The exit bound below is the behavior this case is exercising.
    timeoutMs: 2_000,
    exitTimeoutMs: 400,
  });

  // It settled, which is the whole point, and it says what it actually knows.
  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "failed");
    assert.match(outcome.message, /did not finish within/);
  }
  assert.ok(
    logged.some((line) => line.includes("still holding on")),
    `the uncertain shutdown should be logged: ${logged.join(" | ")}`,
  );
});

test("a cancelled build settles anyway when something escapes the kill", async (t) => {
  const clone = fakeClone(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "inherit",
});
escaped.unref();
writeFileSync(process.env.MISSION_TEST_PID_FILE, String(escaped.pid));
process.stdout.write("${UPDATE_PROGRESS_MARKER} dependencies\\n");
setInterval(() => {}, 1000);
`);
  const pidFile = join(clone, "escaped.pid");
  process.env.MISSION_TEST_PID_FILE = pidFile;
  t.after(() => {
    delete process.env.MISSION_TEST_PID_FILE;
    if (existsSync(pidFile)) {
      const escaped = Number(readFileSync(pidFile, "utf8").trim());
      try {
        process.kill(escaped, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(clone, { recursive: true, force: true });
  });

  const abort = new AbortController();
  const outcome = await stageUpdateBuild({
    node: process.execPath,
    sourceClone: clone,
    targetTag: "v1.7.0",
    signal: abort.signal,
    onStage: () => abort.abort(),
    log: () => {},
    exitTimeoutMs: 400,
  });

  assert.equal(outcome.ok, false);
  if (!outcome.ok) {
    assert.equal(outcome.reason, "cancelled");
    // Said plainly rather than claiming a clean stop, because this one is not certain.
    assert.match(outcome.message, /may still be shutting down/);
  }
});

test("a clone whose killed build never exited is refused to the next build", async (t) => {
  // Settling on a bound instead of on `close` is what makes this necessary: `close` is the only
  // proof every descendant let go of the output pipes, and so of the clone. Until it arrives,
  // starting another build would run `git checkout --force` and `npm ci` in a directory the
  // dying group may still be writing to.
  const clone = fakeClone(`
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const escaped = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  detached: true,
  stdio: "inherit",
});
escaped.unref();
writeFileSync(process.env.MISSION_TEST_PID_FILE, String(escaped.pid));
setInterval(() => {}, 1000);
`);
  const pidFile = join(clone, "escaped.pid");
  process.env.MISSION_TEST_PID_FILE = pidFile;
  let escaped: number | null = null;
  t.after(() => {
    delete process.env.MISSION_TEST_PID_FILE;
    // Whatever the LAST run left behind, not the pid captured mid-test: every run of this fake
    // build escapes a descendant, and one left alive holds the pipes and the event loop with it.
    const leaked = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
    for (const pid of new Set([escaped, leaked].filter((value): value is number => value !== null))) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    rmSync(clone, { recursive: true, force: true });
  });

  const logged: string[] = [];
  const first = await stageUpdateBuild({
    node: process.execPath,
    sourceClone: clone,
    targetTag: "v1.7.0",
    signal: new AbortController().signal,
    onStage: () => {},
    log: (line) => logged.push(line),
    // The fake must first record its escaped descendant. A 200 ms launch allowance raced Node
    // startup under the full suite and made this assertion describe scheduler load instead.
    timeoutMs: 2_000,
    exitTimeoutMs: 300,
  });
  assert.equal(first.ok, false);
  escaped = existsSync(pidFile) ? Number(readFileSync(pidFile, "utf8").trim()) : null;
  assert.ok(escaped, "the fake build should have recorded the descendant that escaped");

  // The descendant still holds the pipes, so `close` has not arrived and the clone is not free.
  const second = await stageUpdateBuild({
    node: process.execPath,
    sourceClone: clone,
    targetTag: "v1.7.0",
    signal: new AbortController().signal,
    onStage: () => {},
    log: (line) => logged.push(line),
    timeoutMs: 2_000,
    exitTimeoutMs: 300,
  });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.reason, "failed");
    assert.match(second.message, /has not finished shutting down/);
  }
  assert.ok(
    logged.some((line) => line.includes("refusing to start another one over it")),
    logged.join(" | "),
  );

  // Once it finally lets go, the clone is usable again.
  process.kill(escaped!, "SIGKILL");
  escaped = null;
  const third = await stageUpdateBuild({
    node: process.execPath,
    sourceClone: clone,
    targetTag: "v1.7.0",
    signal: new AbortController().signal,
    onStage: () => {},
    log: () => {},
    timeoutMs: 200,
    exitTimeoutMs: 300,
  });
  // It ran this time - and timed out on its own terms, which is a different refusal.
  assert.equal(third.ok, false);
  if (!third.ok) assert.match(third.message, /did not finish within/);
});

test("a build that outruns its limit is stopped and says so", async () => {
  const clone = fakeClone(`setInterval(() => {}, 1000);`);
  try {
    const outcome = await stageUpdateBuild({
      node: process.execPath,
      sourceClone: clone,
      targetTag: "v1.7.0",
      signal: new AbortController().signal,
      onStage: () => {},
      log: () => {},
      timeoutMs: 150,
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.reason, "failed");
      assert.match(outcome.message, /did not finish/);
    }
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});

test("a bundle path with spaces survives the marker, and a plain line is not one", () => {
  const line = `${UPDATE_STAGED_MARKER} 1.7.0 99-1700000000000 /state/app-src/${BUNDLE}`;
  assert.deepEqual(parseUpdateProgressLine(line), {
    kind: "staged",
    version: "1.7.0",
    revision: "99-1700000000000",
    bundlePath: `/state/app-src/${BUNDLE}`,
  });
  // Two fields, from a clone whose script predates the revision: the path is always absolute,
  // which is what tells the two shapes apart.
  assert.deepEqual(parseUpdateProgressLine(`${UPDATE_STAGED_MARKER} 1.7.0 /state/${BUNDLE}`), {
    kind: "staged",
    version: "1.7.0",
    revision: null,
    bundlePath: `/state/${BUNDLE}`,
  });
  assert.equal(parseUpdateProgressLine("  npm ci  "), null);
  assert.equal(parseUpdateProgressLine(`${UPDATE_PROGRESS_MARKER}`), null);
  assert.deepEqual(parseUpdateProgressLine(`${UPDATE_PROGRESS_MARKER} build`), {
    kind: "stage",
    stage: "build",
  });
});

test("the bar advances monotonically and never sits at the end while work remains", () => {
  const stages = [
    "starting",
    "prerequisites",
    "source",
    "release",
    "checkout",
    "dependencies",
    "build",
    "verify",
  ];
  let previous = -1;
  for (const [index, stage] of stages.entries()) {
    const progress = updatePrepareProgress(stage);
    assert.equal(progress.step, index + 1);
    assert.equal(progress.steps, stages.length);
    assert.ok(progress.percent > previous, `${stage} must advance the bar`);
    assert.ok(progress.percent < 100, `${stage} is not the end of the update`);
    previous = progress.percent;
  }
  // The two long stages are deliberately low: a bar parked near the end for two minutes is
  // the wedged-looking experience this replaces.
  assert.ok(updatePrepareProgress("dependencies").percent <= 40);
  assert.ok(updatePrepareProgress("build").percent <= 60);
  // An id from a future release resolves rather than throwing; a progress bar must never be
  // the thing that fails an update.
  assert.equal(updatePrepareProgress("something-new").step, 1);
});


test("the build's own output reaches the real update log redacted", async () => {
  // The one channel in the whole update whose text this app did not write. `npm` and
  // `electron-builder` print absolute paths as a matter of course, and a registry line can
  // carry a credential; both would otherwise sit in the state directory in clear.
  //
  // Asserted against the REAL logger writing a REAL file, because that is the pipeline a
  // person's `update.log` goes through. A fake `log` collector would prove only that the
  // string reached a function.
  const clone = fakeClone(`
process.stdout.write("npm error path /Users/someone/.mission-control/app-src/node_modules\\n");
process.stdout.write("npm notice Authorization: Bearer gho_supersecrettoken1234\\n");
process.stdout.write("electron-builder  packaging  file=/Users/someone/Library/Caches/electron\\n");
process.stdout.write("npm error request to https://deploy:hunter2@registry.internal.example.dev/lodash failed\\n");
process.stderr.write("fatal: unable to access 'https://github.com/teamupstart/mission-control.git/': 403\\n");
process.stderr.write("remote: git@github.com:teamupstart/mission-control.git\\n");
process.stdout.write("${UPDATE_PROGRESS_MARKER} build\\n");
process.stdout.write("${UPDATE_STAGED_MARKER} 1.7.0 " + process.cwd() + "/${BUNDLE}\\n");
`);
  const logPath = join(clone, "update.log");
  try {
    // Both halves of the pipeline at once: what `stageUpdateBuild` HANDS to a logger, and what
    // the real logger then writes. Each is asserted separately, so neither can be the one
    // place that redacts while the other quietly stops.
    const handedOut: string[] = [];
    const write = createRotatingUpdateLogger(logPath);
    const outcome = await stageUpdateBuild({
      node: process.execPath,
      sourceClone: clone,
      targetTag: "v1.7.0",
      signal: new AbortController().signal,
      onStage: () => {},
      log: (line) => {
        handedOut.push(line);
        write(line);
      },
    });

    assert.equal(outcome.ok, true);
    // The boundary: already safe before any logger sees it.
    const handed = handedOut.join("\n");
    assert.doesNotMatch(handed, /gho_supersecrettoken1234/);
    assert.doesNotMatch(handed, /\/Users\/someone/);
    assert.doesNotMatch(handed, /hunter2|registry\.internal\.example\.dev/);
    assert.doesNotMatch(handed, /github\.com/);
    assert.match(handed, /npm error path <path>/);

    const written = readFileSync(logPath, "utf8");
    // The build's own words survive - that is the whole reason these lines are kept.
    assert.match(written, /npm error path/);
    assert.match(written, /electron-builder\s+packaging/);
    assert.match(written, /npm error request to <url> failed/);
    assert.match(written, /unable to access '<url>': 403/);
    // What must not survive: a credential, a token, a home directory, or a remote host - in a
    // registry URL or in either spelling of a git remote.
    assert.doesNotMatch(written, /gho_supersecrettoken1234/);
    assert.doesNotMatch(written, /\/Users\/someone/);
    assert.doesNotMatch(written, /Bearer/);
    assert.doesNotMatch(written, /hunter2/);
    assert.doesNotMatch(written, /registry\.internal\.example\.dev/);
    assert.doesNotMatch(written, /github\.com/);
    assert.match(written, /<path>/);
    assert.match(written, /<url>/);
    assert.match(written, /Authorization: <redacted>/);
    // And the bundle path itself still reached the caller intact: only the LOGGED copy is
    // redacted, or there would be nothing to install.
    if (outcome.ok) assert.equal(outcome.staged.bundlePath, join(clone, BUNDLE));
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
});
