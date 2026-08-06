import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeepAwakeStatus, ServerEvent } from "../src/shared/types.ts";

// What is at stake: the Registry is the ONE convergence path for keep-awake state - the
// snapshot answers a fresh or reconnecting dashboard, `keep_awake_status` answers the
// open ones, and both must carry the same observation. Two hazards are pinned here.
//
// Too quiet: a transition the Registry swallows leaves a second window drawing `off`
// while the OS holds an assertion the first window created.
//
// Too loud: the manager publishes on every ATTEMPT, including the idempotent re-request
// a second dashboard's click produces, so without change suppression every no-op would
// wake every browser with a status none of them can see move.
//
// And the transience contract, at this layer: nothing here touches SQLite, so a new
// Registry over the same database always opens at the seeded off - which is exactly the
// restart-reset the feature promises.

const home = mkdtempSync(join(tmpdir(), "mission-keep-awake-sse-"));
process.env.HARNESS_HOME = join(home, "state");

const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const isKeepAwake = (e: ServerEvent): e is Extract<ServerEvent, { type: "keep_awake_status" }> =>
  e.type === "keep_awake_status";

function mkStatus(over: Partial<KeepAwakeStatus> = {}): KeepAwakeStatus {
  return {
    supported: true,
    unavailableReason: null,
    state: "off",
    provider: "caffeinate",
    since: null,
    error: null,
    ...over,
  };
}

function setup() {
  const registry = new Registry();
  const events: ServerEvent[] = [];
  registry.subscribe((e) => events.push(e));
  return { registry, frames: () => events.filter(isKeepAwake) };
}

test("an unseeded registry snapshots a truthful placeholder: unsupported and off", () => {
  const { registry } = setup();
  const keepAwake = registry.snapshot().keepAwake;
  assert.equal(keepAwake.state, "off");
  assert.equal(keepAwake.supported, false);
  assert.equal(keepAwake.provider, null);
  assert.match(keepAwake.unavailableReason ?? "", /did not initialize/);
});

test("a seeded status rides the snapshot, so a reconnect converges without a fetch", () => {
  const { registry } = setup();
  registry.setKeepAwakeStatus(mkStatus({ state: "on", since: 123 }));
  const keepAwake = registry.snapshot().keepAwake;
  assert.equal(keepAwake.state, "on");
  assert.equal(keepAwake.since, 123);
});

test("a changed observation emits one keep_awake_status frame carrying the whole status", () => {
  const { registry, frames } = setup();
  registry.setKeepAwakeStatus(mkStatus());
  const seeded = frames().length; // the seed itself changed supported, so it may emit
  registry.setKeepAwakeStatus(mkStatus({ state: "starting" }));
  assert.equal(frames().length, seeded + 1);
  assert.equal(frames().at(-1)!.status.state, "starting");
});

test("restating the same observation wakes no browser", () => {
  const { registry, frames } = setup();
  registry.setKeepAwakeStatus(mkStatus({ state: "on", since: 5 }));
  const before = frames().length;
  registry.setKeepAwakeStatus(mkStatus({ state: "on", since: 5 }));
  registry.setKeepAwakeStatus(mkStatus({ state: "on", since: 5 }));
  assert.equal(frames().length, before, "an idempotent re-request must not fan out");
});

test("every observable field is part of the change gate", () => {
  const { registry, frames } = setup();
  registry.setKeepAwakeStatus(mkStatus());
  const moves: Partial<KeepAwakeStatus>[] = [
    { state: "starting" },
    { state: "on", since: 9 },
    { state: "on", since: 9, error: "the caffeinate process exited unexpectedly" },
    { supported: false, unavailableReason: "gone" },
  ];
  let seen = frames().length;
  let current = mkStatus();
  for (const move of moves) {
    current = { ...current, ...move };
    registry.setKeepAwakeStatus(current);
    assert.equal(frames().length, seen + 1, `${JSON.stringify(move)} must emit`);
    seen++;
  }
});

test("nothing persists: a new Registry over the same database starts off again", () => {
  const first = new Registry();
  first.setKeepAwakeStatus(mkStatus({ state: "on", since: 42 }));
  // The restart: a fresh Registry hydrates everything durable from SQLite. Keep awake
  // must not be among it - the next daemon's snapshot reports the placeholder until the
  // next manager (which always starts off) seeds it.
  const second = new Registry();
  const keepAwake = second.snapshot().keepAwake;
  assert.equal(keepAwake.state, "off");
  assert.equal(keepAwake.supported, false);
});
