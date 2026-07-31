import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  createCheckGroupRecovery,
  runSupervisedCheck,
} from "../src/server/workflows/check-supervisor.ts";
import {
  liveCheckGroupCount,
  terminateCheckGroup,
} from "../src/server/workflows/check-group.ts";
import {
  processStartIdentity,
  resetCheckRuntimeSupportCache,
} from "../src/server/workflows/check-identity.ts";
import type { CheckProcessRegistry } from "../src/server/workflows/check-lease.ts";

// The gate, and the rules that decide whether a signal may be sent.
//
// The two properties everything here defends:
//
//  1. **Persist, THEN release.** There is no window in which branch code is running without a
//     durable owner, so a daemon killed mid-check leaves a row that can tell "never started"
//     from "may still be running".
//  2. **Never signal what you cannot identify.** A pid read back from a durable row may have
//     been recycled, and `kill(-pid)` on a recycled pid terminates a stranger's process group.

const NODE = process.execPath;
const dirs: string[] = [];
/** Raw process groups a case started outside the supervisor, so the suite can clean up. */
const raw: number[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mission-check-sup-"));
  dirs.push(dir);
  return dir;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** A long-lived detached group we control, for the cases that must NOT be signalled. */
function bystander(): { pid: number; identity: string } {
  const child = spawn(NODE, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid!;
  raw.push(pid);
  const identity = processStartIdentity(pid);
  assert.notEqual(identity, null, "this platform must be able to read its own start identities");
  return { pid, identity: identity! };
}

after(() => {
  for (const pid of raw) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  assert.equal(liveCheckGroupCount(), 0, "the suite left a group registered for the exit hook");
});

/** A registry that records what it was told, and when relative to the branch command. */
function recordingRegistry(over: Partial<CheckProcessRegistry> = {}): {
  registry: CheckProcessRegistry;
  records: Array<{ attemptId: string; pid: number; startTimeTicks: string }>;
  cleared: string[];
} {
  const records: Array<{ attemptId: string; pid: number; startTimeTicks: string }> = [];
  const cleared: string[] = [];
  const registry: CheckProcessRegistry = {
    record: (attemptId, pid, startTimeTicks) => records.push({ attemptId, pid, startTimeTicks }),
    clear: (attemptId) => cleared.push(attemptId),
    ...over,
  };
  return { registry, records, cleared };
}

// ---- the gate --------------------------------------------------------------

test("identity is persisted BEFORE branch code runs", async () => {
  const dir = workspace();
  const marker = join(dir, "branch-ran");
  const markerWhenRecorded: boolean[] = [];
  const { registry, records, cleared } = recordingRegistry();
  const gated: CheckProcessRegistry = {
    ...registry,
    record: (attemptId, pid, ticks) => {
      // The branch command's FIRST act is to create this file. Observing its absence at the
      // moment of the persist is what proves the ordering, rather than trusting the code that
      // implements it.
      markerWhenRecorded.push(existsSync(marker));
      registry.record(attemptId, pid, ticks);
    },
  };

  const outcome = await runSupervisedCheck(
    {
      attemptId: "attempt-order",
      command: ["sh", "-c", 'touch "$1"; echo done', "sh", marker],
      leasePath: dir,
      workingSubpath: "",
    },
    { registry: gated, daemonToken: "" },
  );

  assert.equal(outcome.result.kind, "exited");
  assert.equal(records.length, 1);
  assert.deepEqual(markerWhenRecorded, [false], "branch code had already run when identity was persisted");
  assert.equal(existsSync(marker), true, "and the branch command did run afterwards");
  assert.equal(outcome.emptiness, "empty");
  assert.deepEqual(cleared, ["attempt-order"], "a proven-empty group releases its identity");
});

test("a failure to persist leaves the sentinel and never runs branch code", async () => {
  const dir = workspace();
  const marker = join(dir, "branch-ran");
  const { registry, cleared } = recordingRegistry({
    record: () => {
      throw new Error("the durable write failed");
    },
  });

  const outcome = await runSupervisedCheck(
    {
      attemptId: "attempt-no-persist",
      command: ["sh", "-c", 'touch "$1"', "sh", marker],
      leasePath: dir,
      workingSubpath: "",
    },
    { registry, daemonToken: "" },
  );

  assert.equal(outcome.result.kind, "infrastructure");
  assert.match(
    outcome.result.kind === "infrastructure" ? outcome.result.reason : "",
    /could not be persisted/,
  );
  assert.equal(existsSync(marker), false, "the gate never opened, so no branch code ran");
  // Null is the honest report: with no owner recorded, the durable row keeps its sentinel and
  // recovery knows that nothing ever started.
  assert.equal(outcome.supervisor, null);
  assert.deepEqual(cleared, [], "there is no identity to clear");
});

test("the identity survives the gate release - the regression an exec-ing shim would cause", async () => {
  const dir = workspace();
  let seen: { pid: number; startTimeTicks: string } | null = null;
  let resolveRecorded: () => void = () => {};
  const recorded = new Promise<void>((r) => {
    resolveRecorded = r;
  });
  const { registry } = recordingRegistry({
    record: (_attemptId, pid, startTimeTicks) => {
      seen = { pid, startTimeTicks };
      resolveRecorded();
    },
  });

  const running = runSupervisedCheck(
    {
      attemptId: "attempt-stable-identity",
      command: ["sh", "-c", "sleep 2"],
      leasePath: dir,
      workingSubpath: "",
    },
    { registry, daemonToken: "" },
  );

  await recorded;
  const owner = seen as { pid: number; startTimeTicks: string } | null;
  assert.notEqual(owner, null);
  // Long enough that the branch command is certainly running by now. Every other case here
  // reads identity BEFORE the command starts, so this is the only one that would notice a shim
  // that replaced its own command line - and that shim would strand the lease of every live
  // check, refusing to signal a group it could no longer recognise.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(
    processStartIdentity(owner!.pid),
    owner!.startTimeTicks,
    "the supervisor's identity must not change when the command starts",
  );

  const outcome = await running;
  assert.equal(outcome.result.kind, "exited");
});

// ---- teardown reaches descendants ------------------------------------------

test("SIGTERM to the group reaches a grandchild, and emptiness waits for it", async () => {
  const dir = workspace();
  const pidFile = join(dir, "grandchild.pid");
  const { registry } = recordingRegistry();

  const outcome = await runSupervisedCheck(
    {
      attemptId: "attempt-grandchild",
      // The branch command backgrounds a second process and waits: two descendants of the
      // supervisor, only one of which a naive kill of the leader would reach.
      command: ["sh", "-c", 'sleep 30 & echo $! > "$1"; wait', "sh", pidFile],
      leasePath: dir,
      workingSubpath: "",
      timeoutMs: 700,
    },
    { registry, daemonToken: "" },
  );

  const grandchild = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(grandchild > 1, "the branch command recorded its own background child");
  assert.equal(outcome.result.kind, "infrastructure");
  assert.equal(outcome.emptiness, "empty");
  // The point of the whole emptiness proof: the leader exiting is not the question, and this
  // process is what would have kept writing into the leased tree.
  assert.equal(pidAlive(grandchild), false, "emptiness was reported while a descendant still ran");
});

test("a grandchild ignoring SIGTERM is SIGKILLed after the grace", async () => {
  const dir = workspace();
  const pidFile = join(dir, "stubborn.pid");
  writeFileSync(
    join(dir, "stubborn.mjs"),
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.argv[2], String(process.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  const { registry } = recordingRegistry();

  const started = Date.now();
  const outcome = await runSupervisedCheck(
    {
      attemptId: "attempt-stubborn",
      command: ["sh", "-c", '"$1" ./stubborn.mjs "$2" & wait', "sh", NODE, pidFile],
      leasePath: dir,
      workingSubpath: "",
      timeoutMs: 700,
    },
    { registry, daemonToken: "", teardown: { graceMs: 400, confirmMs: 5_000, pollMs: 25 } },
  );

  const stubborn = Number(readFileSync(pidFile, "utf8").trim());
  assert.ok(stubborn > 1);
  assert.equal(outcome.emptiness, "empty", "the escalation to SIGKILL is what finishes this");
  assert.equal(pidAlive(stubborn), false);
  assert.ok(
    Date.now() - started >= 700 + 400,
    "the grace period must actually be waited out before escalating",
  );
});

// ---- identity is what licenses a signal ------------------------------------

test("a mismatched start identity is NEVER signalled", async () => {
  const { pid, identity } = bystander();
  // A live pid recorded with a deliberately wrong identity: exactly the shape of a durable row
  // whose supervisor died and whose pid the operating system handed to somebody else.
  const verdict = await terminateCheckGroup(pid, `${identity}-not-the-same-process`, {
    graceMs: 50,
    confirmMs: 50,
    pollMs: 10,
  });
  assert.equal(verdict, "unknown", "an unproven group is kept, never signalled");
  assert.equal(pidAlive(pid), true, "signalling this would have killed a stranger's process group");
});

test("each half of the composite identity is load-bearing on its own", async () => {
  const { pid, identity } = bystander();
  // Split only in the test, and only to prove the composite is doing work. Everything in
  // production treats this string as opaque.
  const halves = identity.split(String.fromCharCode(0x1f));
  assert.equal(halves.length, 3, "platform, start time, condensed command line");

  // The case the composite exists for: a pid recycled inside the same whole SECOND, so the
  // start-time half matches and only the command line can tell them apart. A single-field
  // identity would sail through this and signal a stranger.
  const sameStart = [halves[0], halves[1], "0".repeat(32)].join(String.fromCharCode(0x1f));
  assert.equal(await terminateCheckGroup(pid, sameStart, { graceMs: 20, confirmMs: 20, pollMs: 10 }), "unknown");
  assert.equal(pidAlive(pid), true);

  // And the mirror: our own shim, for our own attempt, started at a different time - a pid
  // reused by a second daemon running the same code.
  const sameCommand = [halves[0], "Thu Jan 1 00:00:00 1970", halves[2]].join(String.fromCharCode(0x1f));
  assert.equal(await terminateCheckGroup(pid, sameCommand, { graceMs: 20, confirmMs: 20, pollMs: 10 }), "unknown");
  assert.equal(pidAlive(pid), true);

  // The control: the real identity does authorise the signal, so the two refusals above are
  // about identity rather than about the function refusing everything.
  assert.equal(await terminateCheckGroup(pid, identity, { graceMs: 200, confirmMs: 2_000, pollMs: 10 }), "empty");
  assert.equal(pidAlive(pid), false);
});

test("a sentinel pid is never signalled, whatever it would have named", async () => {
  // `0` and `-1` are wildcards to `kill`: `kill(-0)` signals the daemon's OWN process group and
  // `kill(-1)` signals every process this user can touch. Both are reachable from a column
  // whose "nothing ever ran" sentinel is the number zero.
  for (const pid of [0, 1, -1, Number.NaN]) {
    assert.equal(await terminateCheckGroup(pid, "any-identity"), "empty");
  }
  assert.equal(await terminateCheckGroup(4_194_305, ""), "empty", "an empty identity is the sentinel too");
});

test("a group still answering at the bound is not reported empty", async () => {
  const { pid, identity } = bystander();
  // Zero budgets: the ladder runs but every probe gives up immediately, which is the only
  // deterministic way to reach the "we asked and it was still there" branch.
  const verdict = await terminateCheckGroup(pid, identity, { graceMs: 0, confirmMs: 0, pollMs: 1 });
  assert.notEqual(verdict, "empty", "THE safety property: only proven emptiness may return a lease");
  assert.equal(verdict, "not-empty", "and we know why - the group answered, rather than being unreadable");
});

// ---- the recovery seam -----------------------------------------------------

test("recovery proves a live group dead, and reports the tri-state honestly", async () => {
  const { pid, identity } = bystander();
  const recovery = createCheckGroupRecovery(() => ({ pid, startTimeTicks: identity }), {
    graceMs: 200,
    confirmMs: 2_000,
    pollMs: 10,
  });
  assert.equal(await recovery("attempt-live"), "empty");
  assert.equal(pidAlive(pid), false);
});

test("recovery of a row that recorded nothing is `empty` - nothing ever ran", async () => {
  // A missing row reads as null...
  assert.equal(await createCheckGroupRecovery(() => null)("attempt-never-started"), "empty");
  // ...and a supplier that hands the raw sentinel columns through instead reaches the same
  // answer, because the teardown ladder refuses a non-signallable pid on its own. The sentinel
  // comparison therefore cannot be got wrong by whoever wires this up.
  assert.equal(
    await createCheckGroupRecovery(() => ({ pid: 0, startTimeTicks: "" }))("attempt-sentinel"),
    "empty",
  );
});

test("recovery of a recycled pid is `unknown`, and signals nothing", async () => {
  const { pid, identity } = bystander();
  const recovery = createCheckGroupRecovery(() => ({ pid, startTimeTicks: `${identity}-stale` }), {
    graceMs: 20,
    confirmMs: 20,
    pollMs: 10,
  });
  assert.equal(await recovery("attempt-recycled"), "unknown");
  assert.equal(pidAlive(pid), true);
});

// ---- refusals that happen before anything is spawned -----------------------

test("an unsupported platform reports unavailable and starts nothing", async () => {
  const dir = workspace();
  const marker = join(dir, "branch-ran");
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  resetCheckRuntimeSupportCache();
  try {
    const { registry, records } = recordingRegistry();
    const outcome = await runSupervisedCheck(
      {
        attemptId: "attempt-win32",
        command: ["sh", "-c", 'touch "$1"', "sh", marker],
        leasePath: dir,
        workingSubpath: "",
      },
      { registry, daemonToken: "" },
    );
    assert.equal(outcome.result.kind, "unavailable");
    // Naming the platform is the point: this is the "a gate no runtime can serve" outcome, and
    // an operator has to be able to tell it from a command they configured wrongly.
    assert.match(outcome.result.kind === "unavailable" ? outcome.result.note : "", /win32/);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(records, []);
  } finally {
    Object.defineProperty(process, "platform", { value: original, configurable: true });
    resetCheckRuntimeSupportCache();
  }
});

test("a working subpath that leaves the leased tree is refused", async () => {
  const dir = workspace();
  for (const workingSubpath of ["..", "../elsewhere", "/etc", "packages/../../up"]) {
    const { registry, records } = recordingRegistry();
    const outcome = await runSupervisedCheck(
      { attemptId: "attempt-escape", command: ["sh", "-c", "echo hi"], leasePath: dir, workingSubpath },
      { registry, daemonToken: "" },
    );
    assert.equal(outcome.result.kind, "infrastructure", `${workingSubpath} should be refused`);
    assert.deepEqual(records, [], "nothing was spawned, so nothing was recorded");
  }
});

test("a working subpath that is a SYMLINK out of the leased tree is refused", async () => {
  const dir = workspace();
  // Somewhere the run never captured, standing in for the rest of the machine.
  const outside = workspace();
  writeFileSync(join(outside, "not-the-captured-commit"), "");
  // A branch can commit this: git stores symlinks, and a leased worktree is a checkout of
  // branch-authored content. The subpath the operator configured - `packages/web` - is
  // lexically perfect and points straight out of the tree.
  mkdirSync(join(dir, "packages"), { recursive: true });
  symlinkSync(outside, join(dir, "packages", "web"), "dir");

  const { registry, records } = recordingRegistry();
  const outcome = await runSupervisedCheck(
    {
      attemptId: "attempt-symlink-escape",
      command: ["sh", "-c", "ls"],
      leasePath: dir,
      workingSubpath: "packages/web",
    },
    { registry, daemonToken: "" },
  );

  assert.equal(outcome.result.kind, "infrastructure");
  assert.match(
    outcome.result.kind === "infrastructure" ? outcome.result.reason : "",
    /outside the worktree it was leased/,
  );
  assert.deepEqual(records, [], "nothing was spawned, so nothing was recorded");
});

test("a symlink that stays INSIDE the leased tree is still honoured", async () => {
  // The over-blocking check. Resolving symlinks must refuse the escape without refusing the
  // ordinary monorepo layouts that link one directory to another within the same checkout.
  const dir = workspace();
  mkdirSync(join(dir, "real", "web"), { recursive: true });
  writeFileSync(join(dir, "real", "web", "here"), "");
  mkdirSync(join(dir, "packages"), { recursive: true });
  symlinkSync(join(dir, "real", "web"), join(dir, "packages", "web"), "dir");

  const { registry } = recordingRegistry();
  const outcome = await runSupervisedCheck(
    {
      attemptId: "attempt-symlink-inside",
      command: ["sh", "-c", "ls here"],
      leasePath: dir,
      workingSubpath: "packages/web",
    },
    { registry, daemonToken: "" },
  );
  assert.equal(outcome.result.kind, "exited");
  assert.equal(outcome.result.kind === "exited" && outcome.result.exitCode, 0);
});

test("a working subpath that is not there fails closed, and says so", async () => {
  const dir = workspace();
  const { registry, records } = recordingRegistry();
  const outcome = await runSupervisedCheck(
    {
      attemptId: "attempt-missing-subpath",
      command: ["sh", "-c", "ls"],
      leasePath: dir,
      workingSubpath: "packages/web",
    },
    { registry, daemonToken: "" },
  );
  assert.equal(outcome.result.kind, "infrastructure");
  assert.match(
    outcome.result.kind === "infrastructure" ? outcome.result.reason : "",
    /could not be resolved inside the leased worktree/,
  );
  assert.deepEqual(records, []);
});

test("a nested working subpath inside the leased tree is honoured", async () => {
  const dir = workspace();
  const nested = join(dir, "packages", "web");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, "here"), "");

  const { registry } = recordingRegistry();
  const outcome = await runSupervisedCheck(
    {
      attemptId: "attempt-nested",
      command: ["sh", "-c", "ls here"],
      leasePath: dir,
      workingSubpath: "packages/web",
    },
    { registry, daemonToken: "" },
  );
  assert.equal(outcome.result.kind, "exited");
  assert.equal(outcome.result.kind === "exited" && outcome.result.exitCode, 0);
});

/**
 * A stand-in daemon: it watches a live check group and then either handles `SIGTERM` the way
 * `src/server/index.ts` does, or leaves Node's default in place.
 *
 * Spawned as a real process because the thing under test is process-level shutdown semantics,
 * which cannot be observed from inside the process asserting them.
 */
function daemonFixture(dir: string): string {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const path = join(dir, "daemon-fixture.ts");
  writeFileSync(
    path,
    [
      `import { spawn } from "node:child_process";`,
      `import { watchCheckGroup } from ${JSON.stringify(join(repo, "src/server/workflows/check-group.ts"))};`,
      `import { processStartIdentity } from ${JSON.stringify(join(repo, "src/server/workflows/check-identity.ts"))};`,
      `const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });`,
      `watchCheckGroup(victim.pid!, processStartIdentity(victim.pid!)!);`,
      // Exactly `index.ts`: SIGINT/SIGTERM -> shutdown() -> process.exit(0).
      `if (process.argv[2] === "handled") process.on("SIGTERM", () => process.exit(0));`,
      `console.log("VICTIM=" + victim.pid);`,
      `setInterval(() => {}, 1000);`,
    ].join("\n"),
  );
  return path;
}

async function runFixture(mode: "handled" | "default", dir: string): Promise<boolean> {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", daemonFixture(dir), mode], {
    cwd: repo,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let out = "";
  child.stdout!.setEncoding("utf8");
  const victim = await new Promise<number>((resolve, reject) => {
    child.stdout!.on("data", (d: string) => {
      out += d;
      const m = out.match(/VICTIM=(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.once("exit", () => reject(new Error(`fixture exited early: ${out}`)));
  });
  raw.push(victim);
  await new Promise((r) => setTimeout(r, 250));
  child.kill("SIGTERM");
  await new Promise<void>((r) => child.once("exit", () => r()));
  // The exit hook runs during the child's exit, but the group it signalled dies asynchronously.
  for (let i = 0; i < 40 && pidAlive(victim); i += 1) await new Promise((r) => setTimeout(r, 50));
  const survived = pidAlive(victim);
  try {
    process.kill(-victim, "SIGKILL");
  } catch {
    // already gone
  }
  return survived;
}

test("a daemon that handles SIGTERM the way ours does kills its live check groups", async () => {
  // `process.on("exit")` does not run when a signal terminates a process BY DEFAULT, which is a
  // real gap - but not ours: `src/server/index.ts` registers SIGINT/SIGTERM handlers that run
  // `shutdown()`, ending at `process.exit(0)`. That makes a service stop an ordinary exit, and
  // an ordinary exit reaches the hook.
  assert.equal(
    await runFixture("handled", workspace()),
    false,
    "a live check group survived a daemon shutdown shaped like ours",
  );
});

test("and Node's DEFAULT signal handling would leak them - which is why the daemon's handler matters", async () => {
  // The control, and the reason the comment on `killLiveCheckGroups` names its dependency
  // explicitly. If someone ever removes the daemon's signal handlers, or makes `shutdown()`
  // return without exiting, this is the behaviour that comes back.
  assert.equal(
    await runFixture("default", workspace()),
    true,
    "default signal handling unexpectedly reached the exit hook - re-check what this guards",
  );
});

test("nothing stays registered for the exit hook once a check is finished", async () => {
  const dir = workspace();
  const { registry } = recordingRegistry();
  await runSupervisedCheck(
    { attemptId: "attempt-unwatch", command: ["sh", "-c", "echo hi"], leasePath: dir, workingSubpath: "" },
    { registry, daemonToken: "" },
  );
  // The hard-exit killer is a last resort, and a finished check left in its list would make it
  // signal a pid that has since been handed to somebody else.
  assert.equal(liveCheckGroupCount(), 0);
});
