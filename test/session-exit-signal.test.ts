import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session } from "../src/shared/types.ts";
import { mkTask } from "./helpers/session-fixture.ts";

/**
 * `Registry.onSessionExit` - the one moment a reader gets between "this session is over" and
 * "this session is gone".
 *
 * The window is real and it is short. `beginEviction` marks a session `exited` and arms a
 * timer to `remove` it EXIT_LINGER_MS later; 8 seconds. Anything that polls `liveSessions()`
 * has already stopped seeing it, and anything that waits for the next tick of its own loop
 * may never see it again at all - the retro worthiness scan runs every 10s by default, so
 * for that reader the row is reliably deleted before its next look.
 *
 * So this is not a convenience hook. It is the difference between a fact about a finished
 * session being readable and being lost, and the two things it has to guarantee are that it
 * fires ONCE per eviction and that it fires while the row is still in the map.
 *
 * MISSION_HOME before a DYNAMIC import: `Registry`'s constructor opens the database, and a
 * static import would be hoisted above the assignment (see `db.ts`'s isolation guard).
 */

const home = mkdtempSync(join(tmpdir(), "mission-exit-signal-"));
process.env.MISSION_HOME = home;

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    pid: 1,
    tty: "ttys1",
    terminals: [],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

test("a session vanishing from a sweep announces its exit exactly once", () => {
  const registry = new Registry();
  const seen: Session[] = [];
  const stop = registry.onSessionExit((session) => seen.push(session));

  registry.applyDiscovery([mkDiscovered({ syntheticId: "dying" })]);
  // A length check rather than `deepEqual(seen, [])`: node's assert types that as
  // `asserts actual is never[]`, which narrows the array for the rest of the test and makes
  // every later read of a Session field a type error.
  assert.equal(seen.length, 0, "a live session announces nothing");

  // Gone from the sweep: marked exited, and the eviction timer armed.
  registry.applyDiscovery([]);
  assert.equal(seen.length, 1, "the eviction has to announce itself");
  assert.equal(seen[0]?.id, "dying");

  // ONCE. `beginEviction` is reached on every subsequent empty sweep, and a listener that
  // re-read a transcript on each one would turn a bounded piece of work into a loop for the
  // whole linger window.
  registry.applyDiscovery([]);
  registry.applyDiscovery([]);
  assert.equal(seen.length, 1, "a session already on its way out must not announce again");
  stop();
});

test("the announced session is still in the registry, and already reads as exited", () => {
  // Both halves are what make the hook usable. A listener's whole purpose is to record
  // something ABOUT the session - `recordRetroCorrections` writes onto the row and emits -
  // so a signal delivered after `remove` would have nowhere to put it, which is exactly why
  // this is not simply `session_remove`.
  const registry = new Registry();
  // An array rather than a reassigned local: the assignment happens inside a callback, which
  // TypeScript's control flow cannot see, so a `let` would narrow to `never` after the
  // presence assertion below.
  const seen: Array<{ session: Session; stillPresent: boolean }> = [];
  const stop = registry.onSessionExit((session) => {
    seen.push({ session, stillPresent: registry.getSession(session.id) !== undefined });
  });

  registry.applyDiscovery([mkDiscovered({ syntheticId: "late" })]);
  registry.applyDiscovery([]);

  const announced = seen[0];
  assert.ok(announced, "nothing was announced");
  assert.equal(announced.stillPresent, true, "the row has to still be there when the hook fires");
  assert.equal(announced.session.state, "exited", "the projection handed over is the post-exit one");
  assert.equal(announced.session.id, "late");
  stop();
});

test("unsubscribing stops the announcements", () => {
  const registry = new Registry();
  let calls = 0;
  const stop = registry.onSessionExit(() => { calls += 1; });
  stop();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "ignored" })]);
  registry.applyDiscovery([]);
  assert.equal(calls, 0);
});

test("Pipeline host replacement detaches the task and enters the one eviction path once", async () => {
  const registry = new Registry();
  const session = registry.registerSdkSession({
    id: "sdk:failed-engineer-host",
    agent: "codex",
    name: "failed Engineer",
    cwd: "/repo",
    agentSessionId: "failed-engineer-agent",
  });
  registry.upsertTask(mkTask({
    id: "pipeline-host-replacement",
    kind: "pipeline",
    agent: "codex",
    repoRoot: "/repo",
    status: "running",
    sessionId: session.id,
  }));
  const exits: string[] = [];
  registry.onSessionExit((exited) => exits.push(exited.id));
  let stops = 0;

  assert.equal(await registry.replacePipelineEngineerHost(
    "pipeline-host-replacement",
    session.id,
    async () => { stops += 1; },
  ), true);
  assert.equal(registry.getTask("pipeline-host-replacement")?.sessionId, null);
  assert.equal(registry.getSession(session.id)?.state, "exited");
  assert.deepEqual(exits, [session.id]);
  assert.equal(stops, 1);
  assert.equal(await registry.replacePipelineEngineerHost(
    "pipeline-host-replacement",
    session.id,
    async () => { stops += 1; },
  ), false);
  assert.deepEqual(exits, [session.id]);
  assert.equal(stops, 1);
});
