import type { FullConfig } from "@playwright/test";

import {
  acquireE2eHostLease,
  assertE2eWorkerLimit,
  E2E_MAX_WORKERS,
} from "./host-lease.ts";

export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  assertE2eWorkerLimit(config.workers);
  const lease = await acquireE2eHostLease({
    workers: config.workers,
    onWait: (owner) => {
      if (!owner) {
        console.log("[e2e] waiting for the host lease; owner metadata is not available yet");
        return;
      }
      console.log(
        `[e2e] waiting for the host lease held by pid ${owner.pid} from ${owner.cwd} `
        + `since ${owner.acquiredAt}`,
      );
    },
  });
  console.log(
    `[e2e] acquired the host lease with ${config.workers}/${E2E_MAX_WORKERS} workers `
    + `(pid ${lease.owner.pid})`,
  );
  return async () => {
    await lease.release();
    console.log(`[e2e] released the host lease (pid ${lease.owner.pid})`);
  };
}
