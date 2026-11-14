import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import test from "node:test";
import type { Session } from "../src/shared/types.ts";
import type { Proc } from "../src/server/discovery/processes.ts";
import { agentTree, identityDigest, processFreezer, shellName, terminalRootStart } from "../src/server/pause/freezer.ts";
import type { ProcessRef } from "../src/server/pause/manager.ts";

/** What the fake identity source says each pid is: `ident-<pid>` unless overridden. */
const ident = (pid: number) => `ident-${pid}`;
const ref = (pid: number, identity = ident(pid)): ProcessRef => ({ pid, identity: identityDigest(identity) });
const refsOf = (...pids: number[]) => pids.map((pid) => ref(pid));
const pidsOf = (procs: readonly ProcessRef[]) => procs.map((p) => p.pid);

// What is at stake: the freezer sends SIGSTOP to real processes. Stopping the wrong one - the
// daemon, a reused pid, somebody else's process - is the failure that cannot be undone from the
// dashboard, and missing the parent shell leaves a resumed agent stuck in the background.

const DAEMON = 900;

function proc(pid: number, ppid: number, command: string, tty: string | null = "ttys001", startMs = 1_000): Proc {
  return { pid, ppid, tty, startRaw: "", startMs, command, agent: null, agentNative: false };
}

const TABLE: Proc[] = [
  proc(1, 0, "/sbin/launchd", null),
  proc(DAEMON, 1, "node daemon", null),
  proc(50, 1, "tmux", null),
  proc(60, 50, "-zsh", "ttys001"),
  proc(70, 60, "claude", "ttys001", 5_000),
  proc(71, 70, "npm test", "ttys001"),
  proc(72, 71, "node --test", "ttys001"),
  proc(73, 70, "rg foo", "ttys001"),
  proc(80, DAEMON, "claude --sdk", null, 9_000),
  proc(81, 80, "bash -c make", null),
];

test("shell names are recognized in login, path and argument forms", () => {
  assert.equal(shellName("-zsh"), "zsh");
  assert.equal(shellName("/bin/bash -l"), "bash");
  assert.equal(shellName("fish"), "fish");
  assert.equal(shellName("claude"), null);
  assert.equal(shellName("node /usr/local/bin/claude"), null);
});

test("a terminal id pins its root's start time", () => {
  assert.equal(terminalRootStart("proc:ttys001:70:5000"), 5000);
  assert.equal(terminalRootStart("sdk:abc"), null);
});

test("the tree is the parent shell, then the root, then its descendants in order", () => {
  assert.deepEqual(agentTree(TABLE, 70, { daemonPid: DAEMON, includeParentShell: true }), [60, 70, 71, 73, 72]);
  assert.deepEqual(agentTree(TABLE, 70, { daemonPid: DAEMON, includeParentShell: false }), [70, 71, 73, 72]);
});

test("a parent that is not a shell on the same terminal is never stopped", () => {
  const wrapped = [...TABLE, proc(90, 50, "make agent", "ttys002"), proc(91, 90, "claude", "ttys002")];
  assert.deepEqual(agentTree(wrapped, 91, { daemonPid: DAEMON, includeParentShell: true }), [91]);
  const otherTty = [...TABLE, proc(92, 60, "claude", "ttys009")];
  assert.deepEqual(agentTree(otherTty, 92, { daemonPid: DAEMON, includeParentShell: true }), [92]);
});

test("the daemon, pid 1 and an unknown root are never in a tree", () => {
  assert.deepEqual(agentTree(TABLE, DAEMON, { daemonPid: DAEMON, includeParentShell: true }), []);
  assert.deepEqual(agentTree(TABLE, 1, { daemonPid: DAEMON, includeParentShell: true }), []);
  assert.deepEqual(agentTree(TABLE, 4242, { daemonPid: DAEMON, includeParentShell: true }), []);
});

function freezerOver(table: Proc[], sdkPid: number | null = 80, identify: (pid: number) => string | null = ident, exists = (_pid: number) => true) {
  const sent: [number, string][] = [];
  const freezer = processFreezer({
    sdkDriverPid: () => sdkPid,
    snapshot: async () => ({ processes: table, unknownReason: null }),
    signal: (pid, sig) => void sent.push([pid, sig]),
    identify,
    exists,
    daemonPid: DAEMON,
    log: () => {},
  });
  return { freezer, sent };
}

const terminal = (id: string, pid: number) => ({ id, pid, runtime: "terminal" }) as Session;
const sdk = (id: string) => ({ id, pid: 0, runtime: "sdk" }) as Session;

test("a terminal session's tree is found by its pid and pinned start time", async () => {
  const { freezer } = freezerOver(TABLE);
  const tree = await freezer.treeOf(terminal("proc:ttys001:70:5000", 70));
  assert.deepEqual(pidsOf(tree), [60, 70, 71, 73, 72]);
  assert.deepEqual(tree[1], ref(70), "each process is recorded with its identity");
  assert.deepEqual(await freezer.treeOf(terminal("proc:ttys001:70:7000", 70)), [], "a reused pid is not the agent");
});

