// Only the fixture proof worker loses file access. The daemon still reads the native
// transcript, and stat() sees its real revision in both processes.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import workerThreads from "node:worker_threads";

if (workerThreads.isMainThread) {
  const NativeWorker = workerThreads.Worker;
  workerThreads.Worker = class extends NativeWorker {
    constructor(url, options) {
      const pause = url instanceof URL && url.pathname.endsWith("/transcript-boundary-worker.mjs") &&
        options?.workerData?.includeEof === false && process.env.MISSION_HOME &&
        fs.existsSync(join(process.env.MISSION_HOME, "pause-spoken-proof"));
      super(url, pause ? { ...options, execArgv: ["--import", import.meta.url] } : options);
    }
  };
} else if (workerThreads.workerData?.includeEof === false && process.env.MISSION_HOME &&
    fs.existsSync(join(process.env.MISSION_HOME, "pause-spoken-proof"))) {
  const open = fs.openSync;
  fs.openSync = (path, ...args) => {
    if (path === workerThreads.workerData.path) throw Object.assign(new Error("fixture read failure"), { code: "EIO" });
    return open(path, ...args);
  };
}
syncBuiltinESMExports();
