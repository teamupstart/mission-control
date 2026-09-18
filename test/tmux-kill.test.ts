import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { kill } from "../src/server/actions.ts";
import { tmuxMultiplexer } from "../src/server/terminal/tmux.ts";
import { binEnv, resolveBin, TMUX_BIN } from "../src/server/terminal/bin.ts";
import { mkSession, mkMuxHandle } from "./helpers/session-fixture.ts";
import { terminalResourceId } from "../src/shared/pane.ts";
import { defaultHomeDeps, homeAlive, killHome, launchHome } from "../src/server/terminal/home.ts";
import { defaultTerminalDeps } from "../src/server/terminal/registry.ts";
import { teardownWorktree } from "../src/server/dispatcher.ts";

assert.ok(process.env.NODE_TEST_CONTEXT && process.env.MISSION_TEST_STATE, "Use the repository test preload");
const tmuxBin = resolveBin(TMUX_BIN);
const sleepBin = ["/bin/sleep", "/usr/bin/sleep"].find(p => spawnSync(p, ["0"]).status === 0)!;
assert.ok(sleepBin);
const originalTmux = process.env.TMUX;
const unavailable = spawnSync(tmuxBin, ["-V"], {stdio: "ignore"}).status !== 0;

class Fixture {
  dir = mkdtempSync(join(tmpdir(), "mc-tmux-kill-"));
  socket = join(this.dir, "server.sock");
  fakeAgent = join(this.dir, "claude");
  constructor() { symlinkSync(sleepBin, this.fakeAgent); }
  raw(args: string[]) {
    const env = { ...process.env }; delete env.TMUX; delete env.TMUX_PANE;
    return spawnSync(tmuxBin, ["-S", this.socket, "-f", "/dev/null", ...args], {
      encoding: "utf8", env, timeout: 5000,
    });
  }
  cmd(...args: string[]) {
    const r = this.raw(args);
    assert.equal(r.status, 0, JSON.stringify({ args, stderr: r.stderr, error: r.error?.message }));
    return r.stdout.trim();
  }
  start(name: string) {
    return this.cmd("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name,
      "-c", this.dir, "--", this.fakeAgent, "600");
  }
  split(pane: string) {
    return this.cmd("split-window", "-d", "-P", "-F", "#{pane_id}", "-t", pane,
      "--", this.fakeAgent, "600");
  }
  pid(pane: string) { return Number(this.cmd("display-message", "-p", "-t", pane, "#{pane_pid}")); }
  serverPid() { return Number(this.cmd("display-message", "-p", "#{pid}")); }
  pin() {
    process.env.TMUX = `${this.socket},${this.serverPid()},0`;
    assert.equal(binEnv(TMUX_BIN).TMUX, process.env.TMUX);
  }
  names() {
    const r = this.raw(["list-sessions", "-F", "#{session_name}"]);
    return r.status === 0 ? r.stdout.trim().split("\n").sort() : [];
  }
  has(name: string) { return this.raw(["has-session", "-t", `=${name}`]).status === 0; }
  paneExists(pane: string) { return this.raw(["display-message", "-p", "-t", pane, "#{pane_id}"]).stdout.trim() === pane; }
  async session(name: string, pane: string) {
    const observed = (await tmuxMultiplexer().list()).find(p => p.paneId === pane && p.sessionName === name);
    assert.ok(observed);
    return mkSession({ pid: this.pid(pane), task: null, name,
      terminals: [mkMuxHandle(observed)] });
  }
  cleanup() {
    // kill-server occurs ONLY in fixture cleanup, after measurements, on this owned socket.
    this.raw(["kill-server"]);
    rmSync(this.dir, { recursive: true, force: true });
    if (originalTmux === undefined) delete process.env.TMUX; else process.env.TMUX = originalTmux;
  }
}

async function until(predicate: () => boolean, label: string) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}

// These tests use real target resolution and real SIGTERM on harmless sleep processes.
// Every server, including cleanup, is addressed by the fixture's private socket.
for (const layout of ["split", "window"] as const) {
  test(`Kill preserves a sibling in another ${layout}`, { skip: unavailable }, async () => {
    const f = new Fixture();
    try {
      const target = f.start("shared");
      const sibling = layout === "split" ? f.split(target) : f.cmd("new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "shared", "--", f.fakeAgent, "600");
      f.pin();
      const result = await kill(await f.session("shared", target));
      assert.equal(result.ok, true);
      assert.equal(f.has("shared"), true);
      assert.equal(f.paneExists(sibling), true);
    } finally { f.cleanup(); }
  });
}

test("Kill still closes a sole-pane session when the agent has a persistent shell", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.cmd("new-session", "-d", "-P", "-F", "#{pane_id}", "-s", "solo", "--", "/bin/sh", "-c", "\"$1\" 600 & echo $! > \"$2\"; wait; exec \"$1\" 600", "scout", sleepBin, join(f.dir, "agent.pid"));
    f.start("unrelated"); f.pin();
    const session = await f.session("solo", pane);
    const { readFileSync, existsSync } = await import("node:fs");
    await until(() => existsSync(join(f.dir, "agent.pid")), "agent ready");
    session.pid = Number(readFileSync(join(f.dir, "agent.pid"), "utf8").trim());
    assert.equal((await kill(session)).ok, true);
    assert.deepEqual(f.names(), ["unrelated"]);
  } finally { f.cleanup(); }
});

