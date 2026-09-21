// A launch target belongs to one exact process lifetime, including across daemon restart.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { belongsToLaunch, readLaunchProcess, LAUNCH_SCRIPT_FILE, LAUNCH_PID_FILE } from "../src/server/terminal/launch-process.ts";
import type { Proc } from "../src/server/discovery/processes.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkTask, mkEmuHandle } from "./helpers/session-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "mission-launch-identity-"));
process.env.MISSION_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const db = await import("../src/server/db.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const proc = (pid: number, ppid: number, startMs = 1000): Proc => ({
  pid, ppid, startMs, startRaw: "", tty: "ttys1", command: "fixture",
  agent: null, agentNative: false,
});

test("the recorded wrapper is recognized with ordinary and login-shell argv0", async () => {
  for (const argv0 of ["/bin/sh", "-/bin/sh"]) {
    const stateHome = mkdtempSync(join(home, "wrapper-"));
    const wrapper = join(stateHome, LAUNCH_SCRIPT_FILE);
    writeFileSync(wrapper, `printf '%s\\n' "$$" > '${join(stateHome, LAUNCH_PID_FILE)}'\nread answer\n`);
    const child = spawn("/bin/sh", [wrapper], { argv0, stdio: ["pipe", "ignore", "inherit"] });
    const exited = once(child, "exit");
    try {
      const found = await readLaunchProcess(stateHome);
      assert.equal(found?.pid, child.pid, argv0);
      assert.ok(found?.startMs);
    } finally {
      child.stdin!.end("done\n");
      await exited;
    }
  }
});

test("launch ownership requires the exact live ancestry and both process start times", () => {
  const processes = [proc(10, 1), proc(20, 10), proc(30, 20)];
  const session = { pid: 30, startedAt: 1000 };
  assert.equal(belongsToLaunch(session, { pid: 10, startMs: 1000 }, processes), true);
  assert.equal(belongsToLaunch(session, { pid: 10, startMs: 999 }, processes), false);
  assert.equal(belongsToLaunch({ ...session, startedAt: 999 }, { pid: 10, startMs: 1000 }, processes), false);
  assert.equal(belongsToLaunch(session, { pid: 10, startMs: 1000 }, [proc(10, 1), proc(30, 1)]), false);
  assert.equal(belongsToLaunch(session, { pid: 10, startMs: 1000 }, [proc(20, 30), proc(30, 20)]), false);
});

function discovered(id = "proc:ttys1:30:1000"): DiscoveredSession {
  return {
    syntheticId: id, agent: "claude", name: "claude 30", nameSource: "process",
    cwd: "/fixture", gitRoot: null, repoRoot: null, gitBranch: null,
    pid: 30, tty: "ttys1", startedAt: 1000, terminals: [],
  };
}

test("a bound launch UUID survives inventory loss and a fresh Registry without borrowing cwd", () => {
  const d = discovered();
  const task = mkTask({ id: "launch-owned", status: "running", sessionId: d.syntheticId,
    worktreePath: d.cwd, homeBackend: "ghostty", homeName: "My task",
    terminalResourceId: "emulator:ghostty:owned-uuid",
    terminalLaunch: { resourceId: "emulator:ghostty:owned-uuid", sessionId: d.syntheticId } });
  for (const registry of [new Registry(), new Registry()]) {
    registry.upsertTask(task);
    registry.applyDiscovery([d]);
    const live = registry.getSession(d.syntheticId)!;
    assert.equal(live.terminals[0]?.paneId, "owned-uuid");
    assert.equal(live.name, "My task");
    registry.applyDiscovery([d, { ...discovered("proc:ttys1:30:2000"), startedAt: 2000 }]);
    assert.deepEqual(registry.getSession("proc:ttys1:30:2000")?.terminals, []);
  }
});

test("binding a verified launch publishes its handle before the next discovery tick", () => {
  const registry = new Registry();
  const d = discovered();
  registry.applyDiscovery([d]);
  const frames: string[] = [];
  registry.subscribe((event) => {
    if (event.type === "session_upsert") frames.push(event.session.terminals[0]?.paneId ?? "none");
  });
  registry.upsertTask(mkTask({ id: "new-launch", status: "dispatching", sessionId: d.syntheticId,
    worktreePath: d.cwd, homeBackend: "ghostty", homeName: "New task",
    terminalResourceId: "emulator:ghostty:new-uuid",
    terminalLaunch: { resourceId: "emulator:ghostty:new-uuid", sessionId: d.syntheticId } }));
  assert.equal(registry.getSession(d.syntheticId)?.terminals[0]?.paneId, "new-uuid");
  assert.equal(frames.at(-1), "new-uuid");
});

test("legacy and recyclable emulator identities are never reconstructed without observation", () => {
  for (const terminalResourceId of [null, "emulator:ghostty:legacy-cwd-guess", "emulator:wezterm:7"]) {
    const registry = new Registry();
    const d = discovered();
    registry.upsertTask(mkTask({ id: "legacy-" + terminalResourceId, sessionId: d.syntheticId,
      homeName: "same title", homeBackend: terminalResourceId?.includes("wezterm") ? "wezterm" : "ghostty", terminalResourceId }));
    registry.applyDiscovery([d]);
    assert.deepEqual(registry.getSession(d.syntheticId)?.terminals, []);
  }
});

