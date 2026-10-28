import type { FullConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { snapshotWebBuild } from "./fixtures/web-build.ts";

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
  let build: ReturnType<typeof snapshotWebBuild>;
  try {
    build = snapshotWebBuild(fileURLToPath(new URL("../dist/web", import.meta.url)));
    process.env.MC_E2E_WEB_SNAPSHOT = build.directory;
  } catch (error) {
    await lease.release();
    throw error;
  }
  return async () => {
    try { build.dispose(); }
    finally {
      delete process.env.MC_E2E_WEB_SNAPSHOT;
      await lease.release();
      console.log(`[e2e] released the host lease (pid ${lease.owner.pid})`);
    }
  };
}
