// This fixture daemon can lose its optional disclosure worker while its transcript stays readable.
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import workerThreads from "node:worker_threads";

const NativeWorker = workerThreads.Worker;
workerThreads.Worker = class extends NativeWorker {
  constructor(url, options) {
    if (url instanceof URL && url.pathname.endsWith("/transcript-boundary-worker.mjs") &&
        options?.workerData?.includeEof === false && process.env.MISSION_HOME &&
        existsSync(join(process.env.MISSION_HOME, "pause-spoken-proof"))) {
      throw new Error("Fixture paused the transcript proof worker");
    }
    super(url, options);
  }
};
syncBuiltinESMExports();
