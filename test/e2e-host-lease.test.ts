import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireE2eHostLease,
  assertE2eWorkerLimit,
  E2E_MAX_WORKERS,
  type E2eHostLease,
} from "../e2e/host-lease.ts";

async function fixture(): Promise<{ root: string; metadataPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "mission-e2e-lease-test-"));
  return { root, metadataPath: join(root, "owner.json") };
}

test("the E2E worker ceiling rejects a CLI override above four", () => {
  assert.equal(E2E_MAX_WORKERS, 4);
  assert.doesNotThrow(() => assertE2eWorkerLimit(1));
  assert.doesNotThrow(() => assertE2eWorkerLimit(4));
  assert.throws(() => assertE2eWorkerLimit(5), /limited to 4 workers per host/);
});

test("a second E2E suite waits until the host lease is released", async () => {
  const { root, metadataPath } = await fixture();
  try {
    const first = await acquireE2eHostLease({ metadataPath, port: 0, workers: 4 });
    let secondSettled = false;
    let observedOwnerPid: number | null = null;
    const secondPromise = acquireE2eHostLease({
      metadataPath,
      port: first.owner.port,
      workers: 2,
      pollMs: 10,
      waitTimeoutMs: 2_000,
      onWait: (owner) => {
        observedOwnerPid = owner?.pid ?? null;
      },
    }).then((lease) => {
      secondSettled = true;
      return lease;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondSettled, false);
    assert.equal(observedOwnerPid, process.pid);

    await first.release();
    const second = await secondPromise;
    assert.equal(secondSettled, true);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crashed owner leaves no kernel lease to reclaim", async () => {
  const { root, metadataPath } = await fixture();
  try {
    await writeFile(metadataPath, JSON.stringify({
      token: "dead-owner",
      pid: 2_147_483_647,
      acquiredAt: "2026-01-01T00:00:00.000Z",
      cwd: "/stale/checkout",
      argv: ["playwright", "test"],
      workers: 4,
      port: 1,
    }));

    const lease = await acquireE2eHostLease({ metadataPath, port: 0, workers: 4 });
    assert.equal(lease.owner.pid, process.pid);
    assert.notEqual(lease.owner.token, "dead-owner");
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unrelated process on the lease port fails fast", async () => {
  const { root, metadataPath } = await fixture();
  const unrelated = createServer((socket) => socket.end("not-a-mission-control-lease\n"));
  try {
    await new Promise<void>((resolve) => unrelated.listen(0, "127.0.0.1", resolve));
    const address = unrelated.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      acquireE2eHostLease({
        metadataPath,
        port: address.port,
        workers: 4,
        waitTimeoutMs: 60_000,
      }),
      /not a compatible Mission Control E2E host lease/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => unrelated.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
    await rm(root, { recursive: true, force: true });
  }
});

test("a protocol mimic without matching metadata fails after a short grace period", async () => {
  const { root, metadataPath } = await fixture();
  const mimic = createServer((socket) => {
    socket.end("mission-control-e2e-lease-v1:not-a-real-owner\n");
  });
  try {
    await new Promise<void>((resolve) => mimic.listen(0, "127.0.0.1", resolve));
    const address = mimic.address();
    assert.ok(address && typeof address !== "string");
    await assert.rejects(
      acquireE2eHostLease({
        metadataPath,
        port: address.port,
        workers: 4,
        pollMs: 5,
        waitTimeoutMs: 60_000,
        metadataGraceMs: 25,
      }),
      /did not publish matching owner metadata within 25ms/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => mimic.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent waiters cannot hold the kernel lease together", async () => {
  const { root, metadataPath } = await fixture();
  try {
    const first = await acquireE2eHostLease({ metadataPath, port: 0, workers: 4 });
    let active = 0;
    let maxActive = 0;
    const runWaiter = async (): Promise<void> => {
      const lease = await acquireE2eHostLease({
        metadataPath,
        port: first.owner.port,
        workers: 4,
        pollMs: 5,
        waitTimeoutMs: 2_000,
      });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      await lease.release();
    };
    const waiters = [runWaiter(), runWaiter(), runWaiter()];

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(active, 0);
    await first.release();
    await Promise.all(waiters);
    assert.equal(maxActive, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release removes old metadata before a successor can publish", async () => {
  const { root, metadataPath } = await fixture();
  try {
    let allowMetadataRemoval!: () => void;
    const metadataMayBeRemoved = new Promise<void>((resolve) => {
      allowMetadataRemoval = resolve;
    });
    let cleanupStarted = false;
    const first = await acquireE2eHostLease({
      metadataPath,
      port: 0,
      workers: 4,
      beforeReleaseMetadataRemoval: async () => {
        cleanupStarted = true;
        await metadataMayBeRemoved;
      },
    });
    const firstRelease = first.release();
    while (!cleanupStarted) await new Promise((resolve) => setTimeout(resolve, 1));

    let secondSettled = false;
    const secondPromise = acquireE2eHostLease({
      metadataPath,
      port: first.owner.port,
      workers: 4,
      pollMs: 5,
      waitTimeoutMs: 2_000,
    }).then((lease) => {
      secondSettled = true;
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(secondSettled, false);

    allowMetadataRemoval();
    await firstRelease;
    const second = await secondPromise;
    const current = JSON.parse(await readFile(metadataPath, "utf8")) as { token: string };
    assert.equal(current.token, second.owner.token);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an E2E suite times out with the live owner's identity", async () => {
  const { root, metadataPath } = await fixture();
  let first: E2eHostLease | null = null;
  try {
    first = await acquireE2eHostLease({ metadataPath, port: 0, workers: 4 });
    await assert.rejects(
      acquireE2eHostLease({
        metadataPath,
        port: first.owner.port,
        workers: 1,
        pollMs: 5,
        waitTimeoutMs: 25,
      }),
      (error: Error) => {
        assert.match(error.message, new RegExp(`held by pid ${process.pid}`));
        assert.match(error.message, /Timed out waiting for the Mission Control E2E host lease/);
        return true;
      },
    );
  } finally {
    await first?.release();
    await rm(root, { recursive: true, force: true });
  }
});