test("persisted launch proof roundtrips and malformed or mismatched proof cannot restore a target", () => {
  const d = discovered("proc:ttys2:30:1000");
  const task = mkTask({ id: "persisted-launch", sessionId: d.syntheticId,
    homeBackend: "ghostty", terminalResourceId: "emulator:ghostty:owned",
    terminalLaunch: { resourceId: "emulator:ghostty:owned", sessionId: d.syntheticId } });
  db.upsertTask(task);
  assert.deepEqual(db.getTask(task.id)?.terminalLaunch, task.terminalLaunch);
  for (const proof of ['broken', '{"sessionId":1}', JSON.stringify({ ...task.terminalLaunch, resourceId: "emulator:ghostty:other" })]) {
    db.openDb().prepare("UPDATE tasks SET terminal_launch = ? WHERE id = ?").run(proof, task.id);
    const registry = new Registry();
    registry.applyDiscovery([d]);
    assert.deepEqual(registry.getSession(d.syntheticId)?.terminals, []);
  }
});

test("launch adoption owns durable proof, episode binding and the first-bound notification", async () => {
  const registry = new Registry();
  const d = { ...discovered("proc:adopt:30:1000"),
    terminals: [mkEmuHandle({ backend: "ghostty", paneId: "adopt-owned" })] };
  registry.applyDiscovery([d]);
  const launched = { homeName: "Adopted task", homeBackend: "ghostty" as const,
    terminalResourceId: "emulator:ghostty:adopt-owned" };
  const task = mkTask({ id: "adopt-owned", status: "dispatching", worktreePath: d.cwd, ...launched });
  registry.upsertTask(task);
  registry.bindLaunchedAgentSession(d.syntheticId, "claude", "adopt-agent-conversation");
  const observed = registry.getSession(d.syntheticId)!;
  const adopted = await registry.adoptTerminalLaunch(task.id, launched, observed);
  assert.equal(adopted?.newlyBound, true);
  assert.equal(adopted?.session.name, launched.homeName, "return the refreshed task/session projection");
  const saved = db.getTask(task.id)!;
  assert.equal(saved.sessionId, observed.id);
  assert.deepEqual(saved.terminalLaunch, { resourceId: launched.terminalResourceId, sessionId: observed.id });
  assert.equal(db.taskWorkEpisodeForTask(task.id)?.sessionId, observed.id);
  assert.equal((await registry.adoptTerminalLaunch(task.id, launched, observed))?.newlyBound, false);

  const restarted = new Registry();
  restarted.applyDiscovery([{ ...d, terminals: [] }]);
  assert.equal(restarted.getSession(observed.id)?.terminals[0]?.paneId, "adopt-owned",
    "the adoption operation, not a caller-built proof, survives missing inventory on restart");
});

test("launch adoption refuses an unverified recipient without changing task or episode", async () => {
  const registry = new Registry();
  const d = discovered("proc:unverified-adoption:30:1000");
  registry.applyDiscovery([d]);
  const launched = { homeName: "Unverified", homeBackend: "ghostty" as const,
    terminalResourceId: "emulator:ghostty:unrelated" };
  const task = mkTask({ id: "adopt-unverified", status: "running", ...launched });
  registry.upsertTask(task);
  const before = db.getTask(task.id);
  assert.equal(await registry.adoptTerminalLaunch(task.id, launched, registry.getSession(d.syntheticId)!), null);
  assert.deepEqual(db.getTask(task.id), before);
  assert.equal(db.taskWorkEpisodeForTask(task.id), null);
});

test("launch adoption rechecks task ownership after verification before persisting proof", async () => {
  for (const change of [
    { status: "cancelled" as const },
    { sessionId: "proc:another-owner:30:1000" },
    { terminalResourceId: "emulator:ghostty:replacement" },
  ]) {
    const registry = new Registry();
    const d = { ...discovered(`proc:adoption-race:${Object.keys(change)[0]}`),
      terminals: [mkEmuHandle({ backend: "ghostty", paneId: "race-owned" })] };
    registry.applyDiscovery([d]);
    const launched = { homeName: "Race", homeBackend: "ghostty" as const,
      terminalResourceId: "emulator:ghostty:race-owned" };
    const task = mkTask({ id: `adopt-race-${Object.keys(change)[0]}`, status: "running", ...launched });
    registry.upsertTask(task);
    const adopting = registry.adoptTerminalLaunch(task.id, launched, registry.getSession(d.syntheticId)!);
    registry.upsertTask({ ...task, ...change });
    const latest = db.getTask(task.id);
    assert.equal(await adopting, null);
    assert.deepEqual(db.getTask(task.id), latest, "never overwrite a change made while verification was pending");
    assert.equal(db.taskWorkEpisodeForTask(task.id), null);
  }
});
