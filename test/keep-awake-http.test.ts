import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeepAwakeStatus } from "../src/shared/types.ts";
import type { Registry } from "../src/server/registry.ts";
import type { ReviewManager } from "../src/server/reviews.ts";
import type { TaskManager } from "../src/server/tasks.ts";
import type { QueueManager } from "../src/server/queue.ts";
import { KeepAwakeManager, type KeepAwakeChild } from "../src/server/keep-awake.ts";

// What is at stake: these two routes are the only write path to host power state, and
// their status codes are the browser's contract. A 200 must mean the OBSERVED transition
// completed - the route waits for the manager, never echoes the request - while 409
// (unsupported host), 502 (the OS transition failed) and 503 (a build with no manager)
// each name a different, non-retriable-in-the-same-way failure. The body schema is
// strict, so a caller confused about the contract is refused rather than half-honoured.

const home = mkdtempSync(join(tmpdir(), "mission-keep-awake-http-"));
process.env.HARNESS_HOME = home;
const { buildApp } = await import("../src/server/routes.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const HEADERS = { host: "127.0.0.1:7317", "content-type": "application/json" };

/** A child whose spawn/error/exit behavior the test scripts. */
function scriptedChild(script: "spawn" | "error"): KeepAwakeChild {
  const listeners = new Map<string, ((...args: never[]) => void)[]>();
  const child: KeepAwakeChild & { emit: (e: string, ...a: unknown[]) => void } = {
    pid: 4242,
    on(event: string, listener: (...args: never[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return child;
    },
    kill() {
      queueMicrotask(() => child.emit("exit", null, "SIGTERM"));
      return true;
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
    },
  };
  queueMicrotask(() =>
    script === "spawn" ? child.emit("spawn") : child.emit("error", new Error("spawn refused")),
  );
  return child;
}

function appWith(manager?: KeepAwakeManager, onStatus?: (s: KeepAwakeStatus) => void) {
  void onStatus;
  return buildApp(
    {} as unknown as Registry,
    {} as unknown as ReviewManager,
    {} as unknown as TaskManager,
    {} as unknown as QueueManager,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    manager,
  );
}

function workingManager(over: { script?: "spawn" | "error"; platform?: NodeJS.Platform } = {}) {
  const statuses: KeepAwakeStatus[] = [];
  const manager = new KeepAwakeManager({
    platform: over.platform ?? "darwin",
    override: null,
    daemonPid: 7317,
    now: () => 1_700_000_000_000,
    spawn: () => scriptedChild(over.script ?? "spawn"),
    onStatus: (s) => statuses.push(s),
  });
  return { manager, statuses };
}

const put = (app: ReturnType<typeof appWith>, body: unknown) =>
  app.request("/api/keep-awake", {
    method: "PUT",
    headers: HEADERS,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("a legacy test app without the manager answers 503, not a second owner", async () => {
  const app = appWith(undefined);
  const got = await app.request("/api/keep-awake", { headers: HEADERS });
  assert.equal(got.status, 503);
  const wrote = await put(app, { enabled: true });
  assert.equal(wrote.status, 503);
});

test("GET reports the manager's observed status", async () => {
  const { manager } = workingManager();
  const app = appWith(manager);
  const res = await app.request("/api/keep-awake", { headers: HEADERS });
  assert.equal(res.status, 200);
  const status = (await res.json()) as KeepAwakeStatus;
  assert.equal(status.state, "off");
  assert.equal(status.supported, true);
  assert.equal(status.provider, "caffeinate");
});

test("the body schema is strict: missing, mistyped, and surplus fields are 400", async () => {
  const { manager } = workingManager();
  const app = appWith(manager);
  for (const body of [{}, { enabled: "yes" }, { enabled: 1 }, { enabled: true, persist: true }]) {
    const res = await put(app, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} must be refused`);
  }
  // And a write that failed validation must not have moved the state.
  assert.equal(manager.status().state, "off");
});

test("an unsupported host refuses with 409 and its reason, and never spawns", async () => {
  const { manager, statuses } = workingManager({ platform: "linux" });
  const app = appWith(manager);
  const res = await put(app, { enabled: true });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { code: string; error: string; status: KeepAwakeStatus };
  assert.equal(body.code, "keep_awake_unavailable");
  assert.match(body.error, /unavailable/i);
  assert.equal(body.status.supported, false);
  assert.deepEqual(statuses, [], "nothing was published for a refused request");
});

test("a successful enable answers 200 with the CONFIRMED on, then disable returns off", async () => {
  const { manager } = workingManager();
  const app = appWith(manager);
  const on = await put(app, { enabled: true });
  assert.equal(on.status, 200);
  const onStatus = (await on.json()) as KeepAwakeStatus;
  assert.equal(onStatus.state, "on");
  assert.equal(onStatus.since, 1_700_000_000_000);

  const off = await put(app, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(((await off.json()) as KeepAwakeStatus).state, "off");
});

test("repeating the achieved state stays 200: idempotence is a route property too", async () => {
  const { manager } = workingManager();
  const app = appWith(manager);
  await put(app, { enabled: true });
  const again = await put(app, { enabled: true });
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as KeepAwakeStatus).state, "on");
});

test("a failed OS transition answers 502 carrying the observed error status", async () => {
  const { manager } = workingManager({ script: "error" });
  const app = appWith(manager);
  const res = await put(app, { enabled: true });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { code: string; error: string; status: KeepAwakeStatus };
  assert.equal(body.code, "keep_awake_failed");
  assert.match(body.error, /spawn refused/);
  assert.equal(body.status.state, "error");
  // And GET agrees: the route reported the state it left behind, not a hopeful one.
  const got = await app.request("/api/keep-awake", { headers: HEADERS });
  assert.equal(((await got.json()) as KeepAwakeStatus).state, "error");
});

test("the routes sit behind the loopback host guard like every data endpoint", async () => {
  const { manager } = workingManager();
  const app = appWith(manager);
  const res = await app.request("/api/keep-awake", {
    headers: { host: "evil.example.com" },
  });
  assert.equal(res.status, 403);
});
