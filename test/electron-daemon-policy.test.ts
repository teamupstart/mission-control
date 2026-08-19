import { test } from "node:test";
import assert from "node:assert/strict";
import { ownElectronDaemonStart, startElectronOwnedDaemon } from "../src/main/daemon-policy.ts";

test("Vite-backed Electron restarts leave the daemon to dev:server", async () => {
  let starts = 0;

  const daemons = await Promise.all(
    [1, 2, 3].map(() =>
      startElectronOwnedDaemon("http://localhost:5173", async () => {
        starts += 1;
        return { adopted: false };
      }),
    ),
  );

  assert.deepEqual(daemons, [null, null, null]);
  assert.equal(starts, 0, "Electron must not start a competing supervised daemon in development");
});

test("packaged Electron still starts or adopts its daemon", async () => {
  const owned = { adopted: true };
  let starts = 0;

  const daemon = await startElectronOwnedDaemon(undefined, async () => {
    starts += 1;
    return owned;
  });

  assert.equal(daemon, owned);
  assert.equal(starts, 1);
});

test("quitting during daemon startup stops the controller as soon as startup resolves", async () => {
  let resolveStart!: (daemon: { adopted: boolean; stop: () => void }) => void;
  let stops = 0;
  const owned = {
    adopted: false,
    stop: () => {
      stops += 1;
    },
  };
  const pending = new Promise<typeof owned>((resolve) => (resolveStart = resolve));
  const startup = ownElectronDaemonStart(undefined, () => pending);

  startup.stop();
  resolveStart(owned);

  assert.equal(await startup.ready, owned);
  assert.equal(stops, 1);
  startup.stop();
  assert.equal(stops, 1, "the ownership stop is idempotent");
});