test("exiting sole agent cannot retarget the unique session-name prefix", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.start("work"); f.start("work-other"); f.pin();
    assert.equal((await kill(await f.session("work", pane))).ok, true);
    assert.deepEqual(f.names(), ["work-other"]);
  } finally { f.cleanup(); }
});

test("a renamed target and replacement name retain distinct teardown identities", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.start("work"); f.start("unrelated"); f.pin();
    const session = await f.session("work", pane);
    f.cmd("rename-session", "-t", "=work", "renamed");
    f.start("work");
    assert.equal((await kill(session)).ok, true);
    assert.deepEqual(f.names(), ["unrelated", "work"]);
  } finally { f.cleanup(); }
});

test("a vanished agent does not authorize teardown of a replacement with the same name", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.start("work"); f.start("unrelated"); f.pin();
    const session = await f.session("work", pane);
    process.kill(session.pid, "SIGTERM");
    await until(() => !f.has("work"), "old target exits");
    f.start("work");
    await kill(session);
    assert.deepEqual(f.names(), ["unrelated", "work"]);
  } finally { f.cleanup(); }
});

test("a restarted server reusing pane and session ids cannot inherit a stale Kill", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.start("work"); f.pin();
    const session = await f.session("work", pane);
    f.cmd("kill-server");
    await delay(30);
    f.start("work");
    await kill(session);
    assert.equal(f.has("work"), true);
  } finally { f.cleanup(); }
});

test("a pane added after discovery but before teardown is preserved", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.start("work"); f.pin();
    const session = await f.session("work", pane);
    let sibling = "";
    const result = await kill(session, {
      terminals: defaultTerminalDeps,
      signal: () => {
        // Deterministically interleave the user's split after discovery. Leave the
        // agent alive so a false success cannot hide a missing topology check.
        sibling = f.split(pane);
        return { ok: false, error: "signal refused" };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(f.paneExists(pane), true);
    assert.equal(f.paneExists(sibling), true);
  } finally { f.cleanup(); }
});

test("a captured socket wins over another server with identical native ids", { skip: unavailable }, async () => {
  const first = new Fixture(); const second = new Fixture();
  try {
    const pane = first.start("work"); first.pin();
    const session = await first.session("work", pane);
    second.start("work"); second.pin();
    const resource = terminalResourceId(session.terminals[0]!);
    assert.equal(await homeAlive("work", undefined, "tmux", resource), true);
    await kill(session);
    assert.equal(first.has("work"), false);
    assert.equal(second.has("work"), true);
    assert.equal(await homeAlive("work", undefined, "tmux", resource), false);
  } finally { second.cleanup(); first.cleanup(); }
});

test("captured home is absent when tmux keeps an empty server alive", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.start("work"); f.pin();
    const session = await f.session("work", pane);
    const resource = terminalResourceId(session.terminals[0]!);
    f.cmd("set-option", "-g", "exit-empty", "off");
    f.cmd("kill-session", "-t", "=work");
    assert.equal(await homeAlive("work", undefined, "tmux", resource), false);
  } finally { f.cleanup(); }
});

test("task launch captures an identity before discovery and cleanup follows it across rename", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    f.start("anchor"); f.pin();
    // Explicit deps opt into a real backend, pinned to the fixture socket above.
    const launched = await launchHome({ name: "task", cwd: f.dir, argv: [f.fakeAgent, "600"], sidePane: true }, { ...defaultHomeDeps }, "tmux");
    assert.equal(launched.ok, true);
    if (!launched.ok) return;
    assert.ok(launched.resourceId);
    f.cmd("rename-session", "-t", "=task", "renamed");
    f.start("task");
    assert.equal(await homeAlive("task", undefined, "tmux", launched.resourceId), true);
    assert.equal((await killHome("task", undefined, "tmux", launched.resourceId)).ok, true);
    assert.deepEqual(f.names(), ["anchor", "task"]);
    assert.equal(await homeAlive("task", undefined, "tmux", launched.resourceId), false);
    assert.equal((await killHome("task", undefined, "tmux", launched.resourceId)).ok, true, "repeat cleanup is idempotent");
    assert.deepEqual(f.names(), ["anchor", "task"]);
  } finally { f.cleanup(); }
});

test("legacy cleanup cannot upgrade a name into authority over a replacement", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.start("work"); f.pin();
    const observed = await f.session("work", pane);
    const resource = terminalResourceId(observed.terminals[0]!);
    assert.ok(resource);
    const refused = await killHome("work", undefined, "tmux");
    assert.equal(refused.ok, false);
    assert.equal(f.has("work"), true);
    // Old persisted resources contained names too. They must be refused at the adapter.
    assert.equal((await killHome("work", undefined, "tmux", "multiplexer:tmux:work")).ok, false);
    assert.equal(f.has("work"), true);
    await assert.rejects(teardownWorktree({
      repoRoot: f.dir, worktreePath: null, branch: null, provider: null,
      homeName: "work", homeBackend: "tmux", terminalResourceId: "multiplexer:tmux:work",
    }), /identity.*unknown.*worktree preserved/);
    assert.equal(f.has("work"), true);
  } finally { f.cleanup(); }
});

test("closing the last recorded session succeeds and lets the empty server exit", { skip: unavailable }, async () => {
  const f = new Fixture();
  try {
    const pane = f.start("last"); f.pin();
    const session = await f.session("last", pane);
    const resource = terminalResourceId(session.terminals[0]!);
    assert.equal((await killHome("last", undefined, "tmux", resource)).ok, true);
    assert.deepEqual(f.names(), []);
  } finally { f.cleanup(); }
});
