import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeepAwakeChild } from "../src/server/keep-awake.ts";

// What is at stake: the operator's Keep awake choice has to be in the database - the one
// thing an upgrade carries across - and nothing about how it reads back may ever hold this
// Mac awake by accident. So a stored `true` round-trips, while every other thing the row can
// be (missing, not JSON, the wrong shape, from a future build) reads as off, and the manager
// built over this store behaves across a simulated daemon restart exactly as the dashboard
// promises: the choice outlives the process, the assertion does not.

// Set before anything imports the server graph: `config.ts` freezes the state directory the
// moment it is evaluated, and an unset home would write this test's rows into a real one.
const home = mkdtempSync(join(tmpdir(), "mission-keep-awake-preference-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { keepAwakePreferenceStore } = await import("../src/server/keep-awake-preference.ts");
const { KeepAwakeManager } = await import("../src/server/keep-awake.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const ROW = "keepAwake";
const store = keepAwakePreferenceStore();

function rawRow(): string | undefined {
  const row = openDb().prepare("SELECT value FROM app_config WHERE key = ?").get(ROW) as
    | { value: string }
    | undefined;
  return row?.value;
}

function writeRaw(value: string): void {
  openDb()
    .prepare(
      `INSERT INTO app_config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(ROW, value);
}

test("nothing saved reads as off, and reading writes nothing", () => {
  openDb().prepare("DELETE FROM app_config WHERE key = ?").run(ROW);
  assert.equal(store.load(), false);
  assert.equal(rawRow(), undefined, "a read must never create the row");
});

test("the choice round-trips as one small row under the registered key", () => {
  store.save(true);
  assert.equal(rawRow(), JSON.stringify({ enabled: true }));
  assert.equal(store.load(), true);

  store.save(false);
  assert.equal(rawRow(), JSON.stringify({ enabled: false }));
  assert.equal(store.load(), false);
});

test("a damaged or foreign row reads as off instead of throwing or holding the Mac awake", () => {
  for (const damaged of [
    "not json at all",
    "true",
    '"on"',
    "null",
    "[]",
    '{"enabled":"yes"}',
    '{"enabled":1}',
    '{"on":true}',
    "{}",
  ]) {
    writeRaw(damaged);
    assert.equal(store.load(), false, `${damaged} must read as off`);
  }
});

test("a row written by a newer build with extra fields still reads its choice", () => {
  writeRaw(JSON.stringify({ enabled: true, schedule: "overnight" }));
  assert.equal(store.load(), true);
});

/** A command child that confirms its spawn, so the manager can reach `on` without an OS. */
function spawnedChild(): KeepAwakeChild {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const child: KeepAwakeChild & { emit: (event: string, ...args: unknown[]) => void } = {
    pid: 4242,
    on(event: string, listener: (...args: never[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return child;
    },
    kill() {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) (listener as (...a: unknown[]) => void)(...args);
    },
  };
  queueMicrotask(() => child.emit("spawn"));
  return child;
}

function daemon() {
  return new KeepAwakeManager({
    platform: "darwin",
    override: "/usr/bin/caffeinate",
    daemonPid: 7317,
    spawn: () => spawnedChild(),
    preference: keepAwakePreferenceStore(),
  });
}

test("the choice outlives a daemon restart through the real database, the assertion does not", async () => {
  openDb().prepare("DELETE FROM app_config WHERE key = ?").run(ROW);

  const before = daemon();
  assert.equal((await before.setEnabled(true)).state, "on");
  await before.stop(); // the old daemon's orderly shutdown during an upgrade
  assert.equal(before.status().state, "off", "its assertion is gone");
  assert.equal(rawRow(), JSON.stringify({ enabled: true }), "its shutdown left the choice alone");

  const successor = daemon();
  assert.equal(successor.status().state, "off", "a fresh daemon observes nothing held yet");
  assert.equal((await successor.restore()).state, "on", "and takes its own assertion from the choice");

  // Switching it off is saved just the same, so the daemon after that one takes nothing.
  assert.equal((await successor.setEnabled(false)).state, "off");
  await successor.stop();
  const last = daemon();
  assert.equal((await last.restore()).state, "off");
});
