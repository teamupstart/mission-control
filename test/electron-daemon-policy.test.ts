import { test } from "node:test";
import assert from "node:assert/strict";
import { ownElectronBackgroundStart } from "../src/main/daemon-policy.ts";

test("Vite-backed Electron leaves the daemon and Foreman to the development stack", async () => {
  let daemonStarts = 0;
  let foremanStarts = 0;

  const stacks = await Promise.all(
    [1, 2, 3].map(() =>
      ownElectronBackgroundStart(
        "http://localhost:5173",
        async () => {
          daemonStarts += 1;
          return { stop() {} };
        },
        async () => {
          foremanStarts += 1;
          return { stop() {} };
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
  const daemon = { adopted: true, stop() {} };
  const foreman = { stop() {} };

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

test("quitting during daemon startup stops it without starting Foreman", async () => {
  let resolveStart!: (daemon: { adopted: boolean; stop: () => void }) => void;
  const order: string[] = [];
  const daemon = {
    adopted: false,
    stop: () => {
      order.push("stop daemon");
    },
  };
  const pending = new Promise<typeof daemon>((resolve) => (resolveStart = resolve));
  const startup = ownElectronBackgroundStart(undefined, () => pending, async () => {
    order.push("start foreman");
    return { stop: () => order.push("stop foreman") };
  });

  startup.stop();
  resolveStart(daemon);

  assert.deepEqual(await startup.ready, { daemon, foreman: null });
  assert.deepEqual(order, ["stop daemon"]);
  startup.stop();
  assert.deepEqual(order, ["stop daemon"], "the ownership stop is idempotent");
});

test("packaged shutdown stops Foreman before the daemon", async () => {
  const order: string[] = [];
  const startup = ownElectronBackgroundStart(
    undefined,
    async () => ({ stop: () => order.push("daemon") }),
    async () => ({ stop: () => order.push("foreman") }),
  );

  await startup.ready;
  startup.stop();
  assert.deepEqual(order, ["foreman", "daemon"]);
});
