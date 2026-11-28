import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// What is at stake: with outside sessions hidden (the default), the ONLY thing that keeps a
// session Mission Control started in a terminal on the dashboard is that discovery recognizes
// the launch wrapper it runs beneath. A launch path whose process shape this predicate misses
// would have its card evicted the moment it appeared. So every launch path is built here
// through its REAL builder, and the process chain it produces is synthesized from that argv,
// rather than from a string this file spells by hand.

const home = tempDir("mission-launch-process-");
writeFileSync(join(home, "token"), "loopback-test-token\n", { mode: 0o600 });
process.env.HARNESS_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const {
  DISPOSABLE_STATE_ROOT,
  hasMissionLaunchAncestor,
  isMissionLaunchProcess,
  missionLaunchMarkers,
} = await import("../src/server/terminal/launch-process.ts");
const { cleanupDisposableAgentStateHome, isolatedAgentArgv } = await import("../src/server/agent-subprocess-env.ts");
const { resumeGuardArgv, managedResumeRoot } = await import("../src/server/harness/resume.ts");
// `managedResumeRoot` creates this home's lease partition in the shared temp dir.
const leaseRoot = managedResumeRoot();
after(() => rmSync(leaseRoot, { recursive: true, force: true }));
import type { Proc } from "../src/server/discovery/processes.ts";
import { tempDir } from "./temp-root.mjs";

function proc(p: Partial<Proc> & Pick<Proc, "pid" | "ppid" | "command">): Proc {
  return { tty: "ttys9", startRaw: "", startMs: 1000, agent: null, agentNative: false, ...p };
}
const agent = (pid: number, ppid: number): Proc =>
  proc({ pid, ppid, command: "claude --model opus", agent: "claude", agentNative: true });

/** What `ps` prints for an exec'd argv: the arguments joined by single spaces, unquoted. */
const psCommand = (argv: readonly string[]): string => argv.join(" ");

test("a dispatched or agent-button launch is recognized, including Ghostty's login-shell form", () => {
  const argv = isolatedAgentArgv(["claude", "--model", "opus"]);
  try {
    // The builder's own output, so a change to where the wrapper lives fails here.
    assert.ok(argv[1]!.startsWith(`${DISPOSABLE_STATE_ROOT}/session-`));
    for (const command of [psCommand(argv), `-${psCommand(argv)}`]) {
      const wrapper = proc({ pid: 500, ppid: 1, command });
      assert.equal(isMissionLaunchProcess(wrapper), true, command);
      // The wrapper does not exec, so it is the agent's parent.
      assert.equal(hasMissionLaunchAncestor(501, [wrapper, agent(501, 500)]), true, command);
    }
  } finally {
    cleanupDisposableAgentStateHome(dirname(argv[1]!));
  }
});

test("an agent several processes below the wrapper still counts", () => {
  const argv = isolatedAgentArgv(["npx", "claude"]);
  try {
    const procs = [
      proc({ pid: 500, ppid: 1, command: psCommand(argv) }),
      proc({ pid: 501, ppid: 500, command: "npm exec claude" }),
      agent(502, 501),
    ];
    assert.equal(hasMissionLaunchAncestor(502, procs), true);
  } finally {
    cleanupDisposableAgentStateHome(dirname(argv[1]!));
  }
});

test("a managed resume or Continue in terminal is recognized through its resume guard", () => {
  // The real lease root `prepareTerminalResume` uses, and the guard argv it execs.
  const lease = { root: managedResumeRoot(), id: randomUUID() };
  const markers = missionLaunchMarkers();
  assert.equal(markers.resumeLeaseRoot, lease.root, "discovery resolves the same lease root resume writes");
  const argv = resumeGuardArgv(process.execPath, markers.resumeGuard!, lease);
  const guard = proc({ pid: 700, ppid: 1, command: psCommand(argv) });
  assert.equal(isMissionLaunchProcess(guard, markers), true);
  // The guard spawns the agent as its own child, so it stays the ancestor.
  assert.equal(hasMissionLaunchAncestor(701, [guard, agent(701, 700)], markers), true);
});

test("a managed resume wrapper is recognized before it execs the guard, too", () => {
  // `prepareTerminalResume` writes the wrapper into the lease's own home and the terminal
  // starts it as `/bin/sh <wrapper>`; only its `exec` turns it into the guard.
  const markers = missionLaunchMarkers();
  const id = randomUUID();
  const wrapper = join(markers.resumeLeaseRoot!, "homes", id, "launch-and-cleanup.sh");
  for (const command of [`/bin/sh ${wrapper}`, `-/bin/sh ${wrapper}`]) {
    assert.equal(isMissionLaunchProcess(proc({ pid: 1, ppid: 0, command }), markers), true, command);
  }
  const foreign = join(dirname(markers.resumeLeaseRoot!), "0".repeat(64), "homes", id, "launch-and-cleanup.sh");
  assert.equal(isMissionLaunchProcess(proc({ pid: 1, ppid: 0, command: `/bin/sh ${foreign}` }), markers), false);
  assert.equal(isMissionLaunchProcess(proc({ pid: 1, ppid: 0,
    command: `/bin/sh ${join(markers.resumeLeaseRoot!, "homes", "not-a-lease", "launch-and-cleanup.sh")}` }), markers), false);
});

