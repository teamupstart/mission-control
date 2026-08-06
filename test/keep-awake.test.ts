import { test } from "node:test";
import assert from "node:assert/strict";
import type { KeepAwakeStatus } from "../src/shared/types.ts";
import {
  KeepAwakeManager,
  resolveKeepAwakeBin,
  type KeepAwakeChild,
} from "../src/server/keep-awake.ts";

/**
 * What is at stake: this manager is the only thing standing between a dashboard click
 * and the host's power configuration. Every hazard is silent from the browser - a wrong
 * flag keeps the DISPLAY awake instead of only the system, a second child leaks an
 * assertion nothing owns, a status published off a request rather than an observation
 * draws an `awake` the OS is not honouring. So these tests pin the exact argv, the
 * observation boundaries (`spawn` -> on, `exit` -> off/error), the transition
 * serialization, and the bounded stop escalation - all through injected seams, because
 * CI must never touch real host power settings.
 */

/** A scriptable stand-in for the caffeinate child. */
class FakeChild implements KeepAwakeChild {
  pid = 4242;
  killed: string[] = [];
  /** How the child answers signals: exit on TERM, only on KILL, or never. */
  constructor(private readonly obeys: "sigterm" | "sigkill-only" | "never" = "sigterm") {}
  private listeners = new Map<string, ((...args: never[]) => void)[]>();
  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: "spawn" | "error" | "exit", ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killed.push(signal);
    if (this.obeys === "never") return true;
    if (signal === "SIGKILL" || this.obeys === "sigterm") {
      queueMicrotask(() => this.emit("exit", null, signal));
    }
    return true;
  }
}

