import { test } from "node:test";
import assert from "node:assert/strict";
import { drainBackgroundStart, ownElectronBackgroundStart } from "../src/main/daemon-policy.ts";
import { holdQuitUntilDrained } from "../src/main/quit-drain.ts";

const noop = async (): Promise<void> => {};

/** A background process whose exit the test releases, the way a daemon's shutdown finishes. */
function exitingProcess(order: string[], name: string) {
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  return {
    exit: () => { order.push(`${name} exited`); exit(); },
    process: { stop: () => { order.push(`stop ${name}`); return exited; } },
  };
}

test("Vite-backed Electron leaves the daemon and Foreman to the development stack", async () => {
  let daemonStarts = 0;
  let foremanStarts = 0;

  const stacks = await Promise.all(
    [1, 2, 3].map(() =>
      ownElectronBackgroundStart(
        "http://localhost:5173",
        async () => {
          daemonStarts += 1;
          return { stop: noop };
        },
        async () => {
          foremanStarts += 1;
          return { stop: noop };
        },
      ).ready,
    ),
  );

  assert.deepEqual(stacks, [null, null, null]);
  assert.equal(daemonStarts, 0);
  assert.equal(foremanStarts, 0);
});

test("packaged Electron owns both the daemon and a Foreman worker", async () => {
  const order: string[] = [];
  const daemon = { adopted: true, stop: noop };
  const foreman = { stop: noop };

  const owned = ownElectronBackgroundStart(
    undefined,
    async () => {
      order.push("daemon");
      return daemon;
    },
    async () => {
      order.push("foreman");
      return foreman;
    },
  );

  assert.deepEqual(await owned.ready, { daemon, foreman });
  assert.deepEqual(order, ["daemon", "foreman"]);
});

test("quitting during daemon startup stops it without starting Foreman, and waits for its exit", async () => {
  let resolveStart!: (daemon: { adopted: boolean; stop: () => Promise<void> }) => void;
  const order: string[] = [];
  const daemon = exitingProcess(order, "daemon");
  const pending = new Promise<{ adopted: boolean; stop: () => Promise<void> }>((resolve) => (resolveStart = resolve));
  const startup = ownElectronBackgroundStart(undefined, () => pending, async () => {
    order.push("start foreman");
    return { stop: async () => { order.push("stop foreman"); } };
  });

  let stopped = false;
  const stopping = startup.stop().then(() => { stopped = true; });
  resolveStart({ adopted: false, ...daemon.process });

  assert.deepEqual(await startup.ready, { daemon: { adopted: false, ...daemon.process }, foreman: null });
  assert.deepEqual(order, ["stop daemon"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "the stop resolved before the daemon it raced had exited");
  daemon.exit();
  await stopping;
  assert.equal(startup.stop(), startup.stop(), "every stop call shares one drain");
  assert.deepEqual(order, ["stop daemon", "daemon exited"], "the ownership stop is idempotent");
});

test("packaged shutdown stops Foreman before the daemon and resolves only after both exited", async () => {
  const order: string[] = [];
  const daemon = exitingProcess(order, "daemon");
  const foreman = exitingProcess(order, "foreman");
  const startup = ownElectronBackgroundStart(
    undefined,
    async () => daemon.process,
    async () => foreman.process,
  );

  await startup.ready;
  let stopped = false;
  const stopping = startup.stop().then(() => { stopped = true; });
  assert.deepEqual(order, ["stop foreman", "stop daemon"]);
  foreman.exit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "the stop resolved while the daemon was still shutting down");
  daemon.exit();
  await stopping;
  assert.equal(stopped, true);
});

test("a drain waits for the daemon's own shutdown, and a hung one is bounded rather than awaited forever", async () => {
  const order: string[] = [];
  const daemon = exitingProcess(order, "daemon");
  const startup = ownElectronBackgroundStart(undefined, async () => daemon.process, async () => ({ stop: noop }));
  await startup.ready;
  const draining = drainBackgroundStart(startup, 60_000);
  setTimeout(() => daemon.exit(), 20);
  assert.equal(await draining, "drained");
  assert.deepEqual(order, ["stop daemon", "daemon exited"]);

  const hung = ownElectronBackgroundStart(undefined, async () => ({ stop: () => new Promise<void>(() => {}) }), async () => ({ stop: noop }));
  await hung.ready;
  assert.equal(await drainBackgroundStart(hung, 20), "timed-out");
  assert.equal(await drainBackgroundStart(null, 20), "drained", "development owns no background stack");
});

/** An app double that records the quit sequence the way Electron would drive it. */
function quittingApp() {
  const order: string[] = [];
  let listener: ((event: { preventDefault(): void }) => void) | null = null;
  const app = {
    on: (_event: "before-quit", next: typeof listener) => { listener = next; },
    quit: () => {
      let prevented = false;
      order.push("quit requested");
      listener?.({ preventDefault: () => { prevented = true; } });
      order.push(prevented ? "quit held" : "app exits");
    },
  };
  return { app, order };
}

test("a quit is held until the drain settles, then completes, and repeat requests join one drain", async () => {
  const { app, order } = quittingApp();
  let release!: () => void;
  let drains = 0;
  holdQuitUntilDrained(app, {
    beforeQuit: () => order.push("shell stopped"),
    owned: () => true,
    drain: () => { drains += 1; order.push("drain started"); return new Promise<void>((resolve) => { release = resolve; }); },
  });
  app.quit();
  app.quit();
  assert.deepEqual(order, ["quit requested", "shell stopped", "drain started", "quit held", "quit requested", "shell stopped", "quit held"]);
  assert.equal(drains, 1);
  order.length = 0;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["quit requested", "shell stopped", "app exits"], "the app exited before the drain settled, or never did");
});

test("a quit with no owned background stack, or a drain that fails, still exits", async () => {
  const unowned = quittingApp();
  holdQuitUntilDrained(unowned.app, { beforeQuit: () => {}, owned: () => false, drain: () => { throw new Error("must not drain"); } });
  unowned.app.quit();
  assert.deepEqual(unowned.order, ["quit requested", "app exits"]);

  const failing = quittingApp();
  holdQuitUntilDrained(failing.app, { beforeQuit: () => {}, owned: () => true, drain: () => Promise.reject(new Error("daemon gone")) });
  failing.app.quit();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(failing.order, ["quit requested", "quit held", "quit requested", "app exits"]);
});

test('a failed Foreman startup still drains its owned daemon', async () => {
  let stopped = false;
  const startup = ownElectronBackgroundStart(undefined,
    async () => ({async stop() { stopped = true; }}),
    async () => { throw new Error('Foreman unavailable'); });
  await assert.rejects(startup.ready, /Foreman unavailable/);
  await startup.stop();
  assert.equal(stopped, true);
});
