import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredPauseState } from "../src/shared/protocol.ts";

// What is at stake: the pause has to be visible to every automated writer the instant the
// operator asks for it - on the REAL registry, through the shared delivery gate the outbox,
// workflow packets and Foreman's writes all ask - not only once the process table has been read.
// And what a restart restores must reach a session that registers after it.

const home = mkdtempSync(join(tmpdir(), "mission-pause-registry-"));
process.env.HARNESS_HOME = home;
const { Registry } = await import("../src/server/registry.ts");
const { PauseManager } = await import("../src/server/pause/manager.ts");
const { PAUSED_SESSION_REASON } = await import("../src/shared/pause.ts");
after(() => rmSync(home, { recursive: true, force: true }));

function sdkSession(registry: InstanceType<typeof Registry>, id: string): void {
  registry.registerSdkSession({ id, agent: "claude", name: id, cwd: `/repo/${id}`, agentSessionId: `conv:${id}` });
  registry.applyDriverEvent(id, { kind: "state", state: "working", activity: "Running npm test" });
}

test("the registry and the delivery gate hold a session before its process tree has been read", async () => {
  const registry = new Registry();
  sdkSession(registry, "sdk:held");
  assert.equal(registry.promptResourceBlockerForSession("sdk:held"), null, "open before the pause");

  let release!: (procs: { pid: number; identity: string }[]) => void;
  const treeRead = new Promise<{ pid: number; identity: string }[]>((resolve) => { release = resolve; });
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: () => treeRead, stop: () => [], resume: () => [] },
    store: { load: () => undefined, save: () => {} },
    log: () => {},
  });
  manager.start();
  const pausing = manager.pause("sdk:held", "now");
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The tree read has not resolved, and the hold is already everywhere a writer looks.
  assert.equal(registry.getSession("sdk:held")?.pause?.phase, "pending");
  assert.equal(registry.snapshot().sessions.find((s) => s.id === "sdk:held")?.pause?.phase, "pending");
  assert.equal(registry.promptResourceBlockerForSession("sdk:held"), PAUSED_SESSION_REASON);

  release([{ pid: 4242, identity: "0".repeat(64) }]);
  assert.deepEqual(await pausing, { ok: true });
  assert.equal(registry.getSession("sdk:held")?.pause?.phase, "frozen");
  await manager.resume("sdk:held");
  assert.equal(registry.getSession("sdk:held")?.pause ?? null, null);
  assert.equal(registry.promptResourceBlockerForSession("sdk:held"), null);
  assert.equal(typeof registry.sessionResumedAt("sdk:held"), "number", "the resume time is on the registry");
});

test("a restart's pause and resume time reach a session that registers after the manager starts", () => {
  const now = Date.now();
  const stored: StoredPauseState = {
    fleet: null,
    priority: null,
    sessions: { "sdk:restored": { reason: "fleet", phase: "frozen", since: now - 60_000, interrupted: null, runtime: "sdk", procs: [], resuming: false } },
    resumed: { "sdk:resumed": now - 10_000 },
  };
  const registry = new Registry();
  const manager = new PauseManager({
    registry,
    freezer: { treeOf: async () => [], stop: () => [], resume: () => [] },
    store: { load: () => stored, save: () => {} },
    log: () => {},
  });
  manager.start();
  // The SDK restore registers its sessions after the manager has started.
  sdkSession(registry, "sdk:restored");
  assert.equal(registry.getSession("sdk:restored")?.pause?.reason, "fleet", "held from the moment it is restored");
  assert.equal(registry.promptResourceBlockerForSession("sdk:restored"), PAUSED_SESSION_REASON);
  assert.equal(registry.sessionResumedAt("sdk:resumed"), now - 10_000, "the resume clock survives the restart");
});

function idleSession(registry: InstanceType<typeof Registry>, id: string): void {
  registry.registerSdkSession({ id, agent: "claude", name: id, cwd: `/repo/${id}`, agentSessionId: `conv:${id}` });
  registry.applyDriverEvent(id, { kind: "state", state: "idle", activity: null });
}

async function drain(manager: InstanceType<typeof PauseManager>): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await manager.idle();
  }
}

for (const failure of ["unreadable process table", "SIGSTOP refused"] as const) {
  test(`a freeze that keeps failing (${failure}) is retried on a timer, never on its own publish`, async () => {
    // The real registry emits `session_upsert` for the manager's own publish of the failed
    // attempt; the manager must not answer that with another attempt.
    const registry = new Registry();
    idleSession(registry, "sdk:stubborn");
    let reads = 0;
    let stops = 0;
    const timers: { fn: () => void; ms: number }[] = [];
    const manager = new PauseManager({
      registry,
      freezer: {
        treeOf: async () => {
          reads++;
          if (failure === "unreadable process table") throw new Error("ps timed out");
          return [{ pid: 5150, identity: "0".repeat(64) }];
        },
        stop: (procs) => {
          stops++;
          return procs.map((p) => ({ pid: p.pid, code: "EPERM" }));
        },
        resume: () => [],
      },
      store: { load: () => undefined, save: () => {} },
      setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
      clearTimer: (handle) => { const at = timers.indexOf(handle as (typeof timers)[number]); if (at >= 0) timers.splice(at, 1); },
      log: () => {},
    });
    manager.start();
    // The real registry has not swept yet; reconciliation is what marks it observed.
    registry.applyDiscovery([]);
    await drain(manager);
    const result = await manager.pause("sdk:stubborn", "now");
    assert.equal(result.ok, false);
    await drain(manager);
    assert.equal(reads, 1, "one read of the process table, not one per publish");
    if (failure === "SIGSTOP refused") assert.equal(stops, 1);
    assert.equal(registry.getSession("sdk:stubborn")?.pause?.phase, "pending", "held, never called frozen");
    assert.deepEqual(timers.map((t) => t.ms), [15_000]);

    timers[0]!.fn();
    await drain(manager);
    assert.equal(reads, 2, "the retry timer is what tries again");
    assert.deepEqual(timers.map((t) => t.ms), [30_000], "with a longer wait each time");
  });
}

test("a pane whose agent is stopped refuses a write even while its pause reads pending", async () => {
  // A freeze a restart interrupted leaves stopped processes under a pending record. Keystrokes
  // into that pane would sit in the pty, so the pane gate asks whether processes are stopped.
  const { selectPaneOption } = await import("../src/server/actions.ts");
  const base = { id: "proc:t1:70:1", runtime: "terminal", pid: 70, state: "working" } as const;
  const untouched = {
    pane: () => {
      throw new Error("the pane was reached");
    },
  } as unknown as Parameters<typeof selectPaneOption>[2];
  const stopped = { ...base, pause: { reason: "operator", phase: "pending", since: 1, interrupted: null, stopped: true } };
  const refused = await selectPaneOption(stopped as never, { number: 1, label: "Yes" }, untouched);
  assert.deepEqual(refused, { ok: false, error: PAUSED_SESSION_REASON });

  // An after-turn pause with nothing stopped is not refused here: answering a menu is how its turn ends.
  const waiting = { ...base, pause: { reason: "operator", phase: "pending", since: 1, interrupted: null, stopped: false } };
  await assert.rejects(selectPaneOption(waiting as never, { number: 1, label: "Yes" }, untouched), /the pane was reached/);
});
