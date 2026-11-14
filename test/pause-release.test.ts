import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "../src/shared/types.ts";
import type { SdkSupervisor as SdkSupervisorType } from "../src/server/sdk/supervisor.ts";

// What is at stake: a frozen agent answers nothing, so every operation that needs it to - a
// stop, a kill, an interrupt, a reset - has to thaw it first. That thaw is an explicit
// dependency of each operation, handed to it by whoever calls it, never a callback some other
// module installed: a missing one is visible in the call, and no test or second manager can
// swap it out from under another.

const home = mkdtempSync(join(tmpdir(), "mission-pause-release-"));
process.env.HARNESS_HOME = home;
const { requestSessionStop, stopSession, interruptSession } = await import("../src/server/sdk/control.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { Registry } = await import("../src/server/registry.ts");
after(() => rmSync(home, { recursive: true, force: true }));

const PAUSED = { reason: "operator", phase: "frozen", since: 1, interrupted: null } as const;

function recordingRelease(events: string[]) {
  return { releaseNow: (id: string): string | null => (events.push(`release ${id}`), null) };
}

test("Kill and a task's stop thaw a paused terminal agent before the SIGTERM", async () => {
  const session = { id: "proc:t1:42:1", runtime: "terminal", pid: 42, pause: PAUSED } as unknown as Session;
  for (const stop of [requestSessionStop, stopSession]) {
    const events: string[] = [];
    const result = await stop(session, undefined, async (s) => {
      events.push(`kill ${s.id}`);
      return { ok: true };
    }, recordingRelease(events));
    assert.equal(result.ok, true);
    assert.deepEqual(events, ["release proc:t1:42:1", "kill proc:t1:42:1"], `${stop.name} thaws first`);
  }
});

test("an interrupt on a paused session thaws it, and goes on as if it were never paused", async () => {
  const events: string[] = [];
  const session = { id: "sdk:i1", runtime: "sdk", agent: "claude", state: "working", pause: PAUSED } as unknown as Session;
  const supervisor = {
    interrupt: async (id: string) => {
      events.push(`interrupt ${id}`);
      return "stopped";
    },
  } as unknown as SdkSupervisorType;
  await interruptSession(session, supervisor, undefined, undefined, recordingRelease(events));
  assert.deepEqual(events.slice(0, 2), ["release sdk:i1", "interrupt sdk:i1"]);
});

test("every SDK stop thaws first, through the pause the supervisor was constructed with", async () => {
  const events: string[] = [];
  const supervisor = new SdkSupervisor(new Registry(), {
    pause: { ...recordingRelease(events), frozenRefusal: () => null },
  });
  await supervisor.stop("sdk:no-driver");
  assert.deepEqual(events, ["release sdk:no-driver"]);
});

test("the supervisor refuses a write only while the pause it was handed says the child is stopped", async () => {
  let frozen: string | null = "this session is paused - resume it before sending it anything";
  const supervisor = new SdkSupervisor(new Registry(), {
    pause: { releaseNow: () => null, frozenRefusal: () => frozen },
  });
  await assert.rejects(supervisor.send("sdk:frozen", { text: "hi" }), /paused/);
  frozen = null;
  // Not frozen: the refusal is now about the missing driver, not the pause.
  await assert.rejects(supervisor.send("sdk:frozen", { text: "hi" }), /no live driver/);
});

test("nothing installs a module-level release callback any more", () => {
  const release = readFileSync(new URL("../src/server/pause/release.ts", import.meta.url), "utf8");
  assert.doesNotMatch(release, /^\s*(let|var)\s/m, "release.ts holds no mutable state");
  assert.doesNotMatch(release, /export function/, "release.ts exports only the interface");
  const offenders: string[] = [];
  const walk = (dir: URL) => {
    for (const name of readdirSync(dir)) {
      const url = new URL(name, dir);
      if (statSync(url).isDirectory()) walk(new URL(`${name}/`, dir));
      else if (/\.tsx?$/.test(name) && /installPauseRelease|releasePause\(/.test(readFileSync(url, "utf8"))) offenders.push(name);
    }
  };
  walk(new URL("../src/server/", import.meta.url));
  assert.deepEqual(offenders, []);
});

const STUCK = "pid 81 (EPERM) would not continue";

test("a stop or kill does not go on when the paused agent could not be thawed", async () => {
  const session = { id: "proc:t2:81:1", runtime: "terminal", pid: 81, pause: PAUSED } as unknown as Session;
  for (const stop of [requestSessionStop, stopSession]) {
    let killed = false;
    const result = await stop(session, undefined, async () => {
      killed = true;
      return { ok: true };
    }, { releaseNow: () => STUCK });
    assert.equal(result.ok, false, `${stop.name} reports it`);
    assert.match(result.error ?? "", /could not be resumed first, so nothing else was done: pid 81/);
    assert.equal(killed, false, `${stop.name} sent no SIGTERM to a process that cannot act on it`);
  }
});

test("an interrupt does not go on when the paused agent could not be thawed", async () => {
  let interrupted = false;
  const session = { id: "sdk:i2", runtime: "sdk", agent: "claude", state: "working", pause: PAUSED } as unknown as Session;
  const supervisor = { interrupt: async () => { interrupted = true; return "stopped"; } } as unknown as SdkSupervisorType;
  const result = await interruptSession(session, supervisor, undefined, undefined, { releaseNow: () => STUCK });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error ?? "", /could not be resumed first/);
  assert.equal(interrupted, false);
});

test("a reset does not type into an agent that could not be thawed", async () => {
  const { resetSession } = await import("../src/server/reset.ts");
  const registry = new Registry();
  registry.registerSdkSession({ id: "sdk:r1", agent: "claude", name: "r1", cwd: "/repo/r1", agentSessionId: "conv:r1" });
  const session = { ...registry.getSession("sdk:r1")!, pause: PAUSED } as Session;
  let reset = false;
  const result = await resetSession(registry, session, true, async () => {
    reset = true;
    return { ok: true, error: null, root: "/repo/r1", cleared: true, detached: false };
  }, undefined, undefined, { releaseNow: () => STUCK });
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /could not be resumed first/);
  assert.equal(reset, false, "nothing was typed");
});

test("an SDK stop is refused, not left waiting on a driver that cannot answer", async () => {
  const supervisor = new SdkSupervisor(new Registry(), {
    pause: { releaseNow: () => STUCK, frozenRefusal: () => null },
  });
  await assert.rejects(supervisor.stop("sdk:stuck"), /could not be resumed first: pid 81/);
});
