import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireE2eHostLease,
  assertE2eWorkerLimit,
  E2E_MAX_WORKERS,
  type E2eLeaseOwner,
} from "../e2e/host-lease.ts";

async function fixture(): Promise<{ root: string; lockDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "mission-e2e-lease-test-"));
  return { root, lockDir: join(root, "host.lock") };
}

test("the E2E worker ceiling rejects a CLI override above four", () => {
  assert.equal(E2E_MAX_WORKERS, 4);
  assert.doesNotThrow(() => assertE2eWorkerLimit(1));
  assert.doesNotThrow(() => assertE2eWorkerLimit(4));
  assert.throws(() => assertE2eWorkerLimit(5), /limited to 4 workers per host/);
});

test("a second E2E suite waits until the host lease is released", async () => {
  const { root, lockDir } = await fixture();
  try {
    const first = await acquireE2eHostLease({ lockDir, workers: 4 });
    let secondSettled = false;
    const observedOwners: E2eLeaseOwner[] = [];
    const secondPromise = acquireE2eHostLease({
      lockDir,
      workers: 2,
      pollMs: 10,
      waitTimeoutMs: 2_000,
      onWait: (owner) => {
        if (owner) observedOwners.push(owner);
      },
    }).then((lease) => {
      secondSettled = true;
      return lease;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(secondSettled, false);
    assert.equal(observedOwners[0]?.token, first.owner.token);

    await first.release();
    const second = await secondPromise;
    assert.equal(secondSettled, true);
    assert.notEqual(second.owner.token, first.owner.token);
    await second.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dead E2E owner is reclaimed before the next suite starts", async () => {
  const { root, lockDir } = await fixture();
  try {
    await mkdir(lockDir);
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({
        token: "dead-owner",
        pid: 2_147_483_647,
        acquiredAt: "2026-01-01T00:00:00.000Z",
        cwd: "/stale/checkout",
        argv: ["playwright", "test"],
        workers: 4,
      }),
    );

    const lease = await acquireE2eHostLease({
      lockDir,
      workers: 4,
      pollMs: 5,
      waitTimeoutMs: 1_000,
    });
    const current = JSON.parse(await readFile(join(lockDir, "owner.json"), "utf8")) as E2eLeaseOwner;
    assert.equal(current.token, lease.owner.token);
    assert.equal(current.pid, process.pid);
    await lease.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an E2E suite times out with the live owner's identity", async () => {
  const { root, lockDir } = await fixture();
  try {
    const first = await acquireE2eHostLease({ lockDir, workers: 4 });
    await assert.rejects(
      acquireE2eHostLease({
        lockDir,
        workers: 1,
        pollMs: 5,
        waitTimeoutMs: 25,
      }),
      (error: Error) => {
        assert.match(error.message, new RegExp(`held by pid ${process.pid}`));
        assert.match(error.message, new RegExp(first.owner.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
    await first.release();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
