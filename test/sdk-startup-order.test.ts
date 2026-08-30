import assert from "node:assert/strict";
import test from "node:test";

import { startDiscoveryAfterSdkRestore } from "../src/server/sdk/startup.ts";

test("terminal discovery cannot start before SDK restoration settles", async () => {
  let settle: (() => void) | null = null;
  const restore = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let starts = 0;
  const coordinated = startDiscoveryAfterSdkRestore(
    restore,
    () => {
      starts += 1;
      return () => {};
    },
    () => false,
    (error) => assert.fail(String(error)),
  );

  await Promise.resolve();
  assert.equal(starts, 0, "the first terminal observation remains gated");
  settle!();
  assert.equal(typeof await coordinated, "function");
  assert.equal(starts, 1);
});

test("settled restore failure opens discovery, but shutdown does not", async () => {
  const errors: unknown[] = [];
  let starts = 0;
  const afterFailure = await startDiscoveryAfterSdkRestore(
    Promise.reject(new Error("restore failed")),
    () => {
      starts += 1;
      return () => {};
    },
    () => false,
    (error) => errors.push(error),
  );
  assert.equal(typeof afterFailure, "function");
  assert.equal(starts, 1);
  assert.match(String(errors[0]), /restore failed/);

  const duringShutdown = await startDiscoveryAfterSdkRestore(
    Promise.resolve(),
    () => {
      starts += 1;
      return () => {};
    },
    () => true,
    (error) => assert.fail(String(error)),
  );
  assert.equal(duringShutdown, null);
  assert.equal(starts, 1);
});