/** Manually-fired timers, so the SIGKILL escalation is driven, not slept for. */
function fakeTimers() {
  const pending: { id: number; fn: () => void; ms: number }[] = [];
  let n = 0;
  return {
    pending,
    setTimeoutFn: (fn: () => void, ms: number): NodeJS.Timeout => {
      const id = ++n;
      pending.push({ id, fn, ms });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimeoutFn: (t: NodeJS.Timeout): void => {
      const at = pending.findIndex((p) => p.id === (t as unknown as number));
      if (at >= 0) pending.splice(at, 1);
    },
    fire(ms: number): void {
      const due = pending.filter((p) => p.ms === ms);
      for (const p of due) {
        pending.splice(pending.indexOf(p), 1);
        p.fn();
      }
    },
  };
}

/** Let the manager's queued transition and the fake child's microtasks run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function setup(over: {
  platform?: NodeJS.Platform;
  override?: string | null;
  script?: "spawn" | "spawn-error" | ((child: FakeChild) => void);
  obeys?: "sigterm" | "sigkill-only" | "never";
  forceKillAfterMs?: number;
} = {}) {
  const spawns: { bin: string; args: string[]; child: FakeChild }[] = [];
  const statuses: KeepAwakeStatus[] = [];
  const timers = fakeTimers();
  const manager = new KeepAwakeManager({
    platform: over.platform ?? "darwin",
    override: over.override === undefined ? null : over.override,
    daemonPid: 7317,
    now: () => 1_700_000_000_000,
    spawn: (bin, args) => {
      const child = new FakeChild(over.obeys ?? "sigterm");
      spawns.push({ bin, args, child });
      const script = over.script ?? "spawn";
      if (script === "spawn") queueMicrotask(() => child.emit("spawn"));
      else if (script === "spawn-error")
        queueMicrotask(() => child.emit("error", new Error("ENOENT: no such caffeinate")));
      else script(child);
      return child;
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    forceKillAfterMs: over.forceKillAfterMs ?? 50,
    onStatus: (s) => statuses.push(s),
  });
  return { manager, spawns, statuses, timers };
}

// ---- provider resolution ----

test("macOS resolves the absolute caffeinate path; nothing is left to PATH", () => {
  assert.equal(resolveKeepAwakeBin("darwin", null), "/usr/bin/caffeinate");
});

test("an explicit override is the provider under test on any platform", () => {
  assert.equal(resolveKeepAwakeBin("linux", "/tmp/fake-caffeinate"), "/tmp/fake-caffeinate");
  assert.equal(resolveKeepAwakeBin("darwin", "/tmp/fake-caffeinate"), "/tmp/fake-caffeinate");
});

test("a platform with no provider and no override resolves nothing", () => {
  assert.equal(resolveKeepAwakeBin("linux", null), null);
  assert.equal(resolveKeepAwakeBin("win32", null), null);
});

// ---- the exact command ----

test("enable spawns exactly `-i -w <daemon PID>`, and never -d, -u, or -s", async () => {
  const { manager, spawns } = setup();
  const status = await manager.setEnabled(true);
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.bin, "/usr/bin/caffeinate");
  // The whole argv, in order: `-i` inhibits idle SYSTEM sleep only (the display still
  // dims and locks), `-w 7317` ties the assertion to the daemon so a crash releases it.
  assert.deepEqual(spawns[0]!.args, ["-i", "-w", "7317"]);
  // The forbidden flags, by name: -d would keep the display awake, -u would impersonate
  // user activity, -s would change the requested sleep semantics.
  for (const flag of ["-d", "-u", "-s"]) {
    assert.ok(!spawns[0]!.args.includes(flag), `argv must never carry ${flag}`);
  }
  assert.equal(status.state, "on");
  assert.equal(status.since, 1_700_000_000_000);
});

// ---- lifecycle and truthfulness ----

test("every new manager starts off: the mode is transient by construction", () => {
  const { manager } = setup();
  assert.deepEqual(manager.status(), {
    supported: true,
    unavailableReason: null,
    state: "off",
    provider: "caffeinate",
    since: null,
    error: null,
  });
});

test("on is published only after the child's spawn event, never off the request", async () => {
  let release: (() => void) | null = null;
  const { manager, statuses } = setup({
    script: (child) => {
      release = () => child.emit("spawn");
    },
  });
  const pending = manager.setEnabled(true);
  await settle();
  // The child exists but has not confirmed spawning: the observed state is starting.
  assert.equal(manager.status().state, "starting");
  assert.ok(!statuses.some((s) => s.state === "on"), "on was published before the OS confirmed");
  release!();
  const status = await pending;
  assert.equal(status.state, "on");
  assert.deepEqual(statuses.map((s) => s.state), ["starting", "on"]);
});

test("an unsupported platform refuses without spawning anything", async () => {
  const { manager, spawns } = setup({ platform: "linux" });
  const status = await manager.setEnabled(true);
  assert.equal(status.supported, false);
  assert.equal(status.state, "off");
  assert.equal(status.provider, null);
  assert.match(status.unavailableReason ?? "", /unavailable/i);
  assert.equal(spawns.length, 0);
});

test("double-enable is idempotent: one child, and the second reply is the same on", async () => {
  const { manager, spawns } = setup();
  await manager.setEnabled(true);
  const again = await manager.setEnabled(true);
  assert.equal(spawns.length, 1);
  assert.equal(again.state, "on");
});

test("double-disable is idempotent and quiet", async () => {
  const { manager, statuses } = setup();
  await manager.setEnabled(false);
  await manager.setEnabled(false);
  assert.equal(manager.status().state, "off");
  // Nothing observable moved, so nothing was published for the Registry to fan out.
  assert.deepEqual(statuses, []);
});

test("concurrent opposite requests serialize: one child, and the last answer is truthful", async () => {
  const { manager, spawns } = setup();
  const enabled = manager.setEnabled(true);
  const disabled = manager.setEnabled(false);
  const [onStatus, offStatus] = await Promise.all([enabled, disabled]);
  assert.equal(onStatus.state, "on", "the first caller saw its transition complete");
  assert.equal(offStatus.state, "off", "the second caller saw the state it produced");
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0]!.child.killed, ["SIGTERM"]);
  assert.equal(manager.status().state, "off");
});

test("a spawn failure is a visible error, and a later enable may retry", async () => {
  const { manager, spawns } = setup({ script: "spawn-error" });
  const status = await manager.setEnabled(true);
  assert.equal(status.state, "error");
  assert.match(status.error ?? "", /could not start caffeinate/);
  assert.match(status.error ?? "", /ENOENT/);
  const retry = await manager.setEnabled(true);
  assert.equal(retry.state, "error", "the scripted spawn still fails");
  assert.equal(spawns.length, 2, "the retry was a fresh spawn, not a wedged queue");
});

test("error text is bounded before it can ride SSE", async () => {
  const long = "x".repeat(5_000);
  const { manager } = setup({
    script: (child) => queueMicrotask(() => child.emit("error", new Error(long))),
  });
  const status = await manager.setEnabled(true);
  assert.equal(status.state, "error");
  assert.ok((status.error ?? "").length <= 200, `error was ${status.error?.length} chars`);
});

test("an unexpected exit while on becomes error and is NOT restarted", async () => {
  const { manager, spawns, statuses } = setup();
  await manager.setEnabled(true);
  spawns[0]!.child.emit("exit", 1, null);
  await settle();
  const status = manager.status();
  assert.equal(status.state, "error");
  assert.equal(status.since, null);
  assert.match(status.error ?? "", /exited unexpectedly/);
  assert.match(status.error ?? "", /code 1/);
  assert.equal(spawns.length, 1, "the dead child was not silently respawned");
  assert.ok(statuses.some((s) => s.state === "error"), "the failure was published");
});

test("graceful disable: SIGTERM, observed exit, then off - in that order", async () => {
  const { manager, statuses } = setup();
  await manager.setEnabled(true);
  const status = await manager.setEnabled(false);
  assert.equal(status.state, "off");
  assert.equal(status.since, null);
  assert.deepEqual(
    statuses.map((s) => s.state),
    ["starting", "on", "stopping", "off"],
    "off must come only after the exit was observed, with stopping visible in between",
  );
});

test("a child that ignores SIGTERM gets the bounded SIGKILL fallback", async () => {
  const { manager, spawns, timers } = setup({ obeys: "sigkill-only", forceKillAfterMs: 50 });
  await manager.setEnabled(true);
  const pending = manager.setEnabled(false);
  await settle();
  assert.deepEqual(spawns[0]!.child.killed, ["SIGTERM"]);
  timers.fire(50); // the escalation timer
  const status = await pending;
  assert.deepEqual(spawns[0]!.child.killed, ["SIGTERM", "SIGKILL"]);
  assert.equal(status.state, "off");
});

test("a child that survives even SIGKILL is abandoned with a visible error, not a hang", async () => {
  const { manager, timers } = setup({ obeys: "never", forceKillAfterMs: 50 });
  await manager.setEnabled(true);
  const pending = manager.setEnabled(false);
  await settle();
  timers.fire(50); // SIGKILL
  await settle();
  timers.fire(100); // the give-up deadline
  const status = await pending;
  assert.equal(status.state, "error");
  assert.match(status.error ?? "", /did not exit/);
});

test("stop() is the disable path, so daemon shutdown releases the assertion", async () => {
  const { manager, spawns } = setup();
  await manager.setEnabled(true);
  await manager.stop();
  assert.deepEqual(spawns[0]!.child.killed, ["SIGTERM"]);
  assert.equal(manager.status().state, "off");
});

test("disable while a previous run failed clears the error to off", async () => {
  const { manager } = setup({ script: "spawn-error" });
  await manager.setEnabled(true);
  assert.equal(manager.status().state, "error");
  const status = await manager.setEnabled(false);
  assert.equal(status.state, "off");
  assert.equal(status.error, null);
});
