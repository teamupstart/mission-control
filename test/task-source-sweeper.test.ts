import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskSourceInstance } from "../src/shared/task-source.ts";
import type { TaskManager } from "../src/server/tasks.ts";

const home = mkdtempSync(join(tmpdir(), "mission-task-source-sweeper-"));
const bin = join(home, "bin");
mkdirSync(bin);
writeFileSync(
  join(bin, "gh"),
  "#!/bin/sh\n" +
    "if [ -n \"$TASK_SOURCE_SWEEP_GATE\" ]; then\n" +
    "  touch \"$TASK_SOURCE_SWEEP_GATE/started\"\n" +
    "  while [ ! -f \"$TASK_SOURCE_SWEEP_GATE/release\" ]; do sleep 0.01; done\n" +
    "fi\n" +
    "printf '[]'\n",
);
chmodSync(join(bin, "gh"), 0o755);
process.env.HARNESS_HOME = join(home, "state");
process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

const { openDb } = await import("../src/server/db.ts");
const { sweepOnce, taskSourceStatuses } = await import(
  "../src/server/task-sources/sweeper.ts"
);

openDb();
after(() => rmSync(home, { recursive: true, force: true }));

const tasks = {} as TaskManager;

function source(id: string, enabled: boolean): TaskSourceInstance {
  return {
    id,
    kind: "github-issues",
    label: "issues",
    enabled,
    repoRoot: home,
    intervalMs: 900_000,
    defaults: { kind: "ship", agent: "claude", priority: null, labels: [] },
    maxPerSweep: 25,
    config: {},
  };
}

async function waitFor(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!existsSync(path) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(path), `timed out waiting for ${path}`);
}

test("disabling clears health before a source is re-enabled", async () => {
  const enabled = source("disable-transition", true);
  await sweepOnce(enabled, tasks);
  assert.notEqual(taskSourceStatuses([enabled])[0]?.lastSweepAt, null);

  const disabled = { ...enabled, enabled: false };
  assert.equal(taskSourceStatuses([disabled])[0]?.lastSweepAt, null);
  assert.equal(taskSourceStatuses([enabled])[0]?.lastSweepAt, null);
});

test("a manual sweep while disabled remains current after re-enable", async () => {
  const enabled = source("paused-manual-sweep", true);
  await sweepOnce(enabled, tasks);

  const disabled = { ...enabled, enabled: false };
  taskSourceStatuses([disabled]);
  await sweepOnce(disabled, tasks);
  const sweptWhileDisabled = taskSourceStatuses([disabled])[0]?.lastSweepAt;
  assert.notEqual(sweptWhileDisabled, null);

  assert.equal(taskSourceStatuses([enabled])[0]?.lastSweepAt, sweptWhileDisabled);
});

test("a sweep started before disable cannot restore stale health", async () => {
  const gate = join(home, "in-flight-gate");
  mkdirSync(gate);
  process.env.TASK_SOURCE_SWEEP_GATE = gate;

  const enabled = source("in-flight-disable", true);
  const sweep = sweepOnce(enabled, tasks);
  try {
    await waitFor(join(gate, "started"));
    const disabled = { ...enabled, enabled: false };
    assert.equal(taskSourceStatuses([disabled])[0]?.lastSweepAt, null);
    assert.equal(taskSourceStatuses([enabled])[0]?.lastSweepAt, null);
    writeFileSync(join(gate, "release"), "");
    await sweep;
    assert.equal(taskSourceStatuses([enabled])[0]?.lastSweepAt, null);
  } finally {
    delete process.env.TASK_SOURCE_SWEEP_GATE;
    writeFileSync(join(gate, "release"), "");
    await sweep;
  }
});