test("a packaged app's resume, whose runtime and guard paths contain spaces, is recognized", (t) => {
  const app = "/Applications/Agent Mission Control.app/Contents";
  const guardPath = `${app}/Resources/app/dist/satellites/resume-guard.mjs`;
  const previous = process.env.MISSION_RESUME_GUARD;
  process.env.MISSION_RESUME_GUARD = guardPath;
  t.after(() => {
    if (previous === undefined) delete process.env.MISSION_RESUME_GUARD;
    else process.env.MISSION_RESUME_GUARD = previous;
  });
  const markers = missionLaunchMarkers();
  assert.equal(markers.resumeGuard, guardPath);
  const argv = resumeGuardArgv(`${app}/MacOS/Agent Mission Control`, guardPath, { root: managedResumeRoot(), id: randomUUID() });
  const command = psCommand(argv);
  assert.equal(command.split(" ").length > argv.length, true, "precondition: ps output is ambiguous on whitespace");
  assert.equal(isMissionLaunchProcess(proc({ pid: 700, ppid: 1, command }), markers), true);
});

test("a hand-started agent in tmux is not a Mission launch", () => {
  const procs = [
    proc({ pid: 10, ppid: 1, tty: null, command: "tmux new-session -s work" }),
    proc({ pid: 11, ppid: 10, command: "-zsh" }),
    agent(12, 11),
  ];
  assert.equal(hasMissionLaunchAncestor(12, procs), false);
});

test("look-alike wrappers are not Mission launches", () => {
  const markers = missionLaunchMarkers();
  const script = "launch-and-cleanup.sh";
  for (const command of [
    // Outside the disposable root.
    `/bin/sh /tmp/elsewhere/session-abc123/${script}`,
    // The right name in somebody's project.
    `/bin/sh /Users/someone/project/${script}`,
    // Under the root but not one session home deep.
    `/bin/sh ${DISPOSABLE_STATE_ROOT}/session-abc/nested/${script}`,
    `/bin/sh ${DISPOSABLE_STATE_ROOT}/session-/${script}`,
    `/bin/sh ${DISPOSABLE_STATE_ROOT}/other-abc/${script}`,
    // Another interpreter, or extra arguments after the script.
    `/bin/bash ${DISPOSABLE_STATE_ROOT}/session-abc123/${script}`,
    `/bin/sh ${DISPOSABLE_STATE_ROOT}/session-abc123/${script} --extra`,
  ]) {
    assert.equal(isMissionLaunchProcess(proc({ pid: 1, ppid: 0, command }), markers), false, command);
  }
});

test("a resume guard under a foreign lease root, or with a malformed lease id, is not ours", () => {
  const markers = missionLaunchMarkers();
  const foreign = join(dirname(markers.resumeLeaseRoot!), "0".repeat(64));
  const guard = markers.resumeGuard!;
  for (const command of [
    // Another daemon's state directory partitions its leases under another hash.
    psCommand(resumeGuardArgv(process.execPath, guard, { root: foreign, id: randomUUID() })),
    psCommand(resumeGuardArgv(process.execPath, guard, { root: markers.resumeLeaseRoot!, id: "not-a-lease" })),
    // No runtime in front of the guard.
    `${guard} ${markers.resumeLeaseRoot} ${randomUUID()}`,
    // A different guard script.
    psCommand(resumeGuardArgv(process.execPath, "/tmp/other-guard.mjs", { root: markers.resumeLeaseRoot!, id: randomUUID() })),
  ]) {
    assert.equal(isMissionLaunchProcess(proc({ pid: 1, ppid: 0, command }), markers), false, command);
  }
});

test("a ppid cycle ends the walk instead of hanging it", () => {
  const procs = [proc({ pid: 20, ppid: 21, command: "zsh" }), proc({ pid: 21, ppid: 20, command: "zsh" }), agent(22, 20)];
  assert.equal(hasMissionLaunchAncestor(22, procs), false);
  assert.equal(hasMissionLaunchAncestor(999, procs), false, "an unknown pid has no ancestry");
});

test("a missing state directory leaves resume markers null quietly; any other failure says so once", () => {
  const failing = (code: string, message: string) => () => {
    throw Object.assign(new Error(message), { code });
  };
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);

  const fresh = missionLaunchMarkers(failing("ENOENT", "ENOENT: no such file or directory"), warn);
  assert.equal(fresh.resumeGuard, null);
  assert.equal(fresh.resumeLeaseRoot, null);
  assert.equal(fresh.disposableRoot, DISPOSABLE_STATE_ROOT, "dispatch wrappers are still recognized");
  assert.deepEqual(warnings, [], "the first-run state is expected, not a fault");

  const denied = failing("EACCES", "EACCES: permission denied, realpath '/state'");
  for (let sweep = 0; sweep < 3; sweep++) {
    const markers = missionLaunchMarkers(denied, warn);
    assert.equal(markers.resumeLeaseRoot, null, "a sweep still runs; it just cannot match a resume");
  }
  assert.equal(warnings.length, 1, "logged once, not on every sweep");
  assert.match(warnings[0]!, /permission denied/);
  assert.match(warnings[0]!, /treated as started outside Mission Control/);

  // A recovery clears the report, so the same fault returning later is said again.
  assert.equal(missionLaunchMarkers(() => "/tmp/lease-root", warn).resumeLeaseRoot, "/tmp/lease-root");
  missionLaunchMarkers(denied, warn);
  assert.equal(warnings.length, 2);
});