test("an SDK driver must be the daemon's own child", async () => {
  assert.deepEqual(pidsOf(await freezerOver(TABLE, 80).freezer.treeOf(sdk("sdk:a"))), [80, 81]);
  assert.deepEqual(await freezerOver(TABLE, 70).freezer.treeOf(sdk("sdk:a")), [], "a pid outside the daemon is not ours");
  assert.deepEqual(await freezerOver(TABLE, null).freezer.treeOf(sdk("sdk:pi")), [], "an in-process driver has nothing to stop");
});

test("an unreadable process table refuses rather than guessing", async () => {
  const freezer = processFreezer({
    sdkDriverPid: () => null,
    snapshot: async () => ({ processes: TABLE, unknownReason: "ps failed" }),
    log: () => {},
  });
  await assert.rejects(freezer.treeOf(terminal("proc:ttys001:70:5000", 70)), /ps failed/);
});

test("stop goes in order, resume in reverse, and the guards hold whatever is passed", () => {
  const { freezer, sent } = freezerOver(TABLE);
  freezer.stop([...refsOf(60, 70, 71), ...refsOf(0, 1, DAEMON, -5)]);
  freezer.resume(refsOf(60, 70, 71));
  assert.deepEqual(sent, [
    [60, "SIGSTOP"], [70, "SIGSTOP"], [71, "SIGSTOP"],
    [71, "SIGCONT"], [70, "SIGCONT"], [60, "SIGCONT"],
  ]);
});

test("a vanished process is not an error", () => {
  const freezer = processFreezer({
    sdkDriverPid: () => null,
    signal: () => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    identify: ident,
    exists: () => true,
    daemonPid: DAEMON,
    log: () => assert.fail("ESRCH must not be logged"),
  });
  freezer.stop(refsOf(123));
  freezer.resume(refsOf(123));
});

function processState(pid: number): string {
  return execFileSync("/bin/ps", ["-o", "state=", "-p", String(pid)], { encoding: "utf8" }).trim();
}

test("a real child process tree is stopped and continued", { skip: process.platform === "win32" }, async () => {
  // A parent that spawns a grandchild, both idling - the shape of an agent running a tool.
  const child = spawn(process.execPath, ["-e", `
    require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    setInterval(() => {}, 1000);
  `], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const freezer = processFreezer({ sdkDriverPid: () => child.pid ?? null, log: () => {} });
    const tree = await freezer.treeOf({ id: "sdk:real", pid: 0, runtime: "sdk" } as Session);
    const pids = pidsOf(tree);
    assert.equal(pids[0], child.pid);
    assert.equal(pids.length, 2, "the grandchild is part of the tree");
    assert.ok(tree.every((p) => /^[0-9a-f]{64}$/.test(p.identity)), "each with its real identity");
    freezer.stop(tree);
    for (const pid of pids) assert.match(processState(pid), /^T/, `pid ${pid} is stopped`);
    assert.deepEqual(freezer.resume(tree), [], "the real identities still match, so both continue");
    for (const pid of pids) assert.doesNotMatch(processState(pid), /^T/, `pid ${pid} runs again`);
    process.kill(pids[1]!, "SIGKILL");
  } finally {
    child.kill("SIGKILL");
  }
});

test("a process that refuses SIGSTOP is reported, and one that exited is not", () => {
  const freezer = processFreezer({
    sdkDriverPid: () => null,
    signal: (pid) => {
      if (pid === 201) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (pid === 202) throw Object.assign(new Error("not yours"), { code: "EPERM" });
    },
    identify: ident,
    exists: () => true,
    daemonPid: DAEMON,
    log: () => {},
  });
  assert.deepEqual(freezer.stop(refsOf(200, 201, 202)), [{ pid: 202, code: "EPERM" }]);
  assert.deepEqual(freezer.resume(refsOf(202, 201)), [{ pid: 202, code: "EPERM" }], "a refused SIGCONT is reported too");
  assert.deepEqual(freezer.stop(refsOf(200, 201)), []);
});

test("a resume never continues a pid that now names a different process", () => {
  // The pid was stopped as one process; it has since exited and been reused by another.
  const { freezer, sent } = freezerOver(TABLE, 80, (pid) => (pid === 300 ? "a different process" : ident(pid)));
  assert.deepEqual(freezer.resume(refsOf(300, 301)), [], "not a failure: ours is gone");
  assert.deepEqual(sent, [[301, "SIGCONT"]], "only the pid that is still the same process is continued");
});

test("a resume skips a pid with no process, and refuses one it cannot identify", () => {
  const exists = (pid: number) => pid === 401;
  const { freezer, sent } = freezerOver(TABLE, 80, (pid) => (pid === 400 || pid === 401 ? null : ident(pid)), exists);
  assert.deepEqual(freezer.resume(refsOf(400, 401, 402)), [{ pid: 401, code: "UNIDENTIFIED" }], "a live process it cannot identify stays recorded");
  assert.deepEqual(sent, [[402, "SIGCONT"]], "neither the vanished nor the unidentified pid is signalled");
});

test("a tree with a live process that cannot be identified is not frozen at all", async () => {
  const { freezer } = freezerOver(TABLE, 80, (pid) => (pid === 81 ? null : ident(pid)));
  await assert.rejects(freezer.treeOf(sdk("sdk:a")), /pid 81 could not be identified/);
});
